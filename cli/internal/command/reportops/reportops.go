// Package reportops implements the pulsectl report command family and the
// incident promote subcommand without depending on the root command's
// configuration or HTTP implementation.
package reportops

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
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
	ReadFile func(string) ([]byte, error)
	MapError func(error) error
}

// Error is a command-level failure the root may translate to its own error.
type Error struct {
	Exit    int
	Code    string
	Message string
}

func (e *Error) Error() string     { return e.Message }
func (e *Error) ExitCode() int     { return e.Exit }
func (e *Error) ErrorCode() string { return e.Code }
func (e *Error) ErrorDetails() any { return nil }

// Meta is the object-envelope meta shape: it never carries pagination, so
// nextCursor is omitted entirely instead of being emitted as null.
type Meta struct {
	RequestID  string  `json:"requestId,omitempty" yaml:"requestId,omitempty"`
	NextCursor *string `json:"nextCursor,omitempty" yaml:"nextCursor,omitempty"`
}

// ListMeta is the list-envelope meta shape, which always emits nextCursor
// (null when there are no further pages).
type ListMeta struct {
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
	Meta       ListMeta          `json:"meta" yaml:"meta"`
}

type Report struct {
	ID               string         `json:"id" yaml:"id"`
	Type             string         `json:"type" yaml:"type"`
	Title            string         `json:"title" yaml:"title"`
	StartsAt         string         `json:"startsAt" yaml:"startsAt"`
	EndsAt           *string        `json:"endsAt" yaml:"endsAt"`
	PublishedAt      *string        `json:"publishedAt" yaml:"publishedAt"`
	ResolvedAt       *string        `json:"resolvedAt" yaml:"resolvedAt"`
	OriginIncidentID *string        `json:"originIncidentId" yaml:"originIncidentId"`
	CurrentStatus    string         `json:"currentStatus" yaml:"currentStatus"`
	Updates          []ReportUpdate `json:"updates" yaml:"updates"`
	Affected         []Affected     `json:"affected" yaml:"affected"`
	CreatedAt        string         `json:"createdAt,omitempty" yaml:"createdAt,omitempty"`
	UpdatedAt        string         `json:"updatedAt,omitempty" yaml:"updatedAt,omitempty"`
}

type ReportUpdate struct {
	ID          string `json:"id" yaml:"id"`
	Status      string `json:"status" yaml:"status"`
	Markdown    string `json:"markdown" yaml:"markdown"`
	PublishedAt string `json:"publishedAt" yaml:"publishedAt"`
}

type Affected struct {
	MonitorID   string  `json:"monitorId" yaml:"monitorId"`
	MonitorName string  `json:"monitorName" yaml:"monitorName"`
	GroupName   *string `json:"groupName" yaml:"groupName"`
	Impact      string  `json:"impact" yaml:"impact"`
}

type ListOptions struct {
	State, Type string
	Limit       int
	Cursor      string
	All         bool
	Machine     bool
}

const reportsPath = "/api/v1/status-reports"

var incidentStatuses = []string{"investigating", "identified", "monitoring", "resolved"}
var maintenanceStatuses = []string{"scheduled", "in_progress", "completed"}
var impacts = []string{"down", "degraded", "maintenance"}

