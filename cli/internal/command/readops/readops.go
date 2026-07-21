// Package readops implements incident and public status read commands.
package readops

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

type Request struct {
	Method, Path string
	Query        url.Values
	Result       any
}
type Client interface {
	Do(context.Context, Request) error
}
type Dependencies struct {
	Client   Client
	Out, Err io.Writer
	Format   func() string
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
type Incident struct {
	ID              string  `json:"id"`
	MonitorID       string  `json:"monitorId"`
	MonitorName     string  `json:"monitorName,omitempty"`
	OpenedAt        string  `json:"openedAt"`
	ResolvedAt      *string `json:"resolvedAt"`
	DurationSeconds int64   `json:"durationSeconds,omitempty"`
}

func NewIncidentGroup(d Dependencies) *cobra.Command {
	d = defaults(d)
	g := &cobra.Command{Use: "incident", Short: "Inspect incidents", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error { return c.Help() }}
	g.AddCommand(newList(d), newGet(d))
	return g
}
func NewStatusCommand(d Dependencies) *cobra.Command {
	d = defaults(d)
	return &cobra.Command{Use: "status", Short: "Show public service status", Args: cobra.NoArgs, Annotations: annotations("status:read"), RunE: func(c *cobra.Command, _ []string) error {
		var doc Envelope
		if err := d.Client.Do(c.Context(), Request{Method: http.MethodGet, Path: "/api/v1/status", Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderEnvelope(d, d.Format(), doc)
	}}
}
func defaults(d Dependencies) Dependencies {
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
		d.MapError = func(e error) error { return e }
	}
	return d
}

func newList(d Dependencies) *cobra.Command {
	var limit int
	var cursor string
	var all bool
	cmd := &cobra.Command{Use: "list", Short: "List incidents", Args: cobra.NoArgs, Annotations: annotations("incidents:read"), RunE: func(c *cobra.Command, _ []string) error {
		doc, err := List(c.Context(), d.Client, limit, cursor, all || machine(d.Format()))
		if err != nil {
			return d.MapError(err)
		}
		return renderList(d, d.Format(), doc)
	}}
	cmd.Flags().IntVar(&limit, "limit", 0, "Maximum records")
	cmd.Flags().StringVar(&cursor, "cursor", "", "Start cursor")
	cmd.Flags().BoolVar(&all, "all", false, "Retrieve all records")
	return cmd
}
func newGet(d Dependencies) *cobra.Command {
	return &cobra.Command{Use: "get <id>", Short: "Get an incident", Args: cobra.ExactArgs(1), Annotations: annotations("incidents:read"), RunE: func(c *cobra.Command, args []string) error {
		if strings.TrimSpace(args[0]) == "" {
			return invalid("incident id is required")
		}
		var doc Envelope
		if err := d.Client.Do(c.Context(), Request{Method: http.MethodGet, Path: "/api/v1/incidents/" + url.PathEscape(args[0]), Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderEnvelope(d, d.Format(), doc)
	}}
}

// Hostile-server pagination bounds mirror the other list commands so a
// malicious server cannot drive an unbounded request loop or memory growth.
const (
	maxListPages   = 1000
	maxListRecords = 100_000
	maxListBytes   = 64 << 20
)

func List(ctx context.Context, client Client, limit int, cursor string, auto bool) (ListEnvelope, error) {
	if limit < 0 {
		return ListEnvelope{}, &Error{Exit: 2, Code: "INVALID_ARGUMENT", Message: "--limit cannot be negative"}
	}
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	remaining := limit
	result := ListEnvelope{APIVersion: "v1", Kind: "IncidentList", Data: make([]json.RawMessage, 0)}
	seen := map[string]struct{}{}
	if cursor != "" {
		seen[cursor] = struct{}{}
	}
	totalBytes := 0
	for pages := 0; ; pages++ {
		if pages >= maxListPages {
			return ListEnvelope{}, pageLimit("server returned more incident pages than the client will follow")
		}
		pageSize := 0
		if remaining > 0 {
			pageSize = remaining
			if pageSize > 100 {
				pageSize = 100
			}
		}
		if pageSize > 0 {
			q.Set("limit", strconv.Itoa(pageSize))
		}
		var page ListEnvelope
		if err := client.Do(ctx, Request{Method: http.MethodGet, Path: "/api/v1/incidents", Query: clone(q), Result: &page}); err != nil {
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
			return ListEnvelope{}, pageLimit("server returned more incidents than the client will aggregate")
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
		q.Set("cursor", next)
	}
	return result, nil
}

func pageLimit(message string) error {
	return &Error{Exit: 4, Code: "PAGINATION_LIMIT", Message: message}
}
func annotations(scope string) map[string]string {
	return map[string]string{"supportsOutput": "table,json,jsonl,yaml,tsv", "requiredScope": scope}
}
func machine(f string) bool { return f == "json" || f == "jsonl" || f == "yaml" || f == "tsv" }
func invalid(message string) error {
	return &Error{Exit: 2, Code: "INVALID_ARGUMENT", Message: message}
}
func clone(q url.Values) url.Values {
	out := url.Values{}
	for k, v := range q {
		out[k] = append([]string(nil), v...)
	}
	return out
}

func renderEnvelope(d Dependencies, f string, doc Envelope) error {
	switch f {
	case "json":
		return jsonPretty(d.Out, doc)
	case "jsonl":
		return json.NewEncoder(d.Out).Encode(doc)
	case "yaml":
		return yamlValue(d.Out, doc)
	case "tsv":
		var i Incident
		if json.Unmarshal(doc.Data, &i) == nil && i.ID != "" {
			_, e := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\n", output.EscapeTSVField(i.ID), output.EscapeTSVField(i.MonitorID), output.EscapeTSVField(i.OpenedAt), output.EscapeTSVField(value(i.ResolvedAt)))
			return e
		}
		_, e := fmt.Fprintln(d.Out, string(doc.Data))
		return e
	default:
		var i Incident
		if json.Unmarshal(doc.Data, &i) == nil && i.ID != "" {
			state := "Ongoing"
			if i.ResolvedAt != nil {
				state = "Resolved"
			}
			_, e := fmt.Fprintf(d.Out, "ID       %s\nMonitor  %s\nStatus   %s\nOpened   %s\nResolved %s\n", output.SanitizeDisplay(i.ID), output.SanitizeDisplay(i.MonitorID), state, output.SanitizeDisplay(i.OpenedAt), output.SanitizeDisplay(value(i.ResolvedAt)))
			return e
		}
		_, e := fmt.Fprintln(d.Out, string(doc.Data))
		return e
	}
}
func renderList(d Dependencies, f string, doc ListEnvelope) error {
	switch f {
	case "json":
		return jsonPretty(d.Out, doc)
	case "jsonl":
		for _, raw := range doc.Data {
			if _, e := fmt.Fprintln(d.Out, string(raw)); e != nil {
				return e
			}
		}
		return nil
	case "yaml":
		return yamlValue(d.Out, doc)
	case "tsv":
		for _, raw := range doc.Data {
			var i Incident
			if json.Unmarshal(raw, &i) == nil {
				if _, e := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\n", output.EscapeTSVField(i.ID), output.EscapeTSVField(i.MonitorID), output.EscapeTSVField(i.OpenedAt), output.EscapeTSVField(value(i.ResolvedAt))); e != nil {
					return e
				}
			}
		}
		return nil
	default:
		fmt.Fprintln(d.Out, "ID\tMONITOR\tSTATUS\tOPENED")
		for _, raw := range doc.Data {
			var i Incident
			if json.Unmarshal(raw, &i) == nil {
				state := "ONGOING"
				if i.ResolvedAt != nil {
					state = "RESOLVED"
				}
				fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\n", output.SanitizeDisplay(i.ID), output.SanitizeDisplay(i.MonitorID), state, output.SanitizeDisplay(i.OpenedAt))
			}
		}
		if doc.Meta.NextCursor != nil && *doc.Meta.NextCursor != "" {
			fmt.Fprintf(d.Err, "More incidents available. Continue with --cursor %s\n", *doc.Meta.NextCursor)
		}
		return nil
	}
}
func value(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func jsonPretty(w io.Writer, v any) error {
	e := json.NewEncoder(w)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	return e.Encode(v)
}
func yamlValue(w io.Writer, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	var x any
	if e = json.Unmarshal(b, &x); e != nil {
		return e
	}
	return yaml.NewEncoder(w).Encode(x)
}
