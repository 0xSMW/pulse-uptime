// Package monitorops implements the pulsectl monitor command family without
// depending on the root command's configuration or HTTP implementation.
package monitorops

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

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
	Client      Client
	In          io.Reader
	Out         io.Writer
	Err         io.Writer
	Format      func() string
	WatchFormat func() string
	StdinTTY    bool
	StdoutTTY   bool
	NewID       IDGenerator
	Now         func() time.Time
	Poll        func(context.Context, time.Duration) error
	MapError    func(error) error
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

const (
	ExitInvalidInput = 2
	ExitOperational  = 4
	ExitInterrupted  = 130
)

// Hostile-server pagination bounds. A malicious server that returns a repeating
// or non-advancing cursor, or an endless stream of pages, must not drive the
// CLI into an unbounded request loop or memory growth.
const (
	maxListPages   = 1000
	maxListRecords = 100_000
	maxListBytes   = 64 << 20
)

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

type Monitor struct {
	ID                string         `json:"id" yaml:"id"`
	Name              string         `json:"name" yaml:"name"`
	URL               string         `json:"url" yaml:"url"`
	Enabled           bool           `json:"enabled" yaml:"enabled"`
	GroupID           *string        `json:"groupId" yaml:"groupId"`
	Group             *string        `json:"group" yaml:"group"`
	Method            string         `json:"method" yaml:"method"`
	IntervalMinutes   int            `json:"intervalMinutes" yaml:"intervalMinutes"`
	TimeoutMS         int            `json:"timeoutMs" yaml:"timeoutMs"`
	ExpectedStatus    ExpectedStatus `json:"expectedStatus" yaml:"expectedStatus"`
	FailureThreshold  int            `json:"failureThreshold" yaml:"failureThreshold"`
	RecoveryThreshold int            `json:"recoveryThreshold" yaml:"recoveryThreshold"`
	Recipients        []string       `json:"recipients" yaml:"recipients"`
	State             string         `json:"state" yaml:"state"`
	Uptime            json.Number    `json:"uptime,omitempty" yaml:"uptime,omitempty"`
	CreatedAt         string         `json:"createdAt,omitempty" yaml:"createdAt,omitempty"`
	UpdatedAt         string         `json:"updatedAt,omitempty" yaml:"updatedAt,omitempty"`
}

type ExpectedStatus struct {
	Minimum int `json:"minimum" yaml:"minimum"`
	Maximum int `json:"maximum" yaml:"maximum"`
}

type ListOptions struct {
	State, Group, GroupID, Sort string
	Enabled                     *bool
	Limit                       int
	Cursor                      string
	All                         bool
	Machine                     bool
}

type WatchEvent struct {
	Type       string            `json:"type" yaml:"type"`
	ObservedAt string            `json:"observedAt" yaml:"observedAt"`
	Monitors   []json.RawMessage `json:"monitors,omitempty" yaml:"-"`
	MonitorID  string            `json:"monitorId,omitempty" yaml:"monitorId,omitempty"`
	From       string            `json:"from,omitempty" yaml:"from,omitempty"`
	To         string            `json:"to,omitempty" yaml:"to,omitempty"`
}