// NewGroup returns the pulsectl report command family.
func NewGroup(d Dependencies) *cobra.Command {
	d = defaults(d)
	group := &cobra.Command{
		Use:   "report",
		Short: "Manage status page reports",
		Long: "Author, publish, and maintain incident and maintenance reports shown on the\n" +
			"public status page. Reports start as drafts or publish on creation, carry a\n" +
			"timeline of updates, and list the monitors they affect.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	group.AddCommand(newListCommand(d), newGetCommand(d), newCreateCommand(d), newUpdateCommand(d), newPostCommand(d), newEditUpdateCommand(d), newDeleteCommand(d), newResolveCommand(d), newPublishCommand(d))
	return group
}

// NewPromoteCommand returns the incident promote subcommand, registered under
// the existing incident command group by the root.
func NewPromoteCommand(d Dependencies) *cobra.Command {
	d = defaults(d)
	cmd := &cobra.Command{
		Use:         "promote <incident-id>",
		Short:       "Promote an incident to a draft status report",
		Long:        "Create a draft status report from an automatically detected incident. The\ndraft prefills the title, window, and affected monitor; it never publishes\nautomatically. Promoting the same incident twice returns the existing report.",
		Args:        cobra.ExactArgs(1),
		Annotations: annotations("reports:write"),
		Example:     "pulsectl incident promote inc_123",
		RunE: func(cmd *cobra.Command, args []string) error {
			return mutateAndRender(cmd.Context(), d, http.MethodPost, "/api/v1/incidents/"+url.PathEscape(args[0])+"/promote", nil)
		},
	}
	return cmd
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
	if d.ReadFile == nil {
		d.ReadFile = os.ReadFile
	}
	if d.MapError == nil {
		d.MapError = func(err error) error { return err }
	}
	return d
}

func newListCommand(d Dependencies) *cobra.Command {
	var o ListOptions
	var asJSON bool
	cmd := &cobra.Command{
		Use:         "list",
		Short:       "List status reports",
		Long:        "List status reports, newest first. Filter drafts, ongoing, or resolved\nreports with --state and incidents or maintenance windows with --type.",
		Args:        cobra.NoArgs,
		Annotations: annotations("reports:read"),
		Example:     "pulsectl report list --state ongoing --type incident",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := oneOf("--state", o.State, "all", "draft", "ongoing", "resolved"); err != nil {
				return err
			}
			if err := oneOf("--type", o.Type, "all", "incident", "maintenance"); err != nil {
				return err
			}
			format := formatOr(d, asJSON)
			o.Machine = machine(format)
			doc, err := List(cmd.Context(), d.Client, o)
			if err != nil {
				return d.MapError(err)
			}
			return renderList(d, format, doc)
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.State, "state", "", "Filter by state: all, draft, ongoing, or resolved")
	f.StringVar(&o.Type, "type", "", "Filter by type: all, incident, or maintenance")
	f.IntVar(&o.Limit, "limit", 0, "Maximum records")
	f.StringVar(&o.Cursor, "cursor", "", "Start cursor")
	f.BoolVar(&o.All, "all", false, "Retrieve all records")
	f.BoolVar(&asJSON, "json", false, "Output JSON")
	return cmd
}

func newGetCommand(d Dependencies) *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:         "get <id>",
		Short:       "Show a status report",
		Long:        "Show one status report with its update timeline and affected monitors.",
		Args:        cobra.ExactArgs(1),
		Annotations: annotations("reports:read"),
		Example:     "pulsectl report get rep_123",
		RunE: func(cmd *cobra.Command, args []string) error {
			var doc Envelope
			if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodGet, Path: reportPath(args[0]), Result: &doc}); err != nil {
				return d.MapError(err)
			}
			return renderEnvelope(d, formatOr(d, asJSON), doc)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Output JSON")
	return cmd
}

