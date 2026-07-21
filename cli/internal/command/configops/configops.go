package configops

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

const MaxDocumentBytes = 55 * 1024

// Transport is the small API surface needed by declarative config commands.
// Implementations own authentication, request IDs, idempotency, retries, and
// API error decoding. Response headers are returned so config ETags survive.
type Transport interface {
	Do(context.Context, string, string, any, http.Header, any) (http.Header, error)
}

type Dependencies struct {
	Client   Transport
	In       io.Reader
	Out      io.Writer
	Err      io.Writer
	StdinTTY bool
	Output   func(defaultFormat string) string
	OpenFile func(string) (io.ReadCloser, error)
	Create   func(string, bool) (io.WriteCloser, error)
	Sleep    func(context.Context, time.Duration) error
}

type Error struct {
	Exit    int
	Code    string
	Message string
	Details any
}

func (e *Error) Error() string     { return e.Message }
func (e *Error) ExitCode() int     { return e.Exit }
func (e *Error) ErrorCode() string { return e.Code }
func (e *Error) ErrorDetails() any { return e.Details }

type envelope struct {
	APIVersion string          `json:"apiVersion" yaml:"apiVersion"`
	Kind       string          `json:"kind" yaml:"kind"`
	Data       json.RawMessage `json:"data" yaml:"-"`
	Meta       map[string]any  `json:"meta,omitempty" yaml:"meta,omitempty"`
}

type planEnvelope struct {
	APIVersion string         `json:"apiVersion" yaml:"apiVersion"`
	Kind       string         `json:"kind" yaml:"kind"`
	Data       Plan           `json:"data" yaml:"data"`
	Meta       map[string]any `json:"meta,omitempty" yaml:"meta,omitempty"`
}

type Plan struct {
	BaseConfigHash              string            `json:"baseConfigHash" yaml:"baseConfigHash"`
	TargetConfigHash            string            `json:"targetConfigHash" yaml:"targetConfigHash"`
	PlanHash                    string            `json:"planHash" yaml:"planHash"`
	Diff                        Diff              `json:"diff" yaml:"diff"`
	TripwireApprovalRequired    bool              `json:"tripwireApprovalRequired" yaml:"tripwireApprovalRequired"`
	DestructiveConsentRequired  bool              `json:"destructiveConsentRequired" yaml:"destructiveConsentRequired"`
	DestructiveChange           DestructiveChange `json:"destructiveChange" yaml:"destructiveChange"`
	DestructiveApprovalRequired bool              `json:"destructiveApprovalRequired,omitempty" yaml:"destructiveApprovalRequired,omitempty"`
	AllowDeleteRequired         bool              `json:"allowDeleteRequired,omitempty" yaml:"allowDeleteRequired,omitempty"`
}

type DestructiveChange struct {
	Reasons []DestructiveChangeReason `json:"reasons" yaml:"reasons"`
}

type DestructiveChangeReason struct {
	Type                string  `json:"type" yaml:"type"`
	Group               string  `json:"group,omitempty" yaml:"group,omitempty"`
	RemovedCount        int     `json:"removedCount,omitempty" yaml:"removedCount,omitempty"`
	PreviousActiveCount int     `json:"previousActiveCount,omitempty" yaml:"previousActiveCount,omitempty"`
	Percentage          float64 `json:"percentage,omitempty" yaml:"percentage,omitempty"`
}

type Diff struct {
	SettingsChanged []map[string]any `json:"settingsChanged" yaml:"settingsChanged"`
	GroupCreates    []map[string]any `json:"groupCreates" yaml:"groupCreates"`
	GroupUpdates    []map[string]any `json:"groupUpdates" yaml:"groupUpdates"`
	GroupDeletes    []map[string]any `json:"groupDeletes" yaml:"groupDeletes"`
	Creates         []map[string]any `json:"creates" yaml:"creates"`
	Updates         []map[string]any `json:"updates" yaml:"updates"`
	Pauses          []map[string]any `json:"pauses" yaml:"pauses"`
	Resumes         []map[string]any `json:"resumes" yaml:"resumes"`
	Archives        []map[string]any `json:"archives" yaml:"archives"`
	Unchanged       []map[string]any `json:"unchanged" yaml:"unchanged"`
}