func NewGroup(d Dependencies) *cobra.Command {
	d = defaults(d)
	group := &cobra.Command{Use: "monitor", Short: "Manage endpoint monitors", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	group.AddCommand(newListCommand(d), newGetCommand(d), newCreateCommand(d), newUpdateCommand(d), newActionCommand(d, "pause"), newActionCommand(d, "resume"), newArchiveCommand(d), newActionCommand(d, "test"), newWatchCommand(d))
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
	if d.WatchFormat == nil {
		d.WatchFormat = d.Format
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Poll == nil {
		d.Poll = func(ctx context.Context, delay time.Duration) error {
			t := time.NewTimer(delay)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		}
	}
	if d.MapError == nil {
		d.MapError = func(err error) error { return err }
	}
	return d
}

func newListCommand(d Dependencies) *cobra.Command {
	var o ListOptions
	var enabled, disabled bool
	cmd := &cobra.Command{Use: "list", Short: "List monitors", Args: cobra.NoArgs, Annotations: annotations("monitors:read"), RunE: func(cmd *cobra.Command, _ []string) error {
		if cmd.Flags().Changed("group") && cmd.Flags().Changed("group-id") {
			return invalid("--group and --group-id cannot be combined")
		}
		if enabled && disabled {
			return invalid("--enabled and --disabled cannot be combined")
		}
		if enabled {
			value := true
			o.Enabled = &value
		}
		if disabled {
			value := false
			o.Enabled = &value
		}
		o.Machine = machine(d.Format())
		doc, err := List(cmd.Context(), d.Client, o)
		if err != nil {
			return d.MapError(err)
		}
		return renderList(d, d.Format(), doc)
	}}
	f := cmd.Flags()
	f.StringVar(&o.State, "state", "", "Filter by state")
	f.StringVar(&o.Group, "group", "", "Filter by group")
	f.StringVar(&o.GroupID, "group-id", "", "Filter by group ID")
	f.BoolVar(&enabled, "enabled", false, "Show enabled monitors")
	f.BoolVar(&disabled, "disabled", false, "Show disabled monitors")
	f.IntVar(&o.Limit, "limit", 0, "Maximum records")
	f.StringVar(&o.Cursor, "cursor", "", "Start cursor")
	f.StringVar(&o.Sort, "sort", "", "Sort field")
	f.BoolVar(&o.All, "all", false, "Retrieve all records")
	return cmd
}

func newGetCommand(d Dependencies) *cobra.Command {
	var flagID string
	cmd := &cobra.Command{Use: "get [id]", Short: "Get a monitor", Args: cobra.MaximumNArgs(1), Annotations: annotations("monitors:read"), RunE: func(cmd *cobra.Command, args []string) error {
		id, err := exactMonitorID(args, flagID)
		if err != nil {
			return err
		}
		var doc Envelope
		if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodGet, Path: monitorPath(id), Result: &doc}); err != nil {
			return d.MapError(err)
		}
		return renderEnvelope(d, d.Format(), doc)
	}}
	cmd.Flags().StringVar(&flagID, "id", "", "Exact monitor ID")
	return cmd
}

type editFlags struct {
	id, name, targetURL, method, interval, expect, group, groupID string
	timeout                                                       time.Duration
	failure, recovery                                             int
	recipients                                                    []string
	enabled, disabled, clearGroup, clearRecipients                bool
}

type editMode uint8

const (
	createMode editMode = iota
	updateMode
)

func newCreateCommand(d Dependencies) *cobra.Command {
	var f editFlags
	cmd := &cobra.Command{Use: "create", Short: "Create a monitor", Args: cobra.NoArgs, Annotations: annotations("monitors:write"), RunE: func(cmd *cobra.Command, _ []string) error {
		if f.id == "" || f.name == "" || f.targetURL == "" {
			return invalid("--id, --name, and --url are required")
		}
		body, err := editBody(cmd, f, createMode)
		if err != nil {
			return err
		}
		return mutateAndRender(cmd.Context(), d, http.MethodPost, "/api/v1/monitors", body)
	}}
	addEditFlags(cmd, &f, createMode)
	_ = cmd.MarkFlagRequired("id")
	_ = cmd.MarkFlagRequired("name")
	_ = cmd.MarkFlagRequired("url")
	return cmd
}

func newUpdateCommand(d Dependencies) *cobra.Command {
	var f editFlags
	cmd := &cobra.Command{Use: "update <id>", Short: "Update a monitor", Args: cobra.ExactArgs(1), Annotations: annotations("monitors:write"), RunE: func(cmd *cobra.Command, args []string) error {
		id, err := exactMonitorID(args, "")
		if err != nil {
			return err
		}
		body, err := editBody(cmd, f, updateMode)
		if err != nil {
			return err
		}
		if len(body) == 0 {
			return invalid("at least one update flag is required")
		}
		return mutateAndRender(cmd.Context(), d, http.MethodPatch, monitorPath(id), body)
	}}
	addEditFlags(cmd, &f, updateMode)
	return cmd
}