func newCreateCommand(d Dependencies) *cobra.Command {
	var reportType, title, startsAt, endsAt, status, message, messageFile, publishedAt string
	var affected []string
	var draft bool
	cmd := &cobra.Command{
		Use:         "create",
		Short:       "Create a status report",
		Long:        "Create an incident or maintenance report with its first update. Reports\npublish immediately unless --draft is given. Read the update body from\n--message, or --message-file (use - for stdin).",
		Args:        cobra.NoArgs,
		Annotations: annotationsStdin("reports:write"),
		Example:     "pulsectl report create --type incident --title \"API outage\" --status investigating --message \"We are investigating elevated error rates.\" --affected api-prod:down",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if reportType != "incident" && reportType != "maintenance" {
				return invalid("--type must be incident or maintenance")
			}
			if strings.TrimSpace(title) == "" {
				return invalid("--title is required")
			}
			if err := validStatus(reportType, status); err != nil {
				return err
			}
			markdown, err := readMessage(d, message, messageFile, cmd.Flags().Changed("message"), cmd.Flags().Changed("message-file"), true)
			if err != nil {
				return err
			}
			update := map[string]any{"status": status, "markdown": markdown}
			if cmd.Flags().Changed("published-at") {
				if update["publishedAt"], err = rfc3339("--published-at", publishedAt); err != nil {
					return err
				}
			}
			body := map[string]any{"type": reportType, "title": title, "update": update}
			if cmd.Flags().Changed("starts-at") {
				if body["startsAt"], err = rfc3339("--starts-at", startsAt); err != nil {
					return err
				}
			}
			if cmd.Flags().Changed("ends-at") {
				if body["endsAt"], err = rfc3339("--ends-at", endsAt); err != nil {
					return err
				}
			}
			if len(affected) > 0 {
				parsed, parseErr := parseAffected(affected)
				if parseErr != nil {
					return parseErr
				}
				body["affected"] = parsed
			}
			if draft {
				body["draft"] = true
			}
			return mutateAndRender(cmd.Context(), d, http.MethodPost, reportsPath, body)
		},
	}
	f := cmd.Flags()
	f.StringVar(&reportType, "type", "", "Report type: incident or maintenance")
	f.StringVar(&title, "title", "", "Report title")
	f.StringArrayVar(&affected, "affected", nil, "Affected monitor as <monitor-id>:<impact>; repeatable")
	f.StringVar(&startsAt, "starts-at", "", "Start time (RFC 3339)")
	f.StringVar(&endsAt, "ends-at", "", "End of a maintenance window (RFC 3339)")
	f.StringVar(&status, "status", "", "First update status")
	f.StringVar(&message, "message", "", "First update body (markdown)")
	f.StringVar(&messageFile, "message-file", "", "Read the update body from a file or - for stdin")
	f.StringVar(&publishedAt, "published-at", "", "First update timestamp (RFC 3339); defaults to now")
	f.BoolVar(&draft, "draft", false, "Save as a draft instead of publishing")
	_ = cmd.MarkFlagRequired("type")
	_ = cmd.MarkFlagRequired("title")
	_ = cmd.MarkFlagRequired("status")
	return cmd
}

func newUpdateCommand(d Dependencies) *cobra.Command {
	var title, startsAt, endsAt string
	var affected []string
	cmd := &cobra.Command{
		Use:         "update <id>",
		Short:       "Edit a status report",
		Long:        "Edit a report's title, window, or affected monitors. --affected replaces\nthe full affected set. Use report post to add timeline updates.",
		Args:        cobra.ExactArgs(1),
		Annotations: annotations("reports:write"),
		Example:     "pulsectl report update rep_123 --title \"API outage (US)\"",
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			var err error
			if cmd.Flags().Changed("title") {
				if strings.TrimSpace(title) == "" {
					return invalid("--title cannot be empty")
				}
				body["title"] = title
			}
			if cmd.Flags().Changed("starts-at") {
				if body["startsAt"], err = rfc3339("--starts-at", startsAt); err != nil {
					return err
				}
			}
			if cmd.Flags().Changed("ends-at") {
				if endsAt == "" {
					body["endsAt"] = nil
				} else if body["endsAt"], err = rfc3339("--ends-at", endsAt); err != nil {
					return err
				}
			}
			if cmd.Flags().Changed("affected") {
				parsed, parseErr := parseAffected(affected)
				if parseErr != nil {
					return parseErr
				}
				body["affected"] = parsed
			}
			if len(body) == 0 {
				return invalid("at least one update flag is required")
			}
			return mutateAndRender(cmd.Context(), d, http.MethodPatch, reportPath(args[0]), body)
		},
	}
	f := cmd.Flags()
	f.StringVar(&title, "title", "", "Report title")
	f.StringArrayVar(&affected, "affected", nil, "Affected monitor as <monitor-id>:<impact>; replaces the set (use none to clear it)")
	f.StringVar(&startsAt, "starts-at", "", "Start time (RFC 3339)")
	f.StringVar(&endsAt, "ends-at", "", "End of a maintenance window (RFC 3339); pass an empty value to clear it")
	return cmd
}

