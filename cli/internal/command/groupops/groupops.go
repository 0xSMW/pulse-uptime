// Package groupops implements the pulsectl group command family without
// depending on the root command's configuration or HTTP implementation.
package groupops

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/productos-ai/pulse-uptime/cli/internal/output"
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
	RequestID  string  `json:"requestId,omitempty" yaml:"requestId,omitempty"`
	NextCursor *string `json:"nextCursor" yaml:"nextCursor"`
}

type Envelope struct {
	APIVersion string          `json:"apiVersion" yaml:"apiVersion"`
	Kind       string          `json:"kind" yaml:"kind"`
	Data       json.RawMessage `json:"data" yaml:"-"`
	Meta       Meta            `json:"meta" yaml:"meta"`
}

type ListEnvelope struct {
	APIVersion string            `json:"apiVersion" yaml:"apiVersion"`
	Kind       string            `json:"kind" yaml:"kind"`
	Data       []json.RawMessage `json:"data" yaml:"-"`
	Meta       Meta              `json:"meta" yaml:"meta"`
}

type Group struct {
	ID           string `json:"id" yaml:"id"`
	Name         string `json:"name" yaml:"name"`
	MonitorCount int    `json:"monitorCount,omitempty" yaml:"monitorCount,omitempty"`
	CreatedAt    string `json:"createdAt,omitempty" yaml:"createdAt,omitempty"`
	UpdatedAt    string `json:"updatedAt,omitempty" yaml:"updatedAt,omitempty"`
}

type ListOptions struct {
	Limit   int
	Cursor  string
	All     bool
	Machine bool
}