func addEditFlags(cmd *cobra.Command, f *editFlags, mode editMode) {
	flags := cmd.Flags()
	if mode == createMode {
		flags.StringVar(&f.id, "id", "", "Stable monitor ID")
	}
	flags.StringVar(&f.name, "name", "", "Display name")
	flags.StringVar(&f.targetURL, "url", "", "Target URL")
	flags.StringVar(&f.method, "method", "", "HTTP method")
	flags.StringVar(&f.interval, "interval", "", "Check interval")
	flags.DurationVar(&f.timeout, "timeout", 0, "Target request timeout")
	flags.StringVar(&f.expect, "expect", "", "Expected status range")
	flags.IntVar(&f.failure, "failure-threshold", 0, "Failures before opening")
	flags.IntVar(&f.recovery, "recovery-threshold", 0, "Successes before recovery")
	flags.StringVar(&f.group, "group", "", "Monitor group")
	flags.StringVar(&f.groupID, "group-id", "", "Monitor group ID, empty clears the group")
	flags.BoolVar(&f.clearGroup, "clear-group", false, "Clear monitor group")
	flags.StringSliceVar(&f.recipients, "recipient", nil, "Notification recipient")
	flags.BoolVar(&f.clearRecipients, "clear-recipients", false, "Clear notification recipients")
	flags.BoolVar(&f.enabled, "enabled", false, "Enable monitor")
	flags.BoolVar(&f.disabled, "disabled", false, "Disable monitor")
}

func editBody(cmd *cobra.Command, f editFlags, mode editMode) (map[string]any, error) {
	if f.enabled && f.disabled {
		return nil, invalid("--enabled and --disabled cannot be combined")
	}
	groupByName := cmd.Flags().Changed("group")
	groupByID := cmd.Flags().Changed("group-id")
	if groupByName && groupByID {
		return nil, invalid("--group and --group-id cannot be combined")
	}
	if f.clearGroup && (groupByName || groupByID) {
		return nil, invalid("--clear-group cannot be combined with --group or --group-id")
	}
	if f.clearRecipients && cmd.Flags().Changed("recipient") {
		return nil, invalid("--recipient and --clear-recipients cannot be combined")
	}
	body := map[string]any{}
	put := func(flag, key string, value any) {
		if mode == createMode || cmd.Flags().Changed(flag) {
			body[key] = value
		}
	}
	if mode == createMode {
		body["id"] = f.id
	}
	put("name", "name", f.name)
	put("url", "url", f.targetURL)
	if cmd.Flags().Changed("method") {
		method := strings.ToUpper(f.method)
		if method != "GET" && method != "HEAD" {
			return nil, invalid("--method must be GET or HEAD")
		}
		body["method"] = method
	}
	if cmd.Flags().Changed("interval") {
		minutes, err := durationMinutes(f.interval)
		if err != nil {
			return nil, err
		}
		body["intervalMinutes"] = minutes
	}
	if cmd.Flags().Changed("timeout") {
		if f.timeout < time.Second || f.timeout > 15*time.Second {
			return nil, invalid("--timeout must be between 1s and 15s")
		}
		body["timeoutMs"] = f.timeout.Milliseconds()
	}
	if cmd.Flags().Changed("expect") {
		value, err := parseExpected(f.expect)
		if err != nil {
			return nil, err
		}
		body["expectedStatus"] = value
	}
	if cmd.Flags().Changed("failure-threshold") {
		if f.failure < 1 || f.failure > 5 {
			return nil, invalid("--failure-threshold must be between 1 and 5")
		}
		body["failureThreshold"] = f.failure
	}
	if cmd.Flags().Changed("recovery-threshold") {
		if f.recovery < 1 || f.recovery > 5 {
			return nil, invalid("--recovery-threshold must be between 1 and 5")
		}
		body["recoveryThreshold"] = f.recovery
	}
	// An empty --group-id can only mean clear: an empty string is never a valid
	// group id, so it maps to null rather than surfacing a server format error.
	// --clear-group is the discoverable flag, and --group-id "" reaches the same null.
	if f.clearGroup || (groupByID && f.groupID == "") {
		body["groupId"] = nil
	} else if groupByID {
		body["groupId"] = f.groupID
	} else if groupByName {
		body["group"] = f.group
	}
	if f.clearRecipients {
		body["recipients"] = []string{}
	} else if cmd.Flags().Changed("recipient") {
		body["recipients"] = f.recipients
	}
	if f.enabled {
		body["enabled"] = true
	}
	if f.disabled {
		body["enabled"] = false
	}
	return body, nil
}