func newPostCommand(d Dependencies) *cobra.Command {
	var status, message, messageFile, publishedAt string
	cmd := &cobra.Command{
		Use:         "post <id>",
		Short:       "Post a report update",
		Long:        "Append an update to a report's timeline. Incident statuses: investigating,\nidentified, monitoring, resolved. Maintenance statuses: scheduled,\nin_progress, completed. Read the body from --message or --message-file\n(use - for stdin).",
		Args:        cobra.ExactArgs(1),
		Annotations: annotationsStdin("reports:write"),
		Example:     "pulsectl report post rep_123 --status monitoring --message \"A fix is deployed; watching recovery.\"",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := anyStatus(status); err != nil {
				return err
			}
			markdown, err := readMessage(d, message, messageFile, cmd.Flags().Changed("message"), cmd.Flags().Changed("message-file"), true)
			if err != nil {
				return err
			}
			body := map[string]any{"status": status, "markdown": markdown}
			if cmd.Flags().Changed("published-at") {
				if body["publishedAt"], err = rfc3339("--published-at", publishedAt); err != nil {
					return err
				}
			}
			return mutateAndRender(cmd.Context(), d, http.MethodPost, reportPath(args[0])+"/updates", body)
		},
	}
	f := cmd.Flags()
	f.StringVar(&status, "status", "", "Update status")
	f.StringVar(&message, "message", "", "Update body (markdown)")
	f.StringVar(&messageFile, "message-file", "", "Read the update body from a file or - for stdin")
	f.StringVar(&publishedAt, "published-at", "", "Update timestamp (RFC 3339); defaults to now")
	_ = cmd.MarkFlagRequired("status")
	return cmd
}

func newEditUpdateCommand(d Dependencies) *cobra.Command {
	var status, message, messageFile, publishedAt string
	cmd := &cobra.Command{
		Use:         "edit-update <id> <update-id>",
		Short:       "Edit a report update",
		Long:        "Edit or backdate an existing timeline update. Changing timestamps or\nstatuses recomputes the report's ongoing/resolved state on the server.",
		Args:        cobra.ExactArgs(2),
		Annotations: annotationsStdin("reports:write"),
		Example:     "pulsectl report edit-update rep_123 upd_456 --published-at 2026-07-18T03:00:00Z",
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("status") {
				if err := anyStatus(status); err != nil {
					return err
				}
				body["status"] = status
			}
			if cmd.Flags().Changed("message") || cmd.Flags().Changed("message-file") {
				markdown, err := readMessage(d, message, messageFile, cmd.Flags().Changed("message"), cmd.Flags().Changed("message-file"), true)
				if err != nil {
					return err
				}
				body["markdown"] = markdown
			}
			if cmd.Flags().Changed("published-at") {
				value, err := rfc3339("--published-at", publishedAt)
				if err != nil {
					return err
				}
				body["publishedAt"] = value
			}
			if len(body) == 0 {
				return invalid("at least one edit flag is required")
			}
			return mutateAndRender(cmd.Context(), d, http.MethodPatch, reportPath(args[0])+"/updates/"+url.PathEscape(args[1]), body)
		},
	}
	f := cmd.Flags()
	f.StringVar(&status, "status", "", "Update status")
	f.StringVar(&message, "message", "", "Update body (markdown)")
	f.StringVar(&messageFile, "message-file", "", "Read the update body from a file or - for stdin")
	f.StringVar(&publishedAt, "published-at", "", "Update timestamp (RFC 3339)")
	return cmd
}