func NewCommand(d Dependencies) *cobra.Command {
	d = defaults(d)
	cmd := &cobra.Command{Use: "config", Short: "Manage declarative configuration", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	cmd.AddCommand(exportCommand(d), validateCommand(d), planCommand(d), applyCommand(d), schemaCommand(d))
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
	if d.OpenFile == nil {
		d.OpenFile = func(path string) (io.ReadCloser, error) { return os.Open(path) }
	}
	if d.Create == nil {
		d.Create = func(path string, force bool) (io.WriteCloser, error) {
			flags := os.O_WRONLY | os.O_CREATE
			if force {
				flags |= os.O_TRUNC
			} else {
				flags |= os.O_EXCL
			}
			return os.OpenFile(path, flags, 0o600)
		}
	}
	if d.Sleep == nil {
		d.Sleep = func(ctx context.Context, wait time.Duration) error {
			t := time.NewTimer(wait)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		}
	}
	return d
}

func exportCommand(d Dependencies) *cobra.Command {
	var file string
	var force bool
	cmd := &cobra.Command{Use: "export", Short: "Export accepted configuration", Args: cobra.NoArgs, Annotations: annotations("config:read", "yaml,json"), RunE: func(cmd *cobra.Command, _ []string) error {
		if err := requireClient(d); err != nil {
			return err
		}
		var result envelope
		if _, err := d.Client.Do(cmd.Context(), http.MethodGet, "/api/v1/config", nil, nil, &result); err != nil {
			return err
		}
		var document any
		if err := json.Unmarshal(result.Data, &document); err != nil {
			return invalid("service returned invalid configuration", err.Error())
		}
		if file != "" {
			w, err := d.Create(file, force)
			if err != nil {
				return invalid("could not create export file", err.Error())
			}
			defer w.Close()
			return yaml.NewEncoder(w).Encode(document)
		}
		return render(d.Out, d.Output("yaml"), result, document)
	}}
	cmd.Flags().StringVar(&file, "file", "", "Write configuration to a file")
	cmd.Flags().BoolVar(&force, "force", false, "Overwrite an existing file")
	cmd.Example = "pulsectl config export --file monitors.yaml"
	return cmd
}

func validateCommand(d Dependencies) *cobra.Command {
	var file string
	cmd := &cobra.Command{Use: "validate", Short: "Validate configuration", Args: cobra.NoArgs, Annotations: annotationsStdin("config:write", "table,json,yaml"), RunE: func(cmd *cobra.Command, _ []string) error {
		doc, err := ReadDocument(d, file)
		if err != nil {
			return err
		}
		if err := requireClient(d); err != nil {
			return err
		}
		var result map[string]any
		if _, err := d.Client.Do(cmd.Context(), http.MethodPost, "/api/v1/config/validate", doc, nil, &result); err != nil {
			return err
		}
		return render(d.Out, d.Output("table"), result, result)
	}}
	cmd.Flags().StringVar(&file, "file", "", "Read configuration from a file or - for stdin")
	_ = cmd.MarkFlagRequired("file")
	cmd.Example = "cat monitors.yaml | pulsectl config validate --file -"
	return cmd
}

func planCommand(d Dependencies) *cobra.Command {
	var file string
	cmd := &cobra.Command{Use: "plan", Short: "Plan configuration changes", Args: cobra.NoArgs, Annotations: annotationsStdin("config:write", "table,json,yaml"), RunE: func(cmd *cobra.Command, _ []string) error {
		doc, err := ReadDocument(d, file)
		if err != nil {
			return err
		}
		plan, err := makePlan(cmd.Context(), d, doc)
		if err != nil {
			return err
		}
		return render(d.Out, d.Output("table"), plan, plan)
	}}
	cmd.Flags().StringVar(&file, "file", "", "Read configuration from a file or - for stdin")
	_ = cmd.MarkFlagRequired("file")
	cmd.Example = "pulsectl config plan --file monitors.yaml"
	return cmd
}

func applyCommand(d Dependencies) *cobra.Command {
	var file string
	var yes, allowDestructiveChanges, allowDelete, wait, noWait bool
	var waitTimeout time.Duration
	cmd := &cobra.Command{Use: "apply", Short: "Apply a configuration plan", Args: cobra.NoArgs, Annotations: annotationsStdin("config:write", "table,json,yaml"), RunE: func(cmd *cobra.Command, _ []string) error {
		if wait && noWait {
			return invalid("--wait and --no-wait cannot be combined", "")
		}
		doc, err := ReadDocument(d, file)
		if err != nil {
			return err
		}
		planned, err := makePlan(cmd.Context(), d, doc)
		if err != nil {
			return err
		}
		archives := len(planned.Data.Diff.Archives)
		requiresConsent := planned.Data.DestructiveConsentRequired ||
			planned.Data.AllowDeleteRequired ||
			planned.Data.TripwireApprovalRequired ||
			planned.Data.DestructiveApprovalRequired ||
			archives > 0
		allowsDestructiveChanges := allowDestructiveChanges || allowDelete
		if requiresConsent && !(allowsDestructiveChanges && yes) {
			if !d.StdinTTY {
				return invalid("destructive apply requires --allow-destructive and --yes in noninteractive mode", "")
			}
			if archives > 0 {
				fmt.Fprintf(d.Err, "Type %d to approve archiving %d monitors: ", archives, archives)
				line, _ := bufio.NewReader(d.In).ReadString('\n')
				if strings.TrimSpace(line) != strconv.Itoa(archives) {
					return invalid("configuration apply canceled", "archive count did not match")
				}
			} else {
				writeDestructiveChangeReasons(d.Err, planned.Data.DestructiveChange.Reasons)
				fmt.Fprint(d.Err, "This plan removes active monitoring coverage. Type yes to approve: ")
				line, _ := bufio.NewReader(d.In).ReadString('\n')
				if strings.ToLower(strings.TrimSpace(line)) != "yes" {
					return invalid("configuration apply canceled", "destructive consent was not given")
				}
			}
			allowDestructiveChanges = true
			yes = true
		} else if d.StdinTTY && !yes {
			fmt.Fprint(d.Err, "Apply this configuration? [y/N] ")
			line, _ := bufio.NewReader(d.In).ReadString('\n')
			if strings.ToLower(strings.TrimSpace(line)) != "y" {
				return invalid("configuration apply canceled", "")
			}
		}
		allowsDestructiveChanges = allowDestructiveChanges || allowDelete
		request := map[string]any{
			"baseConfigHash":          planned.Data.BaseConfigHash,
			"targetConfigHash":        planned.Data.TargetConfigHash,
			"planHash":                planned.Data.PlanHash,
			"targetConfig":            doc,
			"allowDestructiveChanges": allowsDestructiveChanges,
			// Compatibility field for servers on the previous API vocabulary.
			"allowDelete": allowsDestructiveChanges,
		}
		headers := make(http.Header)
		headers.Set("If-Match", strconv.Quote(planned.Data.BaseConfigHash))
		var operation map[string]any
		if _, err := d.Client.Do(cmd.Context(), http.MethodPost, "/api/v1/config/apply", request, headers, &operation); err != nil {
			return err
		}
		if noWait {
			return render(d.Out, d.Output("table"), operation, operation)
		}
		shouldWait := wait || !noWait
		if shouldWait {
			operation, err = waitForOperation(cmd.Context(), d, operation, waitTimeout)
			if err != nil {
				return err
			}
		}
		return render(d.Out, d.Output("table"), operation, operation)
	}}
	cmd.Flags().StringVar(&file, "file", "", "Read configuration from a file or - for stdin")
	cmd.Flags().BoolVar(&yes, "yes", false, "Approve the planned changes")
	cmd.Flags().BoolVar(&allowDestructiveChanges, "allow-destructive", false, "Allow the planned destructive configuration changes")
	cmd.Flags().BoolVar(&allowDelete, "allow-delete", false, "Deprecated alias for --allow-destructive")
	_ = cmd.Flags().MarkDeprecated("allow-delete", "use --allow-destructive")
	_ = cmd.Flags().MarkHidden("allow-delete")
	cmd.Flags().BoolVar(&wait, "wait", false, "Wait for runtime acceptance")
	cmd.Flags().BoolVar(&noWait, "no-wait", false, "Return after the write")
	cmd.Flags().DurationVar(&waitTimeout, "wait-timeout", 15*time.Second, "Complete wait-loop timeout")
	_ = cmd.MarkFlagRequired("file")
	cmd.Example = "pulsectl config apply --file monitors.yaml"
	return cmd
}

func writeDestructiveChangeReasons(w io.Writer, reasons []DestructiveChangeReason) {
	for _, reason := range reasons {
		switch reason.Type {
		case "all-active-monitors-removed":
			fmt.Fprintf(w, "- all %d active monitors would be removed\n", reason.PreviousActiveCount)
		case "removed-monitor-count":
			fmt.Fprintf(w, "- %d active monitors would be removed\n", reason.RemovedCount)
		case "removed-monitor-percentage":
			fmt.Fprintf(
				w,
				"- %d of %d active monitors would be removed (%.1f%%)\n",
				reason.RemovedCount,
				reason.PreviousActiveCount,
				reason.Percentage,
			)
		case "active-group-removed":
			fmt.Fprintf(
				w,
				"- active group %s would lose all %d monitors\n",
				reason.Group,
				reason.PreviousActiveCount,
			)
		}
	}
}

func schemaCommand(d Dependencies) *cobra.Command {
	return &cobra.Command{Use: "schema", Short: "Print the configuration schema", Args: cobra.NoArgs, Annotations: annotations("config:read", "json,yaml"), RunE: func(cmd *cobra.Command, _ []string) error {
		if err := requireClient(d); err != nil {
			return err
		}
		var result map[string]any
		if _, err := d.Client.Do(cmd.Context(), http.MethodGet, "/api/v1/config/schema", nil, nil, &result); err != nil {
			return err
		}
		return render(d.Out, d.Output("json"), result, result)
	}}
}

func makePlan(ctx context.Context, d Dependencies, doc map[string]any) (planEnvelope, error) {
	if err := requireClient(d); err != nil {
		return planEnvelope{}, err
	}
	var current envelope
	headers, err := d.Client.Do(ctx, http.MethodGet, "/api/v1/config", nil, nil, &current)
	if err != nil {
		return planEnvelope{}, err
	}
	base := configHashFromETag(headers.Get("ETag"))
	if base == "" {
		return planEnvelope{}, &Error{Exit: 1, Code: "INVALID_RESPONSE", Message: "configuration response did not include a valid ETag"}
	}
	var result planEnvelope
	_, err = d.Client.Do(ctx, http.MethodPost, "/api/v1/config/plan", map[string]any{"baseConfigHash": base, "targetConfig": doc}, nil, &result)
	return result, err
}

func configHashFromETag(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && strings.EqualFold(value[:2], "W/") {
		value = strings.TrimSpace(value[2:])
	}
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		value = value[1 : len(value)-1]
	} else if strings.ContainsRune(value, '"') {
		return ""
	}
	return strings.TrimSpace(value)
}