func NewGroup(d Dependencies) *cobra.Command {
	d = defaults(d)
	group := &cobra.Command{Use: "group", Short: "Manage monitor groups", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	group.AddCommand(newListCommand(d), newCreateCommand(d), newRenameCommand(d), newDeleteCommand(d))
	return group
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
	return d
}

func newListCommand(d Dependencies) *cobra.Command {
	var o ListOptions
	cmd := &cobra.Command{Use: "list", Short: "List monitor groups", Args: cobra.NoArgs, Annotations: annotations("monitors:read"), RunE: func(cmd *cobra.Command, _ []string) error {
		o.Machine = machine(d.Format())
		doc, err := List(cmd.Context(), d.Client, o)
		if err != nil {
			return d.MapError(err)
		}
		return renderList(d, d.Format(), doc)
	}}
	cmd.Flags().IntVar(&o.Limit, "limit", 0, "Maximum records")
	cmd.Flags().StringVar(&o.Cursor, "cursor", "", "Start cursor")
	cmd.Flags().BoolVar(&o.All, "all", false, "Retrieve all records")
	return cmd
}

func newCreateCommand(d Dependencies) *cobra.Command {
	var id, name string
	cmd := &cobra.Command{Use: "create", Short: "Create a monitor group", Args: cobra.NoArgs, Annotations: annotations("monitors:write"), RunE: func(cmd *cobra.Command, _ []string) error {
		if strings.TrimSpace(id) == "" || strings.TrimSpace(name) == "" {
			return invalid("--id and --name are required")
		}
		return mutateAndRender(cmd.Context(), d, http.MethodPost, "/api/v1/groups", map[string]any{"id": id, "name": name})
	}}
	cmd.Flags().StringVar(&id, "id", "", "Stable group ID")
	cmd.Flags().StringVar(&name, "name", "", "Display name")
	_ = cmd.MarkFlagRequired("id")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func newRenameCommand(d Dependencies) *cobra.Command {
	var name string
	cmd := &cobra.Command{Use: "rename <groupId>", Short: "Rename a monitor group", Args: cobra.ExactArgs(1), Annotations: annotations("monitors:write"), RunE: func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(args[0]) == "" || strings.TrimSpace(name) == "" {
			return invalid("exact group ID and --name are required")
		}
		return mutateAndRender(cmd.Context(), d, http.MethodPatch, groupPath(args[0]), map[string]any{"name": name})
	}}
	cmd.Flags().StringVar(&name, "name", "", "New display name")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func newDeleteCommand(d Dependencies) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{Use: "delete <groupId>", Short: "Delete an empty monitor group", Args: cobra.ExactArgs(1), Annotations: annotations("monitors:write"), RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		if strings.TrimSpace(id) == "" {
			return invalid("exact group ID is required")
		}
		if !yes {
			if !d.StdinTTY {
				return invalid("noninteractive deletion requires --yes")
			}
			fmt.Fprintf(d.Err, "Delete empty group %s? [y/N] ", id)
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
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodDelete, Path: groupPath(id), IdempotencyKey: key, Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderEnvelope(d, d.Format(), doc)
	}}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm deletion")
	return cmd
}

// Hostile-server pagination bounds mirror the other list commands so a
// malicious server cannot drive an unbounded request loop or memory growth.
const (
	maxListPages   = 1000
	maxListRecords = 100_000
	maxListBytes   = 64 << 20
)

func List(ctx context.Context, client Client, o ListOptions) (ListEnvelope, error) {
	if o.Limit < 0 {
		return ListEnvelope{}, invalid("--limit cannot be negative")
	}
	query := url.Values{}
	if o.Cursor != "" {
		query.Set("cursor", o.Cursor)
	}
	remaining := o.Limit
	auto := o.Machine || o.All
	result := ListEnvelope{APIVersion: "v1", Kind: "GroupList", Data: make([]json.RawMessage, 0)}
	seen := map[string]struct{}{}
	if o.Cursor != "" {
		seen[o.Cursor] = struct{}{}
	}
	totalBytes := 0
	for pages := 0; ; pages++ {
		if pages >= maxListPages {
			return ListEnvelope{}, pageLimit("server returned more group pages than the client will follow")
		}
		if remaining > 0 {
			pageSize := remaining
			if pageSize > 100 {
				pageSize = 100
			}
			query.Set("limit", strconv.Itoa(pageSize))
		}
		var page ListEnvelope
		if err := client.Do(ctx, Request{Method: http.MethodGet, Path: "/api/v1/groups", Query: cloneValues(query), Result: &page}); err != nil {
			return ListEnvelope{}, err
		}
		accepted := page.Data
		if remaining > 0 && len(accepted) > remaining {
			accepted = accepted[:remaining]
		}
		for _, raw := range accepted {
			totalBytes += len(raw)
		}
		if totalBytes > maxListBytes {
			return ListEnvelope{}, pageLimit("server exceeded the maximum aggregate response size")
		}
		result.Data = append(result.Data, accepted...)
		if len(result.Data) > maxListRecords {
			return ListEnvelope{}, pageLimit("server returned more groups than the client will aggregate")
		}
		result.Meta = page.Meta
		if page.APIVersion != "" {
			result.APIVersion = page.APIVersion
		}
		if page.Kind != "" {
			result.Kind = page.Kind
		}
		if remaining > 0 {
			remaining -= len(accepted)
			if remaining <= 0 {
				break
			}
		}
		if !auto || page.Meta.NextCursor == nil || *page.Meta.NextCursor == "" {
			break
		}
		next := *page.Meta.NextCursor
		if _, ok := seen[next]; ok {
			return ListEnvelope{}, pageLimit("server returned a repeating pagination cursor")
		}
		seen[next] = struct{}{}
		query.Set("cursor", next)
	}
	return result, nil
}

func pageLimit(message string) error {
	return &Error{Exit: 4, Code: "PAGINATION_LIMIT", Message: message}
}

func mutateAndRender(ctx context.Context, d Dependencies, method, path string, body any) error {
	key, err := idempotencyKey(d)
	if err != nil {
		return err
	}
	var doc Envelope
	if err := d.Client.Do(ctx, Request{Method: method, Path: path, Body: body, IdempotencyKey: key, Result: &doc}); err != nil {
		return d.MapError(err)
	}
	return renderEnvelope(d, d.Format(), doc)
}

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

func renderEnvelope(d Dependencies, format string, doc Envelope) error {
	switch format {
	case "json":
		return jsonPretty(d.Out, doc)
	case "jsonl":
		return json.NewEncoder(d.Out).Encode(doc)
	case "yaml":
		return yamlValue(d.Out, doc)
	case "tsv":
		var group Group
		if json.Unmarshal(doc.Data, &group) == nil && group.ID != "" {
			_, err := fmt.Fprintf(d.Out, "%s\t%s\t%d\n", output.EscapeTSVField(group.ID), output.EscapeTSVField(group.Name), group.MonitorCount)
			return err
		}
		_, err := fmt.Fprintln(d.Out, string(doc.Data))
		return err
	default:
		var group Group
		if json.Unmarshal(doc.Data, &group) == nil && group.ID != "" {
			_, err := fmt.Fprintf(d.Out, "ID        %s\nName      %s\nMonitors  %d\n", output.SanitizeDisplay(group.ID), output.SanitizeDisplay(group.Name), group.MonitorCount)
			return err
		}
		_, err := fmt.Fprintln(d.Out, string(doc.Data))
		return err
	}
}

func renderList(d Dependencies, format string, doc ListEnvelope) error {
	switch format {
	case "json":
		return jsonPretty(d.Out, doc)
	case "jsonl":
		for _, raw := range doc.Data {
			if _, err := fmt.Fprintln(d.Out, string(raw)); err != nil {
				return err
			}
		}
		return nil
	case "yaml":
		return yamlValue(d.Out, doc)
	case "tsv":
		for _, raw := range doc.Data {
			var group Group
			if json.Unmarshal(raw, &group) == nil {
				if _, err := fmt.Fprintf(d.Out, "%s\t%s\t%d\n", output.EscapeTSVField(group.ID), output.EscapeTSVField(group.Name), group.MonitorCount); err != nil {
					return err
				}
			}
		}
		return nil
	default:
		fmt.Fprintln(d.Out, "ID\tNAME\tMONITORS")
		for _, raw := range doc.Data {
			var group Group
			if json.Unmarshal(raw, &group) == nil {
				fmt.Fprintf(d.Out, "%s\t%s\t%d\n", output.SanitizeDisplay(group.ID), output.SanitizeDisplay(group.Name), group.MonitorCount)
			}
		}
		if doc.Meta.NextCursor != nil && *doc.Meta.NextCursor != "" {
			fmt.Fprintf(d.Err, "More groups available. Continue with --cursor %s\n", *doc.Meta.NextCursor)
		}
		return nil
	}
}

func annotations(scope string) map[string]string {
	return map[string]string{"supportsOutput": "table,json,jsonl,yaml,tsv", "requiredScope": scope}
}

func machine(format string) bool {
	return format == "json" || format == "jsonl" || format == "yaml" || format == "tsv"
}

func groupPath(id string) string { return "/api/v1/groups/" + url.PathEscape(id) }

func cloneValues(in url.Values) url.Values {
	out := url.Values{}
	for key, values := range in {
		out[key] = append([]string(nil), values...)
	}
	return out
}

func invalid(message string) error {
	return &Error{Exit: 2, Code: "INVALID_ARGUMENT", Message: message}
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