func newDeleteCommand(d Dependencies) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:         "delete <id>",
		Short:       "Delete a status report",
		Long:        "Delete a report and its updates. Published reports disappear from the\npublic status page. This cannot be undone.",
		Args:        cobra.ExactArgs(1),
		Annotations: annotations("reports:write"),
		Example:     "pulsectl report delete rep_123 --yes",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !yes {
				if !d.StdinTTY {
					return invalid("noninteractive deletion requires --yes")
				}
				fmt.Fprintf(d.Err, "Delete status report %s? [y/N] ", args[0])
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
			if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodDelete, Path: reportPath(args[0]), IdempotencyKey: key, Result: &doc}); err != nil {
				return d.MapError(err)
			}
			if doc.Kind == "" {
				doc = Envelope{APIVersion: "v1", Kind: "StatusReportDeleted", Data: json.RawMessage(fmt.Sprintf(`{"id":%q}`, args[0]))}
			}
			return renderEnvelope(d, d.Format(), doc)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm deletion")
	return cmd
}

func newResolveCommand(d Dependencies) *cobra.Command {
	var message string
	cmd := &cobra.Command{
		Use:         "resolve <id>",
		Short:       "Resolve a status report",
		Long:        "Post the closing update for a report: resolved for incidents, completed for\nmaintenance windows. The report type is read from the service first.",
		Args:        cobra.ExactArgs(1),
		Annotations: annotations("reports:write"),
		Example:     "pulsectl report resolve rep_123 --message \"Error rates returned to normal.\"",
		RunE: func(cmd *cobra.Command, args []string) error {
			var doc Envelope
			if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodGet, Path: reportPath(args[0]), Result: &doc}); err != nil {
				return d.MapError(err)
			}
			var report Report
			if err := json.Unmarshal(doc.Data, &report); err != nil || (report.Type != "incident" && report.Type != "maintenance") {
				return &Error{Exit: ExitUnexpected, Code: "INVALID_RESPONSE", Message: "service returned a report without a valid type"}
			}
			status, markdown := "resolved", "Resolved."
			if report.Type == "maintenance" {
				status, markdown = "completed", "Completed."
			}
			if strings.TrimSpace(message) != "" {
				markdown = message
			}
			return mutateAndRender(cmd.Context(), d, http.MethodPost, reportPath(args[0])+"/updates", map[string]any{"status": status, "markdown": markdown})
		},
	}
	cmd.Flags().StringVar(&message, "message", "", "Closing update body (markdown)")
	return cmd
}

func newPublishCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{
		Use:         "publish <id>",
		Short:       "Publish a draft status report",
		Long:        "Publish a draft report to the public status page. Publishing is one-way; a\npublished report cannot return to draft.",
		Args:        cobra.ExactArgs(1),
		Annotations: annotations("reports:write"),
		Example:     "pulsectl report publish rep_123",
		RunE: func(cmd *cobra.Command, args []string) error {
			return mutateAndRender(cmd.Context(), d, http.MethodPost, reportPath(args[0])+"/publish", nil)
		},
	}
}