func newActionCommand(d Dependencies, action string) *cobra.Command {
	summary := map[string]string{"pause": "Pause a monitor", "resume": "Resume a monitor", "test": "Test a monitor target"}[action]
	cmd := &cobra.Command{Use: action + " <id>", Short: summary, Args: cobra.ExactArgs(1), Annotations: annotations("monitors:write"), RunE: func(cmd *cobra.Command, args []string) error {
		id, err := exactMonitorID(args, "")
		if err != nil {
			return err
		}
		key, err := idempotencyKey(d)
		if err != nil {
			return err
		}
		var doc Envelope
		err = d.Client.Do(cmd.Context(), Request{Method: http.MethodPost, Path: monitorPath(id) + "/" + action, IdempotencyKey: key, Result: &doc})
		if err != nil {
			return d.MapError(err)
		}
		var succeeded bool
		if action == "test" {
			var parseErr error
			succeeded, parseErr = testSuccessful(doc.Data)
			if parseErr != nil {
				return parseErr
			}
		}
		if err := renderEnvelope(d, d.Format(), doc); err != nil {
			return err
		}
		if action == "test" && !succeeded {
			return &Error{Exit: ExitOperational, Code: "MONITOR_TEST_FAILED", Message: "monitor target test failed"}
		}
		return nil
	}}
	return cmd
}

func newArchiveCommand(d Dependencies) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:         "archive <id>",
		Short:       "Archive a monitor",
		Args:        cobra.ExactArgs(1),
		Annotations: annotations("monitors:write"),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, err := exactMonitorID(args, "")
			if err != nil {
				return err
			}
			if !yes {
				if !d.StdinTTY {
					return invalid("noninteractive archival requires --yes")
				}
				fmt.Fprintf(d.Err, "Archive monitor %s? [y/N] ", id)
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
			if err := d.Client.Do(cmd.Context(), Request{Method: http.MethodDelete, Path: monitorPath(id), IdempotencyKey: key}); err != nil {
				return d.MapError(err)
			}
			doc := Envelope{APIVersion: "v1", Kind: "MonitorArchived", Data: json.RawMessage(fmt.Sprintf(`{"id":%q}`, id))}
			return renderEnvelope(d, d.Format(), doc)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Confirm archival")
	return cmd
}

func newWatchCommand(d Dependencies) *cobra.Command {
	var state string
	var interval time.Duration
	cmd := &cobra.Command{Use: "watch", Short: "Watch monitor state", Args: cobra.NoArgs, Annotations: map[string]string{"supportsOutput": "table,jsonl", "requiredScope": "monitors:read"}, RunE: func(cmd *cobra.Command, _ []string) error {
		if interval <= 0 {
			return invalid("--interval must be greater than zero")
		}
		if format := d.WatchFormat(); format != "table" && format != "jsonl" {
			return invalid("monitor watch supports table or jsonl output")
		}
		return Watch(cmd.Context(), d, state, interval)
	}}
	cmd.Flags().StringVar(&state, "state", "", "Filter by state")
	cmd.Flags().DurationVar(&interval, "interval", 30*time.Second, "Polling interval")
	return cmd
}

