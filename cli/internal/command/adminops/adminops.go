package adminops

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var SupportedScopes = []string{"config:read", "config:write", "dependencies:read", "dependencies:write", "incidents:read", "monitors:read", "monitors:write", "notifications:test", "reports:read", "reports:write", "status:read", "tokens:manage"}

// Hostile-server pagination bounds. A malicious server that returns a repeating
// or non-advancing cursor, or an endless stream of pages, must not drive the
// CLI into an unbounded request loop or memory growth.
const (
	maxListPages   = 1000
	maxListRecords = 100_000
	maxListBytes   = 64 << 20
)

type Transport interface {
	Do(context.Context, string, string, any, http.Header, any) (http.Header, error)
}

type Session struct {
	Authenticated bool     `json:"authenticated" yaml:"authenticated"`
	Source        string   `json:"source,omitempty" yaml:"source,omitempty"`
	Server        string   `json:"server,omitempty" yaml:"server,omitempty"`
	Identity      string   `json:"identity,omitempty" yaml:"identity,omitempty"`
	Scopes        []string `json:"scopes,omitempty" yaml:"scopes,omitempty"`
}

// Sessions deliberately separates local credential removal from server
// revocation. Clear must never persist or alter an environment token.
type Sessions interface {
	Current(context.Context) (Session, error)
	Clear(context.Context) error
}

type Dependencies struct {
	Client       Transport
	Sessions     Sessions
	In           io.Reader
	Out          io.Writer
	Err          io.Writer
	StdinTTY     bool
	Output       func(defaultFormat string) string
	Now          func() time.Time
	LocalVersion string
}

type Error struct {
	Exit          int
	Code, Message string
	Details       any
}

func (e *Error) Error() string     { return e.Message }
func (e *Error) ExitCode() int     { return e.Exit }
func (e *Error) ErrorCode() string { return e.Code }
func (e *Error) ErrorDetails() any { return e.Details }

type Envelope struct {
	APIVersion string         `json:"apiVersion" yaml:"apiVersion"`
	Kind       string         `json:"kind" yaml:"kind"`
	Data       map[string]any `json:"data" yaml:"data"`
}