// List fetches status reports, following cursors for machine output or --all.
func List(ctx context.Context, client Client, o ListOptions) (ListEnvelope, error) {
	if o.Limit < 0 {
		return ListEnvelope{}, invalid("--limit cannot be negative")
	}
	query := url.Values{}
	if o.State != "" {
		query.Set("state", o.State)
	}
	if o.Type != "" {
		query.Set("type", o.Type)
	}
	if o.Cursor != "" {
		query.Set("cursor", o.Cursor)
	}
	remaining := o.Limit
	auto := o.Machine || o.All
	result := ListEnvelope{APIVersion: "v1", Kind: "StatusReportList", Data: make([]json.RawMessage, 0)}
	for {
		if remaining > 0 {
			pageSize := remaining
			if pageSize > 100 {
				pageSize = 100
			}
			query.Set("limit", strconv.Itoa(pageSize))
		}
		var page ListEnvelope
		if err := client.Do(ctx, Request{Method: http.MethodGet, Path: reportsPath, Query: cloneValues(query), Result: &page}); err != nil {
			return ListEnvelope{}, err
		}
		accepted := page.Data
		if remaining > 0 && len(accepted) > remaining {
			accepted = accepted[:remaining]
		}
		result.Data = append(result.Data, accepted...)
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
		query.Set("cursor", *page.Meta.NextCursor)
	}
	return result, nil
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

func readMessage(d Dependencies, message, file string, messageSet, fileSet, required bool) (string, error) {
	if messageSet && fileSet {
		return "", invalid("--message and --message-file cannot be combined")
	}
	if fileSet {
		var data []byte
		var err error
		if file == "-" {
			data, err = io.ReadAll(d.In)
		} else {
			data, err = d.ReadFile(file)
		}
		if err != nil {
			return "", invalid("could not read --message-file: " + err.Error())
		}
		value := strings.TrimRight(string(data), "\n")
		if strings.TrimSpace(value) == "" {
			return "", invalid("--message-file is empty")
		}
		return value, nil
	}
	if messageSet {
		if strings.TrimSpace(message) == "" {
			return "", invalid("--message cannot be empty")
		}
		return message, nil
	}
	if required {
		return "", invalid("--message or --message-file is required")
	}
	return "", nil
}

func parseAffected(values []string) ([]map[string]any, error) {
	if contains(values, "none") {
		if len(values) > 1 {
			return nil, invalid("--affected none cannot be combined with other --affected values")
		}
		return []map[string]any{}, nil
	}
	result := make([]map[string]any, 0, len(values))
	for _, value := range values {
		id, impact, found := strings.Cut(value, ":")
		if !found || strings.TrimSpace(id) == "" || !contains(impacts, impact) {
			return nil, invalid("--affected must be <monitor-id>:<impact> with impact down, degraded, or maintenance")
		}
		result = append(result, map[string]any{"monitorId": id, "impact": impact})
	}
	return result, nil
}

func validStatus(reportType, status string) error {
	allowed := incidentStatuses
	if reportType == "maintenance" {
		allowed = maintenanceStatuses
	}
	if !contains(allowed, status) {
		return invalid("--status must be one of " + strings.Join(allowed, ", ") + " for " + reportType + " reports")
	}
	return nil
}

func anyStatus(status string) error {
	if !contains(incidentStatuses, status) && !contains(maintenanceStatuses, status) {
		return invalid("--status must be one of " + strings.Join(incidentStatuses, ", ") + " (incident) or " + strings.Join(maintenanceStatuses, ", ") + " (maintenance)")
	}
	return nil
}

func rfc3339(flag, value string) (string, error) {
	if _, err := time.Parse(time.RFC3339, value); err != nil {
		return "", invalid(flag + " must be an RFC 3339 timestamp such as 2026-07-18T03:00:00Z")
	}
	return value, nil
}

func oneOf(flag, value string, allowed ...string) error {
	if value == "" || contains(allowed, value) {
		return nil
	}
	return invalid(flag + " must be one of " + strings.Join(allowed, ", "))
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func annotations(scope string) map[string]string {
	return map[string]string{"supportsOutput": "table,json,jsonl,yaml,tsv", "requiredScope": scope}
}

func annotationsStdin(scope string) map[string]string {
	result := annotations(scope)
	result["supportsStdin"] = "true"
	return result
}

func reportPath(id string) string { return reportsPath + "/" + url.PathEscape(id) }

func cloneValues(in url.Values) url.Values {
	out := url.Values{}
	for key, values := range in {
		out[key] = append([]string(nil), values...)
	}
	return out
}

func machine(format string) bool {
	return format == "json" || format == "jsonl" || format == "yaml" || format == "tsv"
}

func formatOr(d Dependencies, asJSON bool) string {
	if asJSON {
		return "json"
	}
	return d.Format()
}

func invalid(message string) error {
	return &Error{Exit: ExitInvalidInput, Code: "INVALID_ARGUMENT", Message: message}
}

const (
	ExitUnexpected   = 1
	ExitInvalidInput = 2
)