func List(ctx context.Context, client Client, o ListOptions) (ListEnvelope, error) {
	if o.Limit < 0 {
		return ListEnvelope{}, invalid("--limit cannot be negative")
	}
	query := url.Values{}
	set(query, "state", o.State)
	set(query, "group", o.Group)
	set(query, "groupId", o.GroupID)
	set(query, "sort", o.Sort)
	set(query, "cursor", o.Cursor)
	if o.Enabled != nil {
		query.Set("enabled", strconv.FormatBool(*o.Enabled))
	}
	remaining := o.Limit
	auto := o.Machine || o.All
	result := ListEnvelope{APIVersion: "v1", Kind: "MonitorList", Data: make([]json.RawMessage, 0)}
	seen := seenCursors(o.Cursor)
	totalBytes := 0
	for pages := 0; ; pages++ {
		if pages >= maxListPages {
			return ListEnvelope{}, pageLimit("server returned more monitor pages than the client will follow")
		}
		pageSize := 0
		if remaining > 0 {
			pageSize = remaining
			if pageSize > 100 {
				pageSize = 100
			}
		}
		if pageSize > 0 {
			query.Set("limit", strconv.Itoa(pageSize))
		}
		var page ListEnvelope
		if err := client.Do(ctx, Request{Method: http.MethodGet, Path: "/api/v1/monitors", Query: cloneValues(query), Result: &page}); err != nil {
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
			return ListEnvelope{}, pageLimit("server returned more monitors than the client will aggregate")
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
				result.Meta.NextCursor = page.Meta.NextCursor
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

// seenCursors tracks pagination cursors already requested so a server cannot
// keep the CLI looping on a repeated or non-advancing cursor.
func seenCursors(initial string) map[string]struct{} {
	seen := map[string]struct{}{}
	if initial != "" {
		seen[initial] = struct{}{}
	}
	return seen
}

func pageLimit(message string) error {
	return &Error{Exit: ExitOperational, Code: "PAGINATION_LIMIT", Message: message}
}

func Watch(ctx context.Context, d Dependencies, state string, interval time.Duration) error {
	d = defaults(d)
	format := d.WatchFormat()
	previous := map[string]string{}
	for {
		doc, err := List(ctx, d.Client, ListOptions{State: state, All: true, Machine: true})
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return &Error{Exit: ExitInterrupted, Code: "INTERRUPTED", Message: "interrupted"}
			}
			return d.MapError(err)
		}
		now := d.Now().UTC().Format(time.RFC3339)
		event := WatchEvent{Type: "snapshot", ObservedAt: now, Monitors: doc.Data}
		if err := renderWatch(d, format, event); err != nil {
			return err
		}
		current := map[string]string{}
		changes := make([]WatchEvent, 0)
		for _, raw := range doc.Data {
			var m Monitor
			if json.Unmarshal(raw, &m) != nil || m.ID == "" {
				continue
			}
			current[m.ID] = m.State
			if from, ok := previous[m.ID]; ok && from != m.State {
				changes = append(changes, WatchEvent{Type: "state_changed", ObservedAt: now, MonitorID: m.ID, From: from, To: m.State})
			}
		}
		sort.Slice(changes, func(i, j int) bool { return changes[i].MonitorID < changes[j].MonitorID })
		for _, change := range changes {
			if err := renderWatch(d, format, change); err != nil {
				return err
			}
		}
		previous = current
		if err := d.Poll(ctx, interval); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return &Error{Exit: ExitInterrupted, Code: "INTERRUPTED", Message: "interrupted"}
			}
			return err
		}
	}
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
func annotations(scope string) map[string]string {
	return map[string]string{"supportsOutput": "table,json,jsonl,yaml,tsv", "requiredScope": scope}
}
func monitorPath(id string) string { return "/api/v1/monitors/" + url.PathEscape(id) }
func set(q url.Values, key, value string) {
	if value != "" {
		q.Set(key, value)
	}
}
func cloneValues(in url.Values) url.Values {
	out := url.Values{}
	for k, v := range in {
		out[k] = append([]string(nil), v...)
	}
	return out
}
func machine(format string) bool {
	return format == "json" || format == "jsonl" || format == "yaml" || format == "tsv"
}
func invalid(message string) error {
	return &Error{Exit: ExitInvalidInput, Code: "INVALID_ARGUMENT", Message: message}
}

