// Package dependencyops implements the pulsectl dependency command family
// without depending on the root command's configuration or HTTP
// implementation.
package dependencyops

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

// Dependency is one row of GET /api/v1/dependencies: the current
// dashboard-facing state, not the full detail returned by get and add.
type Dependency struct {
	ID                  string  `json:"id"`
	CatalogID           string  `json:"catalogId"`
	ScopeID             *string `json:"scopeId"`
	Name                string  `json:"name"`
	Provider            string  `json:"provider"`
	Category            string  `json:"category,omitempty"`
	State               string  `json:"state"`
	Checking            bool    `json:"checking,omitempty"`
	ProviderUpdatedAt   *string `json:"providerUpdatedAt"`
	ActiveIncidentTitle *string `json:"activeIncidentTitle"`
}

// DependencyDetail is the shape returned by get and by a successful add: the
// full detail view, including active provider incidents and their updates.
type DependencyDetail struct {
	ID                   string               `json:"id"`
	CatalogID            string               `json:"catalogId"`
	ScopeID              *string              `json:"scopeId"`
	Name                 string               `json:"name"`
	Description          string               `json:"description,omitempty"`
	Category             string               `json:"category,omitempty"`
	Provider             string               `json:"provider"`
	ComponentLabel       *string              `json:"componentLabel"`
	SourceScopeNote      *string              `json:"sourceScopeNote"`
	NotificationsEnabled bool                 `json:"notificationsEnabled"`
	State                string               `json:"state"`
	Checking             bool                 `json:"checking"`
	ProviderUpdatedAt    *string              `json:"providerUpdatedAt"`
	LastSuccessfulPollAt *string              `json:"lastSuccessfulPollAt"`
	CanonicalURL         string               `json:"canonicalUrl,omitempty"`
	Incidents            []DependencyIncident `json:"incidents,omitempty"`
}

type DependencyIncident struct {
	ID                string                     `json:"id"`
	Title             string                     `json:"title"`
	State             string                     `json:"state"`
	StartedAt         string                     `json:"startedAt,omitempty"`
	ResolvedAt        *string                    `json:"resolvedAt"`
	ProviderUpdatedAt string                     `json:"providerUpdatedAt,omitempty"`
	CanonicalURL      *string                    `json:"canonicalUrl"`
	Updates           []DependencyIncidentUpdate `json:"updates,omitempty"`
}

