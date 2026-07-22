// Package userops implements the pulsectl users command family without
// depending on the root command's configuration or HTTP implementation.
package userops

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// Request describes one logical API operation. Implementations must reuse
// IdempotencyKey for every retry of a mutation.
type Request struct {
	Method         string
	Path           string
	Query          url.Values
	Body           any
	IdempotencyKey string
	Result         any
}

type Client interface {
	Do(context.Context, Request) error
}

type IDGenerator func() (string, error)

type Dependencies struct {
	Client   Client
	In       io.Reader
	Out      io.Writer
	Err      io.Writer
	Format   func() string
	StdinTTY bool
	NewID    IDGenerator
	MapError func(error) error
	// ServerURL returns the resolved service origin, or "" when unresolved.
	// Invite links are composed client side from origin plus joinPath.
	ServerURL func() string
}

type Error struct {
	Exit    int
	Code    string
	Message string
}

func (e *Error) Error() string     { return e.Message }
func (e *Error) ExitCode() int     { return e.Exit }
func (e *Error) ErrorCode() string { return e.Code }
func (e *Error) ErrorDetails() any { return nil }

type Meta struct {
	RequestID string `json:"requestId,omitempty" yaml:"requestId,omitempty"`
}

type Envelope struct {
	APIVersion string          `json:"apiVersion" yaml:"apiVersion"`
	Kind       string          `json:"kind" yaml:"kind"`
	Data       json.RawMessage `json:"data" yaml:"-"`
	Meta       Meta            `json:"meta" yaml:"meta"`
}

type TeamUser struct {
	ID         string  `json:"id" yaml:"id"`
	Email      string  `json:"email" yaml:"email"`
	Name       *string `json:"name" yaml:"name"`
	Role       string  `json:"role" yaml:"role"`
	CreatedAt  string  `json:"createdAt" yaml:"createdAt"`
	LastSeenAt *string `json:"lastSeenAt" yaml:"lastSeenAt"`
}

type TeamInvite struct {
	ID        string `json:"id" yaml:"id"`
	Role      string `json:"role" yaml:"role"`
	CreatedBy string `json:"createdBy" yaml:"createdBy"`
	CreatedAt string `json:"createdAt" yaml:"createdAt"`
	ExpiresAt string `json:"expiresAt" yaml:"expiresAt"`
}

type Team struct {
	Users   []TeamUser   `json:"users" yaml:"users"`
	Invites []TeamInvite `json:"invites" yaml:"invites"`
}

type CreatedInvite struct {
	ID        string `json:"id" yaml:"id"`
	Role      string `json:"role" yaml:"role"`
	Token     string `json:"token" yaml:"token"`
	JoinPath  string `json:"joinPath" yaml:"joinPath"`
	URL       string `json:"url,omitempty" yaml:"url,omitempty"`
	CreatedAt string `json:"createdAt" yaml:"createdAt"`
	ExpiresAt string `json:"expiresAt" yaml:"expiresAt"`
}

func NewGroup(d Dependencies) *cobra.Command {
	d = defaults(d)
	users := &cobra.Command{Use: "users", Aliases: []string{"user", "team"}, Short: "Manage users and invites", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	users.AddCommand(newListCommand(d), newInviteCommand(d), newRevokeInviteCommand(d), newRoleCommand(d), newRemoveCommand(d))
	return users
}

func defaults(d Dependencies) Dependencies {
	if d.In == nil {
		d.In = strings.NewReader("")
	}
	if d.Out == nil {
		d.Out = io.Discard
	}
	if d.Err == nil {
		d.Err = io.Discard
	}
	if d.Format == nil {
		d.Format = func() string { return "json" }
	}
	if d.MapError == nil {
		d.MapError = func(err error) error { return err }
	}
	if d.ServerURL == nil {
		d.ServerURL = func() string { return "" }
	}
	return d
}

func newListCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{Use: "list", Aliases: []string{"ls"}, Short: "List users and pending invites", Args: cobra.NoArgs, Annotations: annotations(), RunE: func(cmd *cobra.Command, _ []string) error {
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodGet, Path: "/api/v1/users", Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderTeam(d, d.Format(), doc)
	}}
}