// exactMonitorID selects, trims, and validates the exact monitor ID from either
// a positional argument or --id. Both sources together, or a whitespace-only
// value after trim, is INVALID_ARGUMENT and never reaches the API.
func exactMonitorID(args []string, flag string) (string, error) {
	hasPositional := len(args) == 1
	hasFlag := flag != ""
	if hasPositional && hasFlag {
		return "", invalid("provide the monitor ID as an argument or --id, not both")
	}
	var raw string
	switch {
	case hasFlag:
		raw = flag
	case hasPositional:
		raw = args[0]
	default:
		return "", invalid("exact monitor ID is required")
	}
	id := strings.TrimSpace(raw)
	if id == "" {
		return "", invalid("monitor id is required")
	}
	return id, nil
}
func durationMinutes(value string) (int, error) {
	d, err := time.ParseDuration(value)
	if err != nil || d%time.Minute != 0 {
		return 0, invalid("--interval must be 1m, 5m, 10m, or 15m")
	}
	m := int(d / time.Minute)
	if m != 1 && m != 5 && m != 10 && m != 15 {
		return 0, invalid("--interval must be 1m, 5m, 10m, or 15m")
	}
	return m, nil
}
func parseExpected(value string) (ExpectedStatus, error) {
	parts := strings.Split(value, "-")
	if len(parts) != 2 {
		return ExpectedStatus{}, invalid("--expect must be an inclusive range such as 200-399")
	}
	min, e1 := strconv.Atoi(parts[0])
	max, e2 := strconv.Atoi(parts[1])
	if e1 != nil || e2 != nil || min < 100 || max > 599 || max < min {
		return ExpectedStatus{}, invalid("--expect must be between 100-599 with minimum no greater than maximum")
	}
	return ExpectedStatus{Minimum: min, Maximum: max}, nil
}
func testSuccessful(raw json.RawMessage) (bool, error) {
	var value struct {
		Successful *bool `json:"successful"`
		Success    *bool `json:"success"`
		OK         *bool `json:"ok"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, &Error{Exit: 1, Code: "INVALID_RESPONSE", Message: "monitor test returned invalid JSON"}
	}
	if value.Successful != nil {
		return *value.Successful, nil
	}
	if value.Success != nil {
		return *value.Success, nil
	}
	if value.OK != nil {
		return *value.OK, nil
	}
	return false, &Error{Exit: 1, Code: "INVALID_RESPONSE", Message: "monitor test response is missing an outcome"}
}

func renderEnvelope(d Dependencies, format string, doc Envelope) error {
	switch format {
	case "json":
		return writeJSON(d.Out, doc)
	case "jsonl":
		return json.NewEncoder(d.Out).Encode(doc)
	case "yaml":
		return writeYAML(d.Out, doc)
	case "tsv":
		var m Monitor
		if json.Unmarshal(doc.Data, &m) == nil && m.ID != "" {
			_, e := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\n", output.EscapeTSVField(m.ID), output.EscapeTSVField(m.Name), output.EscapeTSVField(m.State), output.EscapeTSVField(m.URL))
			return e
		}
		_, e := fmt.Fprintln(d.Out, string(doc.Data))
		return e
	default:
		var m Monitor
		if json.Unmarshal(doc.Data, &m) == nil && m.ID != "" {
			_, e := fmt.Fprintf(d.Out, "ID       %s\nName     %s\nState    %s\nURL      %s\n", output.SanitizeDisplay(m.ID), output.SanitizeDisplay(m.Name), output.SanitizeDisplay(m.State), output.SanitizeDisplay(m.URL))
			return e
		}
		_, e := fmt.Fprintln(d.Out, string(doc.Data))
		return e
	}
}
func renderList(d Dependencies, format string, doc ListEnvelope) error {
	switch format {
	case "json":
		return writeJSON(d.Out, doc)
	case "jsonl":
		for _, raw := range doc.Data {
			if _, e := fmt.Fprintln(d.Out, string(raw)); e != nil {
				return e
			}
		}
		return nil
	case "yaml":
		return writeYAML(d.Out, doc)
	case "tsv":
		for _, raw := range doc.Data {
			var m Monitor
			if json.Unmarshal(raw, &m) == nil {
				if _, e := fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\n", output.EscapeTSVField(m.ID), output.EscapeTSVField(m.Name), output.EscapeTSVField(m.State), output.EscapeTSVField(m.URL)); e != nil {
					return e
				}
			}
		}
		return nil
	default:
		fmt.Fprintln(d.Out, "ID\tNAME\tSTATE\tUPTIME")
		for _, raw := range doc.Data {
			var m Monitor
			if json.Unmarshal(raw, &m) == nil {
				uptime := "—"
				if m.Uptime != "" {
					if f, e := strconv.ParseFloat(string(m.Uptime), 64); e == nil {
						// Four decimals per CLI-31: operators must distinguish
						// 99.9900% from 99.9990%. Compact web lists round, human
						// CLI tables do not.
						uptime = fmt.Sprintf("%.4f%%", f)
					}
				}
				fmt.Fprintf(d.Out, "%s\t%s\t%s\t%s\n", output.SanitizeDisplay(m.ID), output.SanitizeDisplay(m.Name), output.SanitizeDisplay(m.State), uptime)
			}
		}
		if doc.Meta.NextCursor != nil && *doc.Meta.NextCursor != "" {
			fmt.Fprintf(d.Err, "More monitors available. Continue with --cursor %s\n", *doc.Meta.NextCursor)
		}
		return nil
	}
}
func renderWatch(d Dependencies, format string, event WatchEvent) error {
	if format == "jsonl" || format == "json" || format == "yaml" || format == "tsv" {
		return json.NewEncoder(d.Out).Encode(event)
	}
	if event.Type == "state_changed" {
		_, e := fmt.Fprintf(d.Out, "%s  %s  %s -> %s\n", event.ObservedAt, event.MonitorID, event.From, event.To)
		return e
	}
	doc := ListEnvelope{APIVersion: "v1", Kind: "MonitorList", Data: event.Monitors}
	return renderList(d, "table", doc)
}
func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
func writeYAML(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	return yaml.NewEncoder(w).Encode(decoded)
}