func waitForOperation(ctx context.Context, d Dependencies, value map[string]any, timeout time.Duration) (map[string]any, error) {
	id, state := operationFields(value)
	if id == "" || state != "written" {
		return value, nil
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for state == "written" {
		if err := d.Sleep(ctx, 500*time.Millisecond); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return value, nil
			}
			return value, err
		}
		if _, err := d.Client.Do(ctx, http.MethodGet, "/api/v1/config/operations/"+id, nil, nil, &value); err != nil {
			if ctx.Err() != nil {
				return value, nil
			}
			return nil, err
		}
		_, state = operationFields(value)
	}
	return value, nil
}

func operationFields(v map[string]any) (string, string) {
	data, _ := v["data"].(map[string]any)
	id, _ := data["id"].(string)
	state, _ := data["state"].(string)
	return id, state
}

func ReadDocument(d Dependencies, path string) (map[string]any, error) {
	var r io.Reader
	var closeFn func() error
	if path == "-" {
		r = d.In
	} else {
		f, err := d.OpenFile(path)
		if err != nil {
			return nil, invalid("could not open configuration", err.Error())
		}
		r, closeFn = f, f.Close
		defer closeFn()
	}
	limited := io.LimitReader(r, MaxDocumentBytes+1)
	b, err := io.ReadAll(limited)
	if err != nil {
		return nil, invalid("could not read configuration", err.Error())
	}
	if len(b) > MaxDocumentBytes {
		return nil, invalid("configuration exceeds 55 KB", "")
	}
	var raw any
	if err := yaml.Unmarshal(b, &raw); err != nil {
		return nil, invalid("could not parse configuration", err.Error())
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, invalid("configuration must use string keys", err.Error())
	}
	var doc map[string]any
	if err := json.Unmarshal(encoded, &doc); err != nil || doc == nil {
		return nil, invalid("configuration must be an object", "")
	}
	upgraded, err := UpgradeDocument(doc)
	if err != nil {
		return nil, invalid("configuration is invalid", err.Error())
	}
	return upgraded, nil
}