func NewTokenCommand(d Dependencies) *cobra.Command {
	d = defaults(d)
	cmd := &cobra.Command{Use: "token", Short: "Manage scoped API tokens", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	cmd.AddCommand(tokenCreate(d), tokenList(d), tokenRevoke(d))
	return cmd
}

func NewNotificationCommand(d Dependencies) *cobra.Command {
	d = defaults(d)
	cmd := &cobra.Command{Use: "notification", Short: "Manage notifications", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	var recipient string
	test := &cobra.Command{Use: "test", Short: "Send a test notification", Args: cobra.NoArgs, Annotations: annotations("notifications:test"), RunE: func(cmd *cobra.Command, _ []string) error {
		if d.Client == nil {
			return unavailable()
		}
		body := map[string]any{}
		if recipient != "" {
			if _, err := validateEmail(recipient); err != nil {
				return invalid("recipient must be a valid email address")
			}
			body["recipient"] = recipient
		}
		var result map[string]any
		if _, err := d.Client.Do(cmd.Context(), http.MethodPost, "/api/v1/notifications/test", body, nil, &result); err != nil {
			return err
		}
		return render(d, result, "table")
	}}
	test.Flags().StringVar(&recipient, "recipient", "", "Send to one recipient")
	test.Example = "pulsectl notification test --recipient ops@example.com"
	cmd.AddCommand(test)
	return cmd
}

func NewAuthCommand(d Dependencies) *cobra.Command {
	d = defaults(d)
	cmd := &cobra.Command{Use: "auth", Short: "Manage authentication", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	status := &cobra.Command{Use: "status", Short: "Show authentication status", Args: cobra.NoArgs, Annotations: annotations("authenticated"), RunE: func(cmd *cobra.Command, _ []string) error {
		if d.Sessions == nil {
			return unavailable()
		}
		session, err := d.Sessions.Current(cmd.Context())
		if err != nil {
			return err
		}
		sort.Strings(session.Scopes)
		value := map[string]any{"apiVersion": "v1", "kind": "AuthStatus", "data": session}
		return render(d, value, "table")
	}}
	var yes bool
	logout := &cobra.Command{Use: "logout", Short: "Remove a linked session", Args: cobra.NoArgs, Annotations: annotations("authenticated"), RunE: func(cmd *cobra.Command, _ []string) error {
		if d.Sessions == nil {
			return unavailable()
		}
		session, err := d.Sessions.Current(cmd.Context())
		if err != nil {
			return err
		}
		if !session.Authenticated {
			return render(d, map[string]any{"apiVersion": "v1", "kind": "Logout", "data": map[string]any{"loggedOut": false}}, "table")
		}
		if session.Source == "environment" || session.Source == "stdin" {
			return invalid("temporary tokens cannot be logged out; remove the token from the current invocation")
		}
		if !yes {
			if !d.StdinTTY {
				return invalid("noninteractive logout requires --yes")
			}
			fmt.Fprint(d.Err, "Log out this installation? [y/N] ")
			line, _ := bufio.NewReader(d.In).ReadString('\n')
			if strings.ToLower(strings.TrimSpace(line)) != "y" {
				return invalid("logout canceled")
			}
		}
		if d.Client == nil {
			return unavailable()
		}
		var ignored map[string]any
		if _, err := d.Client.Do(cmd.Context(), http.MethodPost, "/api/v1/cli-auth/revoke", map[string]any{}, nil, &ignored); err != nil {
			return err
		}
		if err := d.Sessions.Clear(cmd.Context()); err != nil {
			return err
		}
		return render(d, map[string]any{"apiVersion": "v1", "kind": "Logout", "data": map[string]any{"loggedOut": true}}, "table")
	}}
	logout.Flags().BoolVar(&yes, "yes", false, "Confirm logout")
	cmd.AddCommand(logout, status)
	return cmd
}

func NewVersionCommand(d Dependencies) *cobra.Command {
	d = defaults(d)
	return &cobra.Command{Use: "version", Short: "Show CLI and API compatibility", Args: cobra.NoArgs, Annotations: map[string]string{"supportsOutput": "table,json,yaml"}, RunE: func(cmd *cobra.Command, _ []string) error {
		data := map[string]any{"cliVersion": d.LocalVersion}
		if d.Client != nil {
			var server map[string]any
			if _, err := d.Client.Do(cmd.Context(), http.MethodGet, "/api/v1/version", nil, nil, &server); err != nil {
				return err
			}
			if serverData, ok := server["data"].(map[string]any); ok {
				for k, v := range serverData {
					data[k] = v
				}
			}
		}
		minimum, _ := data["minimumCliVersion"].(string)
		latest, _ := data["latestCliVersion"].(string)
		data["compatible"] = minimum == "" || CompareVersions(d.LocalVersion, minimum) >= 0
		data["updateAvailable"] = latest != "" && CompareVersions(d.LocalVersion, latest) < 0
		return render(d, map[string]any{"apiVersion": "v1", "kind": "Version", "data": data}, "table")
	}}
}

func tokenCreate(d Dependencies) *cobra.Command {
	var name, expires string
	var scopes []string
	cmd := &cobra.Command{Use: "create", Short: "Create a scoped token", Args: cobra.NoArgs, Annotations: annotations("tokens:manage"), RunE: func(cmd *cobra.Command, _ []string) error {
		if strings.TrimSpace(name) == "" {
			return invalid("--name is required")
		}
		if len(scopes) == 0 {
			return invalid("at least one --scope is required")
		}
		seen := map[string]bool{}
		allowed := scopeSet()
		for _, scope := range scopes {
			if !allowed[scope] {
				return invalid("unsupported scope " + scope)
			}
			if seen[scope] {
				return invalid("duplicate scope " + scope)
			}
			seen[scope] = true
		}
		sort.Strings(scopes)
		duration, err := ParseExpiry(expires)
		if err != nil {
			return err
		}
		if d.Client == nil {
			return unavailable()
		}
		request := map[string]any{"name": name, "scopes": scopes, "expiresAt": d.Now().UTC().Add(duration).Format(time.RFC3339)}
		var result map[string]any
		if _, err := d.Client.Do(cmd.Context(), http.MethodPost, "/api/v1/tokens", request, nil, &result); err != nil {
			return err
		}
		return render(d, result, "table")
	}}
	cmd.Flags().StringVar(&name, "name", "", "Token name")
	cmd.Flags().StringSliceVar(&scopes, "scope", nil, "Granted scope; repeat for multiple scopes")
	cmd.Flags().StringVar(&expires, "expires-in", "90d", "Token lifetime, up to 365d")
	_ = cmd.MarkFlagRequired("name")
	_ = cmd.MarkFlagRequired("scope")
	cmd.Example = "pulsectl token create --name deployment-agent --scope monitors:read --expires-in 90d"
	return cmd
}

func tokenList(d Dependencies) *cobra.Command {
	var cursor string
	var limit int
	var all bool
	cmd := &cobra.Command{Use: "list", Short: "List scoped tokens", Args: cobra.NoArgs, Annotations: annotations("tokens:manage"), RunE: func(cmd *cobra.Command, _ []string) error {
		if d.Client == nil {
			return unavailable()
		}
		var records []json.RawMessage
		next := cursor
		seen := map[string]struct{}{}
		if cursor != "" {
			seen[cursor] = struct{}{}
		}
		totalBytes := 0
		for pages := 0; ; pages++ {
			if pages >= maxListPages {
				return pageLimit("server returned more token pages than the client will follow")
			}
			query := url.Values{}
			if next != "" {
				query.Set("cursor", next)
			}
			if limit > 0 {
				pageSize := limit - len(records)
				if pageSize > 100 {
					pageSize = 100
				}
				query.Set("limit", strconv.Itoa(pageSize))
			}
			path := "/api/v1/tokens"
			if encoded := query.Encode(); encoded != "" {
				path += "?" + encoded
			}
			var page struct {
				APIVersion string            `json:"apiVersion"`
				Kind       string            `json:"kind"`
				Data       []json.RawMessage `json:"data"`
				Meta       struct {
					NextCursor *string `json:"nextCursor"`
					RequestID  string  `json:"requestId"`
				} `json:"meta"`
			}
			if _, err := d.Client.Do(cmd.Context(), http.MethodGet, path, nil, nil, &page); err != nil {
				return err
			}
			accepted := page.Data
			if limit > 0 && len(records)+len(accepted) > limit {
				accepted = accepted[:limit-len(records)]
			}
			for _, raw := range accepted {
				totalBytes += len(raw)
			}
			if totalBytes > maxListBytes {
				return pageLimit("server exceeded the maximum aggregate response size")
			}
			records = append(records, accepted...)
			if len(records) > maxListRecords {
				return pageLimit("server returned more tokens than the client will aggregate")
			}
			if limit > 0 && len(records) >= limit {
				break
			}
			if page.Meta.NextCursor == nil || *page.Meta.NextCursor == "" || (!all && d.Output("table") == "table") {
				break
			}
			next = *page.Meta.NextCursor
			if _, ok := seen[next]; ok {
				return pageLimit("server returned a repeating pagination cursor")
			}
			seen[next] = struct{}{}
		}
		return render(d, map[string]any{"apiVersion": "v1", "kind": "TokenList", "data": records}, "table")
	}}
	cmd.Flags().StringVar(&cursor, "cursor", "", "Begin at a page cursor")
	cmd.Flags().IntVar(&limit, "limit", 0, "Maximum tokens to return")
	cmd.Flags().BoolVar(&all, "all", false, "Retrieve every page for human output")
	return cmd
}

func tokenRevoke(d Dependencies) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{Use: "revoke <token-id>", Short: "Revoke a scoped token", Args: cobra.ExactArgs(1), Annotations: annotations("tokens:manage"), RunE: func(cmd *cobra.Command, args []string) error {
		if !yes {
			if !d.StdinTTY {
				return invalid("noninteractive token revocation requires --yes")
			}
			fmt.Fprintf(d.Err, "Revoke token %s? [y/N] ", args[0])
			line, _ := bufio.NewReader(d.In).ReadString('\n')
			if strings.ToLower(strings.TrimSpace(line)) != "y" {
				return invalid("token revocation canceled")
			}
		}
		if d.Client == nil {
			return unavailable()
		}
		var ignored map[string]any
		if _, err := d.Client.Do(cmd.Context(), http.MethodDelete, "/api/v1/tokens/"+url.PathEscape(args[0]), nil, nil, &ignored); err != nil {
			return err
		}
		return render(d, map[string]any{"apiVersion": "v1", "kind": "TokenRevocation", "data": map[string]any{"id": args[0], "revoked": true}}, "table")
	}}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm token revocation")
	return cmd
}

func defaults(d Dependencies) Dependencies {
	if d.In == nil {
		d.In = os.Stdin
	}
	if d.Out == nil {
		d.Out = os.Stdout
	}
	if d.Err == nil {
		d.Err = os.Stderr
	}
	if d.Output == nil {
		d.Output = func(v string) string { return v }
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.LocalVersion == "" {
		d.LocalVersion = "dev"
	}
	return d
}

func render(d Dependencies, value any, fallback string) error {
	format := d.Output(fallback)
	switch format {
	case "json", "jsonl":
		enc := json.NewEncoder(d.Out)
		if format == "json" {
			enc.SetIndent("", "  ")
		}
		return enc.Encode(value)
	case "yaml":
		return yaml.NewEncoder(d.Out).Encode(value)
	case "table", "tsv", "":
		selected := format
		if selected == "" {
			selected = "table"
		}
		return output.Render(d.Out, selected, value)
	default:
		return invalid("unsupported output format " + format)
	}
}

func ParseExpiry(value string) (time.Duration, error) {
	if strings.HasSuffix(value, "d") {
		days, err := strconv.Atoi(strings.TrimSuffix(value, "d"))
		if err != nil || days < 1 || days > 365 {
			return 0, invalid("--expires-in must be between 1d and 365d")
		}
		return time.Duration(days) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(value)
	if err != nil || d <= 0 || d > 365*24*time.Hour {
		return 0, invalid("--expires-in must be between 1d and 365d")
	}
	return d, nil
}

func CompareVersions(a, b string) int {
	parse := func(v string) []int {
		v = strings.TrimPrefix(v, "v")
		v = strings.SplitN(v, "-", 2)[0]
		parts := strings.Split(v, ".")
		result := make([]int, 3)
		for i := range result {
			if i < len(parts) {
				result[i], _ = strconv.Atoi(parts[i])
			}
		}
		return result
	}
	aa, bb := parse(a), parse(b)
	for i := range aa {
		if aa[i] < bb[i] {
			return -1
		}
		if aa[i] > bb[i] {
			return 1
		}
	}
	return 0
}

func validateEmail(v string) (string, error) {
	parsed, err := url.Parse("mailto:" + v)
	if err != nil || !strings.Contains(v, "@") || parsed.Opaque == "" {
		return "", fmt.Errorf("invalid email")
	}
	return v, nil
}
func scopeSet() map[string]bool {
	out := map[string]bool{}
	for _, v := range SupportedScopes {
		out[v] = true
	}
	return out
}
func annotations(scope string) map[string]string {
	return map[string]string{"requiredScope": scope, "supportsOutput": "table,json,yaml,tsv"}
}
func invalid(message string) error {
	return &Error{Exit: 2, Code: "INVALID_ARGUMENT", Message: message}
}
func pageLimit(message string) error {
	return &Error{Exit: 4, Code: "PAGINATION_LIMIT", Message: message}
}
func unavailable() error {
	return &Error{Exit: 1, Code: "CLIENT_UNAVAILABLE", Message: "required integration is unavailable"}
}