type DependencyIncidentUpdate struct {
	State     string `json:"state"`
	BodyText  string `json:"bodyText"`
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// CatalogScope describes a preset's scope requirement. A required_options
// preset always needs a scope. discovered_children and discovered_locations
// carry their own required flag.
type CatalogScope struct {
	Kind     string `json:"kind"`
	Required bool   `json:"required,omitempty"`
}

// CatalogPreset is one preset within a catalog category. Category is filled
// in by flattenCatalog since the wire shape nests presets under it.
type CatalogPreset struct {
	ID                string        `json:"id"`
	Name              string        `json:"name"`
	Provider          string        `json:"provider"`
	Category          string        `json:"-"`
	Enabled           bool          `json:"enabled"`
	Validated         bool          `json:"validated"`
	Installed         bool          `json:"installed"`
	InstalledScopeIDs []string      `json:"installedScopeIds,omitempty"`
	Scope             *CatalogScope `json:"scope"`
}

type CatalogCategory struct {
	Category string          `json:"category"`
	Presets  []CatalogPreset `json:"presets"`
}

type CatalogData struct {
	Categories []CatalogCategory `json:"categories"`
}

func NewGroup(d Dependencies) *cobra.Command {
	d = defaults(d)
	group := &cobra.Command{Use: "dependency", Short: "Manage third-party dependencies", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	group.AddCommand(newCatalogCommand(d), newListCommand(d), newGetCommand(d), newAddCommand(d), newRemoveCommand(d))
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

func newCatalogCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{Use: "catalog", Short: "List available dependency presets", Args: cobra.NoArgs, Annotations: annotations("dependencies:read"), RunE: func(cmd *cobra.Command, _ []string) error {
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodGet, Path: "/api/v1/dependency-catalog", Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderCatalog(d, d.Format(), doc)
	}}
}

func newListCommand(d Dependencies) *cobra.Command {
	var limit int
	var cursor string
	var all bool
	cmd := &cobra.Command{Use: "list", Short: "List installed dependencies", Args: cobra.NoArgs, Annotations: annotations("dependencies:read"), RunE: func(cmd *cobra.Command, _ []string) error {
		doc, err := List(cmd.Context(), d.Client, limit, cursor, all || machine(d.Format()))
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

func newGetCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{Use: "get <id>", Short: "Get dependency detail", Args: cobra.ExactArgs(1), Annotations: annotations("dependencies:read"), RunE: func(cmd *cobra.Command, args []string) error {
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodGet, Path: dependencyPath(args[0]), Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderDetail(d, d.Format(), doc)
	}}
}

func newAddCommand(d Dependencies) *cobra.Command {
	var scope string
	var noNotifications bool
	cmd := &cobra.Command{Use: "add <presetId>", Short: "Add a dependency", Args: cobra.ExactArgs(1), Annotations: annotations("dependencies:write"), RunE: func(cmd *cobra.Command, args []string) error {
		body := map[string]any{"presetId": args[0]}
		if scope != "" {
			body["scopeId"] = scope
		}
		if noNotifications {
			body["notificationsEnabled"] = false
		}
		key, err := idempotencyKey(d)
		if err != nil {
			return err
		}
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodPost, Path: "/api/v1/dependencies", Body: body, IdempotencyKey: key, Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderDetail(d, d.Format(), doc)
	}}
	cmd.Flags().StringVar(&scope, "scope", "", "Region or component scope for a regional preset")
	cmd.Flags().BoolVar(&noNotifications, "no-notifications", false, "Disable notifications for this dependency")
	return cmd
}

func newRemoveCommand(d Dependencies) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{Use: "remove <id>", Short: "Remove a dependency", Args: cobra.ExactArgs(1), Annotations: annotations("dependencies:write"), RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		if !yes {
			if !d.StdinTTY {
				return invalid("noninteractive removal requires --yes")
			}
			fmt.Fprintf(d.Err, "Remove dependency %s? [y/N] ", id)
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
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodDelete, Path: dependencyPath(id), IdempotencyKey: key}); err != nil {
			return d.MapError(err)
		}
		fmt.Fprintf(d.Err, "Removed dependency %s\n", id)
		return nil
	}}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm removal")
	return cmd
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
		return ListEnvelope{}, invalid("--limit cannot be negative")
	}
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	remaining := limit
	result := ListEnvelope{APIVersion: "v1", Kind: "DependencyList", Data: make([]json.RawMessage, 0)}
	seen := map[string]struct{}{}
	if cursor != "" {
		seen[cursor] = struct{}{}
	}
	totalBytes := 0
	for pages := 0; ; pages++ {
		if pages >= maxListPages {
			return ListEnvelope{}, pageLimit("server returned more dependency pages than the client will follow")
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
		if err := client.Do(ctx, Request{Method: http.MethodGet, Path: "/api/v1/dependencies", Query: cloneValues(q), Result: &page}); err != nil {
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
			return ListEnvelope{}, pageLimit("server returned more dependencies than the client will aggregate")
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

func annotations(scope string) map[string]string {
	return map[string]string{"supportsOutput": "table,json,jsonl,yaml,tsv", "requiredScope": scope}
}

func machine(format string) bool {
	return format == "json" || format == "jsonl" || format == "yaml" || format == "tsv"
}

func dependencyPath(id string) string { return "/api/v1/dependencies/" + url.PathEscape(id) }

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

// flattenCatalog flattens the category-grouped catalog into rows suitable for
// a table, stamping each preset with its parent category.
func flattenCatalog(data CatalogData) []CatalogPreset {
	rows := make([]CatalogPreset, 0)
	for _, category := range data.Categories {
		for _, preset := range category.Presets {
			preset.Category = category.Category
			rows = append(rows, preset)
		}
	}
	return rows
}

// regionRequirement reports "required" when a preset's catalog-defined scope
// always demands a value: a fixed required_options list, or a discovered
// scope explicitly marked required. It is blank for unscoped presets and for
// discovered scopes the preset can install without one.
func regionRequirement(scope *CatalogScope) string {
	if scope == nil {
		return ""
	}
	if scope.Kind == "required_options" || scope.Required {
		return "required"
	}
	return ""
}

func installedMarker(preset CatalogPreset) string {
	if preset.Installed {
		return "yes"
	}
	return ""
}

func renderCatalog(d Dependencies, format string, doc Envelope) error {
	switch format {
	case "json":
		return jsonPretty(d.Out, doc)
	case "jsonl":
		return json.NewEncoder(d.Out).Encode(doc)
	case "yaml":
		return yamlValue(d.Out, doc)
	}
	var data CatalogData
	if err := json.Unmarshal(doc.Data, &data); err != nil {
		_, e := fmt.Fprintln(d.Out, string(doc.Data))
		return e
	}
	rows := flattenCatalog(data)
	if format == "tsv" {
		for _, row := range rows {
			if _, e := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\t%s\t%s\n", output.EscapeTSVField(row.ID), output.EscapeTSVField(row.Name), output.EscapeTSVField(row.Category), output.EscapeTSVField(row.Provider), output.EscapeTSVField(regionRequirement(row.Scope)), output.EscapeTSVField(installedMarker(row))); e != nil {
				return e
			}
		}
		return nil
	}
	fmt.Fprintln(d.Out, "ID\tNAME\tCATEGORY\tPROVIDER\tREGION\tINSTALLED")
	for _, row := range rows {
		fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\t%s\t%s\n", output.SanitizeDisplay(row.ID), output.SanitizeDisplay(row.Name), output.SanitizeDisplay(row.Category), output.SanitizeDisplay(row.Provider), regionRequirement(row.Scope), installedMarker(row))
	}
	return nil
}

// dependencyStateCaption clarifies that STATE reflects the provider's own
// status feed, not an independent Pulse check, per the Provider reported
// labeling rule. It goes to stderr so it never lands in piped table or tsv
// data.
const dependencyStateCaption = "Note: dependency state is provider reported, not a Pulse check."

func renderList(d Dependencies, format string, doc ListEnvelope) error {
	switch format {
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
		fmt.Fprintln(d.Err, dependencyStateCaption)
		for _, raw := range doc.Data {
			var dep Dependency
			if json.Unmarshal(raw, &dep) == nil {
				if _, e := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\t%s\n", output.EscapeTSVField(dep.State), output.EscapeTSVField(dep.Name), output.EscapeTSVField(dep.Provider), output.EscapeTSVField(value(dep.ActiveIncidentTitle)), output.EscapeTSVField(value(dep.ProviderUpdatedAt))); e != nil {
					return e
				}
			}
		}
		return nil
	default:
		fmt.Fprintln(d.Err, dependencyStateCaption)
		fmt.Fprintln(d.Out, "STATE\tNAME\tPROVIDER\tINCIDENT\tUPDATED")
		for _, raw := range doc.Data {
			var dep Dependency
			if json.Unmarshal(raw, &dep) == nil {
				fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\t%s\n", output.SanitizeDisplay(dep.State), output.SanitizeDisplay(dep.Name), output.SanitizeDisplay(dep.Provider), output.SanitizeDisplay(value(dep.ActiveIncidentTitle)), output.SanitizeDisplay(value(dep.ProviderUpdatedAt)))
			}
		}
		if doc.Meta.NextCursor != nil && *doc.Meta.NextCursor != "" {
			fmt.Fprintf(d.Err, "More dependencies available. Continue with --cursor %s\n", *doc.Meta.NextCursor)
		}
		return nil
	}
}

// Detail rendering trims what a human sees: only active (unresolved) provider
// incidents, and only the most recent updates on each, since a long-running
// incident can accumulate a large update history.
const (
	maxDetailUpdates   = 3
	maxDetailBodyRunes = 240
)

func renderDetail(d Dependencies, format string, doc Envelope) error {
	switch format {
	case "json":
		return jsonPretty(d.Out, doc)
	case "jsonl":
		return json.NewEncoder(d.Out).Encode(doc)
	case "yaml":
		return yamlValue(d.Out, doc)
	case "tsv":
		var detail DependencyDetail
		if json.Unmarshal(doc.Data, &detail) == nil && detail.ID != "" {
			_, e := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\n", output.EscapeTSVField(detail.ID), output.EscapeTSVField(detail.State), output.EscapeTSVField(detail.Provider), output.EscapeTSVField(detail.Name))
			return e
		}
		_, e := fmt.Fprintln(d.Out, string(doc.Data))
		return e
	default:
		var detail DependencyDetail
		if json.Unmarshal(doc.Data, &detail) == nil && detail.ID != "" {
			renderDetailHuman(d.Out, detail)
			return nil
		}
		_, e := fmt.Fprintln(d.Out, string(doc.Data))
		return e
	}
}

func renderDetailHuman(w io.Writer, detail DependencyDetail) {
	fmt.Fprintf(w, "ID            %s\n", output.SanitizeDisplay(detail.ID))
	fmt.Fprintf(w, "State         %s\n", output.SanitizeDisplay(detail.State))
	fmt.Fprintln(w, "Source        Provider reported")
	fmt.Fprintf(w, "Provider      %s\n", output.SanitizeDisplay(detail.Provider))
	fmt.Fprintf(w, "Component     %s\n", output.SanitizeDisplay(detail.Name))
	fmt.Fprintf(w, "Region        %s\n", output.SanitizeDisplay(value(detail.ComponentLabel)))
	fmt.Fprintf(w, "Notifications %s\n", enabledLabel(detail.NotificationsEnabled))
	fmt.Fprintf(w, "Last poll     %s\n", output.SanitizeDisplay(value(detail.LastSuccessfulPollAt)))
	fmt.Fprintf(w, "Canonical URL %s\n", output.SanitizeDisplay(detail.CanonicalURL))
	active := activeIncidents(detail.Incidents)
	if len(active) == 0 {
		fmt.Fprintln(w, "Active incidents  none")
		return
	}
	fmt.Fprintln(w, "Active incidents:")
	for _, incident := range active {
		fmt.Fprintf(w, "  %s (%s) started %s\n", output.SanitizeDisplay(incident.Title), output.SanitizeDisplay(incident.State), output.SanitizeDisplay(incident.StartedAt))
		for _, update := range trimUpdates(incident.Updates) {
			fmt.Fprintf(w, "    %s\n", output.SanitizeDisplay(trimBody(update.BodyText)))
		}
	}
}

func activeIncidents(incidents []DependencyIncident) []DependencyIncident {
	active := make([]DependencyIncident, 0, len(incidents))
	for _, incident := range incidents {
		if incident.ResolvedAt == nil {
			active = append(active, incident)
		}
	}
	return active
}

func trimUpdates(updates []DependencyIncidentUpdate) []DependencyIncidentUpdate {
	if len(updates) <= maxDetailUpdates {
		return updates
	}
	return updates[len(updates)-maxDetailUpdates:]
}

func trimBody(body string) string {
	collapsed := strings.Join(strings.Fields(body), " ")
	runes := []rune(collapsed)
	if len(runes) <= maxDetailBodyRunes {
		return collapsed
	}
	return string(runes[:maxDetailBodyRunes]) + "..."
}

func enabledLabel(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
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