func newInviteCommand(d Dependencies) *cobra.Command {
	var role string
	cmd := &cobra.Command{Use: "invite", Short: "Create a single-use invite link", Long: "Create a single-use invite link with a role attached. The link is shown once and expires in 7 days. Send it to the person yourself.", Args: cobra.NoArgs, Annotations: annotations(), Example: "pulsectl users invite --role viewer", RunE: func(cmd *cobra.Command, _ []string) error {
		role = strings.TrimSpace(role)
		if role != "admin" && role != "viewer" {
			return invalid("--role must be admin or viewer")
		}
		key, err := idempotencyKey(d)
		if err != nil {
			return err
		}
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodPost, Path: "/api/v1/users/invites", Body: map[string]any{"role": role}, IdempotencyKey: key, Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderCreatedInvite(d, d.Format(), doc)
	}}
	cmd.Flags().StringVar(&role, "role", "viewer", "Role for the invited user: admin or viewer")
	return cmd
}

func newRevokeInviteCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{Use: "revoke-invite <inviteId>", Short: "Revoke a pending invite link", Args: cobra.ExactArgs(1), Annotations: annotations(), RunE: func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(args[0]) == "" {
			return invalid("invite id is required")
		}
		key, err := idempotencyKey(d)
		if err != nil {
			return err
		}
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodDelete, Path: invitePath(args[0]), IdempotencyKey: key, Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderEnvelope(d, d.Format(), doc)
	}}
}

func newRoleCommand(d Dependencies) *cobra.Command {
	var role string
	cmd := &cobra.Command{Use: "role <userId>", Short: "Change a user's role", Long: "Change a user's role. Narrowing an admin to viewer also revokes their CLI sessions and API tokens. At least one admin must remain.", Args: cobra.ExactArgs(1), Annotations: annotations(), Example: "pulsectl users role 6f0f… --role viewer", RunE: func(cmd *cobra.Command, args []string) error {
		role = strings.TrimSpace(role)
		if role != "admin" && role != "viewer" {
			return invalid("--role must be admin or viewer")
		}
		if strings.TrimSpace(args[0]) == "" {
			return invalid("user id is required")
		}
		key, err := idempotencyKey(d)
		if err != nil {
			return err
		}
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodPatch, Path: userPath(args[0]), Body: map[string]any{"role": role}, IdempotencyKey: key, Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderEnvelope(d, d.Format(), doc)
	}}
	cmd.Flags().StringVar(&role, "role", "", "New role: admin or viewer")
	_ = cmd.MarkFlagRequired("role")
	return cmd
}

func newRemoveCommand(d Dependencies) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{Use: "remove <userId>", Aliases: []string{"rm", "delete"}, Short: "Remove a user and revoke everything they hold", Args: cobra.ExactArgs(1), Annotations: annotations(), RunE: func(cmd *cobra.Command, args []string) error {
		id := strings.TrimSpace(args[0])
		if id == "" {
			return invalid("user id is required")
		}
		if !yes {
			if !d.StdinTTY {
				return invalid("noninteractive removal requires --yes")
			}
			fmt.Fprintf(d.Err, "Remove user %s and revoke their sessions and tokens? [y/N] ", id)
			line, err := bufio.NewReader(d.In).ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			answer := strings.ToLower(strings.TrimSpace(line))
			if answer != "y" && answer != "yes" {
				fmt.Fprintln(d.Err, "Canceled")
				return nil
			}
		}
		key, err := idempotencyKey(d)
		if err != nil {
			return err
		}
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodDelete, Path: userPath(id), IdempotencyKey: key, Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderEnvelope(d, d.Format(), doc)
	}}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm removal")
	return cmd
}

// composeURL joins the resolved server origin with the invite join path so
// callers, humans and agents alike, receive a link that is ready to send.
func composeURL(d Dependencies, joinPath string) string {
	origin := strings.TrimRight(d.ServerURL(), "/")
	if origin == "" || joinPath == "" {
		return ""
	}
	return origin + joinPath
}

func renderCreatedInvite(d Dependencies, format string, doc Envelope) error {
	var invite CreatedInvite
	if err := json.Unmarshal(doc.Data, &invite); err != nil || invite.JoinPath == "" {
		return renderEnvelope(d, format, doc)
	}
	invite.URL = composeURL(d, invite.JoinPath)
	// Machine formats re-encode the data with the composed url field so an
	// agent can lift the link without knowing the server origin.
	if machine(format) {
		augmented, err := json.Marshal(invite)
		if err != nil {
			return err
		}
		doc.Data = augmented
		return renderEnvelope(d, format, doc)
	}
	link := invite.URL
	if link == "" {
		link = invite.JoinPath
	}
	if _, err := fmt.Fprintf(d.Out, "Role     %s\nExpires  %s\nLink     %s\n", output.SanitizeDisplay(invite.Role), output.SanitizeDisplay(invite.ExpiresAt), output.SanitizeDisplay(link)); err != nil {
		return err
	}
	fmt.Fprintln(d.Err, "The link is single use and shown only once. Send it yourself.")
	return nil
}