func number(v any) (float64, bool) { n, ok := v.(float64); return n, ok }

// UpgradeDocument converts a valid-shape v1 document into the v2 group model.
// IDs match the service adapter so plan/apply hashes remain stable regardless of
// whether an older document is submitted by the user or read by the service.
func UpgradeDocument(doc map[string]any) (map[string]any, error) {
	version, ok := number(doc["version"])
	if !ok || version != 1 {
		return doc, nil
	}
	monitors, ok := doc["monitors"].([]any)
	if !ok {
		return doc, nil
	}

	names := map[string]string{}
	for i, raw := range monitors {
		monitor, ok := raw.(map[string]any)
		if !ok {
			return doc, nil
		}
		value, exists := monitor["group"]
		if !exists || value == nil {
			continue
		}
		name, ok := value.(string)
		if !ok {
			return doc, nil
		}
		name = strings.TrimSpace(name)
		if name == "" {
			return nil, fmt.Errorf("monitors[%d].group must not be empty", i)
		}
		folded := strings.ToLower(name)
		if _, exists := names[folded]; !exists {
			names[folded] = name
		}
	}

	ids := make(map[string]string, len(names))
	groups := make([]any, 0, len(names))
	for folded, name := range names {
		digest := sha256.Sum256([]byte(folded))
		id := fmt.Sprintf("group-%x", digest[:6])
		ids[folded] = id
		groups = append(groups, map[string]any{"id": id, "name": name})
	}
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].(map[string]any)["id"].(string) < groups[j].(map[string]any)["id"].(string)
	})

	upgradedMonitors := make([]any, 0, len(monitors))
	for _, raw := range monitors {
		monitor := raw.(map[string]any)
		upgraded := make(map[string]any, len(monitor))
		for key, value := range monitor {
			if key != "group" {
				upgraded[key] = value
			}
		}
		upgraded["groupId"] = nil
		if name, ok := monitor["group"].(string); ok && strings.TrimSpace(name) != "" {
			upgraded["groupId"] = ids[strings.ToLower(strings.TrimSpace(name))]
		}
		upgradedMonitors = append(upgradedMonitors, upgraded)
	}
	sort.SliceStable(upgradedMonitors, func(i, j int) bool {
		left, _ := upgradedMonitors[i].(map[string]any)["id"].(string)
		right, _ := upgradedMonitors[j].(map[string]any)["id"].(string)
		return left < right
	})

	upgraded := make(map[string]any, len(doc)+1)
	for key, value := range doc {
		if key != "monitors" {
			upgraded[key] = value
		}
	}
	upgraded["version"] = float64(2)
	upgraded["groups"] = groups
	upgraded["monitors"] = upgradedMonitors
	return upgraded, nil
}

func render(w io.Writer, format string, envelope any, human any) error {
	switch format {
	case "json", "jsonl":
		enc := json.NewEncoder(w)
		if format == "json" {
			enc.SetIndent("", "  ")
		}
		return enc.Encode(envelope)
	case "yaml":
		return yaml.NewEncoder(w).Encode(human)
	case "table", "tsv", "":
		selected := format
		if selected == "" {
			selected = "table"
		}
		return output.Render(w, selected, human)
	default:
		return invalid("unsupported output format "+format, "")
	}
}

func annotations(scope, formats string) map[string]string {
	return map[string]string{"requiredScope": scope, "supportsOutput": formats}
}
func annotationsStdin(scope, formats string) map[string]string {
	a := annotations(scope, formats)
	a["supportsStdin"] = "true"
	return a
}
func invalid(message, detail string) error {
	var details any
	if detail != "" {
		details = map[string]any{"cause": detail}
	}
	return &Error{Exit: 2, Code: "INVALID_ARGUMENT", Message: message, Details: details}
}
func requireClient(d Dependencies) error {
	if d.Client == nil {
		return &Error{Exit: 1, Code: "CLIENT_UNAVAILABLE", Message: "API client is unavailable"}
	}
	return nil
}