func renderTeam(d Dependencies, format string, doc Envelope) error {
	if machine(format) && format != "tsv" {
		return renderEnvelope(d, format, doc)
	}
	var team Team
	if err := json.Unmarshal(doc.Data, &team); err != nil {
		return renderEnvelope(d, format, doc)
	}
	if format == "tsv" {
		// Six columns for both row kinds: kind, id, email, name, role, then
		// lastSeenAt for users and expiresAt for invites.
		for _, user := range team.Users {
			name := ""
			if user.Name != nil {
				name = *user.Name
			}
			lastSeen := ""
			if user.LastSeenAt != nil {
				lastSeen = *user.LastSeenAt
			}
			if _, err := fmt.Fprintf(d.Out, "user\t%s\t%s\t%s\t%s\t%s\n", output.EscapeTSVField(user.ID), output.EscapeTSVField(user.Email), output.EscapeTSVField(name), output.EscapeTSVField(user.Role), output.EscapeTSVField(lastSeen)); err != nil {
				return err
			}
		}
		for _, invite := range team.Invites {
			if _, err := fmt.Fprintf(d.Out, "invite\t%s\t\t\t%s\t%s\n", output.EscapeTSVField(invite.ID), output.EscapeTSVField(invite.Role), output.EscapeTSVField(invite.ExpiresAt)); err != nil {
				return err
			}
		}
		return nil
	}
	rows := make([][]string, 0, len(team.Users))
	for _, user := range team.Users {
		name := ""
		if user.Name != nil {
			name = *user.Name
		}
		lastSeen := "never"
		if user.LastSeenAt != nil {
			lastSeen = *user.LastSeenAt
		}
		rows = append(rows, []string{output.SanitizeDisplay(user.ID), output.SanitizeDisplay(user.Email), output.SanitizeDisplay(name), output.SanitizeDisplay(user.Role), output.SanitizeDisplay(lastSeen)})
	}
	if err := output.Table(d.Out, []string{"ID", "EMAIL", "NAME", "ROLE", "LAST ACTIVE"}, rows); err != nil {
		return err
	}
	if len(team.Invites) > 0 {
		fmt.Fprintln(d.Out)
		inviteRows := make([][]string, 0, len(team.Invites))
		for _, invite := range team.Invites {
			inviteRows = append(inviteRows, []string{output.SanitizeDisplay(invite.ID), output.SanitizeDisplay(invite.Role), output.SanitizeDisplay(invite.ExpiresAt)})
		}
		if err := output.Table(d.Out, []string{"PENDING INVITE", "ROLE", "EXPIRES"}, inviteRows); err != nil {
			return err
		}
	}
	return nil
}

func annotations() map[string]string {
	return map[string]string{"supportsOutput": "table,json,jsonl,yaml,tsv", "requiredScope": "users:manage"}
}

func machine(format string) bool {
	return format == "json" || format == "jsonl" || format == "yaml" || format == "tsv"
}

func userPath(id string) string   { return "/api/v1/users/" + url.PathEscape(id) }
func invitePath(id string) string { return "/api/v1/users/invites/" + url.PathEscape(id) }

func idempotencyKey(d Dependencies) (string, error) {
	if d.NewID == nil {
		return "", errors.New("idempotency key generator is required")
	}
	id, err := d.NewID()
	if err != nil {
		return "", fmt.Errorf("generate idempotency key: %w", err)
	}
	if id == "" {
		return "", errors.New("idempotency key generator returned an empty value")
	}
	return id, nil
}

func invalid(message string) error {
	return &Error{Exit: 2, Code: "INVALID_ARGUMENT", Message: message}
}

func renderEnvelope(d Dependencies, format string, doc Envelope) error {
	switch format {
	case "json":
		return jsonPretty(d.Out, doc)
	case "jsonl":
		return json.NewEncoder(d.Out).Encode(doc)
	case "yaml":
		return yamlValue(d.Out, doc)
	default:
		_, err := fmt.Fprintln(d.Out, string(doc.Data))
		return err
	}
}

func jsonPretty(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func yamlValue(w io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	return yaml.NewEncoder(w).Encode(decoded)
}
