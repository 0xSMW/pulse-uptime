// Package statuspageops implements the pulsectl status-page command family.
// It edits the dedicated status page configuration document with optimistic
// concurrency: every write sends If-Match with the ETag captured on read.
package statuspageops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// Transport is the small API surface needed by status page commands.
// Implementations own authentication, request IDs, idempotency, retries, and
// API error decoding. Response headers are returned so ETags survive.
type Transport interface {
	Do(context.Context, string, string, any, http.Header, any) (http.Header, error)
}

type Dependencies struct {
	Client   Transport
	In       io.Reader
	Out      io.Writer
	Err      io.Writer
	Output   func(defaultFormat string) string
	ReadFile func(string) ([]byte, error)
	Create   func(string, bool) (io.WriteCloser, error)
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

const (
	exitUnexpected   = 1
	exitInvalidInput = 2
	exitConflict     = 6
)

const configPath = "/api/v1/status-page-config"

type envelope struct {
	APIVersion string          `json:"apiVersion" yaml:"apiVersion"`
	Kind       string          `json:"kind" yaml:"kind"`
	Data       json.RawMessage `json:"data" yaml:"-"`
	Meta       map[string]any  `json:"meta,omitempty" yaml:"meta,omitempty"`
}

// fieldOrder fixes the presentation order of the configuration document for
// table and TSV output and for exported files.
var fieldOrder = []string{
	"name", "layout", "theme",
	"logoLightImageId", "logoDarkImageId", "faviconImageId",
	"homepageUrl", "contactUrl", "navLinks",
	"googleTagId", "customCss", "customHead",
	"announcementEnabled", "announcementMarkdown",
	"historyDays", "uptimeDecimals", "unknownAsOperational", "minIncidentSeconds",
	"timezone", "updatedAt",
}

// NewGroup returns the pulsectl status-page command family.
func NewGroup(d Dependencies) *cobra.Command {
	d = defaults(d)
	group := &cobra.Command{
		Use:   "status-page",
		Short: "Manage the public status page",
		Long: "Read and edit the public status page configuration: branding, links,\n" +
			"announcement banner, history math, analytics, and time zone. Writes use the\n" +
			"configuration's ETag so concurrent edits fail instead of overwriting.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	group.AddCommand(getCommand(d), setCommand(d), exportCommand(d), applyCommand(d))
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
	if d.Output == nil {
		d.Output = func(value string) string { return value }
	}
	if d.ReadFile == nil {
		d.ReadFile = os.ReadFile
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
	return d
}

func getCommand(d Dependencies) *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:         "get",
		Short:       "Show status page configuration",
		Long:        "Show the full status page configuration as a field listing, or as JSON with\n--json or --output json.",
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"supportsOutput": "table,json,yaml,tsv", "requiredScope": "config:read"},
		Example:     "pulsectl status-page get --json",
		RunE: func(cmd *cobra.Command, _ []string) error {
			doc, _, err := fetchConfig(cmd.Context(), d)
			if err != nil {
				return err
			}
			format := d.Output("table")
			if asJSON {
				format = "json"
			}
			return renderConfig(d.Out, format, doc)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Output JSON")
	return cmd
}

func setCommand(d Dependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "set <field>=<value> ...",
		Short: "Update status page fields",
		Long: "Update one or more configuration fields and save the document in a single\n" +
			"write. Booleans take true/false; give an empty value (field=) to clear an\n" +
			"optional field. navLinks cannot be edited here. Use status-page export,\n" +
			"edit the file, and status-page apply.",
		Args: cobra.MinimumNArgs(1),
		// set reads the current document (fetchConfig, GET, config:read) to
		// obtain the ETag before writing (putConfig, PUT, config:write).
		// Advertising only config:write would fail the GET for a
		// least-privilege token minted from this manifest.
		Annotations: map[string]string{"supportsOutput": "table,json,yaml,tsv", "requiredScope": "config:read,config:write"},
		Example:     "pulsectl status-page set name=\"Acme Status\" historyDays=60 announcementEnabled=true",
		RunE: func(cmd *cobra.Command, args []string) error {
			doc, etag, err := fetchConfig(cmd.Context(), d)
			if err != nil {
				return err
			}
			config, err := configMap(doc)
			if err != nil {
				return err
			}
			for _, arg := range args {
				field, value, found := strings.Cut(arg, "=")
				if !found || strings.TrimSpace(field) == "" {
					return invalid("arguments must be <field>=<value>, got " + strconv.Quote(arg))
				}
				if err := applyField(config, field, value); err != nil {
					return err
				}
			}
			result, err := putConfig(cmd.Context(), d, config, etag, "the status page configuration changed while updating; re-run the command")
			if err != nil {
				return err
			}
			return renderConfig(d.Out, d.Output("table"), result)
		},
	}
	return cmd
}

func exportCommand(d Dependencies) *cobra.Command {
	var file string
	var force bool
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export status page configuration",
		Long: "Write the status page configuration as JSON, including the current ETag as\n" +
			"an _etag field so status-page apply can detect concurrent edits. Without\n--file the document is written to stdout.",
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"supportsOutput": "json", "requiredScope": "config:read"},
		Example:     "pulsectl status-page export --file status-page.json",
		RunE: func(cmd *cobra.Command, _ []string) error {
			doc, etag, err := fetchConfig(cmd.Context(), d)
			if err != nil {
				return err
			}
			config, err := configMap(doc)
			if err != nil {
				return err
			}
			config["_etag"] = etag
			encoded, err := marshalOrdered(config)
			if err != nil {
				return err
			}
			if file == "" {
				_, err = fmt.Fprintln(d.Out, string(encoded))
				return err
			}
			w, err := d.Create(file, force)
			if err != nil {
				return invalid("could not create export file: " + err.Error())
			}
			defer w.Close()
			_, err = fmt.Fprintln(w, string(encoded))
			return err
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "Write the configuration to a file")
	cmd.Flags().BoolVar(&force, "force", false, "Overwrite an existing file")
	return cmd
}

func applyCommand(d Dependencies) *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:   "apply",
		Short: "Apply exported configuration",
		Long: "Replace the status page configuration with an exported file. The file's\n" +
			"_etag must still match the service; if the configuration changed since the\n" +
			"export, apply fails and you must re-export. Use --file - to read stdin.",
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"supportsOutput": "table,json,yaml,tsv", "requiredScope": "config:write", "supportsStdin": "true"},
		Example:     "pulsectl status-page apply --file status-page.json",
		RunE: func(cmd *cobra.Command, _ []string) error {
			var data []byte
			var err error
			if file == "-" {
				data, err = io.ReadAll(d.In)
			} else {
				data, err = d.ReadFile(file)
			}
			if err != nil {
				return invalid("could not read configuration file: " + err.Error())
			}
			var config map[string]any
			if err := json.Unmarshal(data, &config); err != nil {
				return invalid("configuration file is not valid JSON: " + err.Error())
			}
			etag, _ := config["_etag"].(string)
			if strings.TrimSpace(etag) == "" {
				return invalid("configuration file has no _etag field; re-run pulsectl status-page export")
			}
			delete(config, "_etag")
			result, err := putConfig(cmd.Context(), d, config, etag, "the status page configuration changed after this export; re-run pulsectl status-page export, reapply your edits, and try again")
			if err != nil {
				return err
			}
			return renderConfig(d.Out, d.Output("table"), result)
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "Read the configuration from a file or - for stdin")
	_ = cmd.MarkFlagRequired("file")
	return cmd
}

func fetchConfig(ctx context.Context, d Dependencies) (envelope, string, error) {
	if d.Client == nil {
		return envelope{}, "", &Error{Exit: exitUnexpected, Code: "CLI_ERROR", Message: "API client is unavailable"}
	}
	var doc envelope
	headers, err := d.Client.Do(ctx, http.MethodGet, configPath, nil, nil, &doc)
	if err != nil {
		return envelope{}, "", err
	}
	etag := strings.TrimSpace(headers.Get("ETag"))
	if etag == "" {
		return envelope{}, "", &Error{Exit: exitUnexpected, Code: "INVALID_RESPONSE", Message: "status page configuration response did not include an ETag"}
	}
	return doc, etag, nil
}

func putConfig(ctx context.Context, d Dependencies, config map[string]any, etag, conflictHint string) (envelope, error) {
	delete(config, "updatedAt")
	headers := make(http.Header)
	headers.Set("If-Match", etag)
	var result envelope
	if _, err := d.Client.Do(ctx, http.MethodPut, configPath, config, headers, &result); err != nil {
		return envelope{}, conflictError(err, conflictHint)
	}
	return result, nil
}

// conflictError decorates ETag conflicts (HTTP 409/412, exit 6) with recovery
// guidance while preserving the service's error code and details.
func conflictError(err error, hint string) error {
	var external interface {
		ExitCode() int
		ErrorCode() string
		ErrorDetails() any
	}
	if errors.As(err, &external) && external.ExitCode() == exitConflict {
		return &Error{Exit: exitConflict, Code: external.ErrorCode(), Message: err.Error() + ". " + hint, Details: external.ErrorDetails()}
	}
	return err
}

func configMap(doc envelope) (map[string]any, error) {
	var config map[string]any
	if err := json.Unmarshal(doc.Data, &config); err != nil || config == nil {
		return nil, &Error{Exit: exitUnexpected, Code: "INVALID_RESPONSE", Message: "service returned an invalid status page configuration"}
	}
	return config, nil
}

type fieldKind int

const (
	requiredString fieldKind = iota
	nullableString
	boolean
	integer
)

type fieldSpec struct {
	kind fieldKind
	enum []string
	ints []int
	min  int
	max  int
}

var fields = map[string]fieldSpec{
	"name":                 {kind: requiredString},
	"layout":               {kind: requiredString, enum: []string{"vertical", "horizontal"}},
	"theme":                {kind: requiredString, enum: []string{"system", "light", "dark"}},
	"logoLightImageId":     {kind: nullableString},
	"logoDarkImageId":      {kind: nullableString},
	"faviconImageId":       {kind: nullableString},
	"homepageUrl":          {kind: nullableString},
	"contactUrl":           {kind: nullableString},
	"googleTagId":          {kind: nullableString},
	"customCss":            {kind: nullableString},
	"customHead":           {kind: nullableString},
	"announcementEnabled":  {kind: boolean},
	"announcementMarkdown": {kind: nullableString},
	"historyDays":          {kind: integer, ints: []int{30, 60, 90}},
	"uptimeDecimals":       {kind: integer, min: 0, max: 3},
	"unknownAsOperational": {kind: boolean},
	"minIncidentSeconds":   {kind: integer, min: 0, max: 604800},
	"timezone":             {kind: nullableString},
}

func applyField(config map[string]any, field, value string) error {
	if field == "navLinks" {
		return invalid("navLinks cannot be edited with set; use pulsectl status-page export, edit the file, and pulsectl status-page apply")
	}
	spec, ok := fields[field]
	if !ok {
		return invalid("unknown field " + strconv.Quote(field) + "; supported fields: " + strings.Join(settableFields(), ", "))
	}
	switch spec.kind {
	case requiredString:
		if strings.TrimSpace(value) == "" {
			return invalid(field + " cannot be empty")
		}
		if len(spec.enum) > 0 && !containsString(spec.enum, value) {
			return invalid(field + " must be one of " + strings.Join(spec.enum, ", "))
		}
		config[field] = value
	case nullableString:
		if value == "" {
			config[field] = nil
		} else {
			config[field] = value
		}
	case boolean:
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			return invalid(field + " must be true or false")
		}
		config[field] = parsed
	case integer:
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return invalid(field + " must be an integer")
		}
		if len(spec.ints) > 0 {
			if !containsInt(spec.ints, parsed) {
				return invalid(field + " must be one of " + joinInts(spec.ints))
			}
		} else if parsed < spec.min || parsed > spec.max {
			return invalid(fmt.Sprintf("%s must be between %d and %d", field, spec.min, spec.max))
		}
		config[field] = parsed
	}
	return nil
}

func settableFields() []string {
	result := make([]string, 0, len(fields))
	for _, name := range fieldOrder {
		if _, ok := fields[name]; ok {
			result = append(result, name)
		}
	}
	return result
}

func renderConfig(w io.Writer, format string, doc envelope) error {
	switch format {
	case "json":
		return jsonPretty(w, doc)
	case "jsonl":
		return json.NewEncoder(w).Encode(doc)
	case "yaml":
		return yamlValue(w, doc)
	case "tsv":
		return renderFields(w, doc, "\t", false, output.EscapeTSVField)
	default:
		return renderFields(w, doc, "  ", true, output.SanitizeDisplay)
	}
}

func renderFields(w io.Writer, doc envelope, separator string, aligned bool, escape func(string) string) error {
	var config map[string]any
	if err := json.Unmarshal(doc.Data, &config); err != nil || config == nil {
		_, err := fmt.Fprintln(w, escape(string(doc.Data)))
		return err
	}
	for _, field := range orderedFields(config) {
		label := field + ":"
		if aligned {
			label = fmt.Sprintf("%-22s", label)
		}
		if _, err := fmt.Fprintf(w, "%s%s%s\n", label, separator, fieldValue(config[field], escape)); err != nil {
			return err
		}
	}
	return nil
}

func orderedFields(config map[string]any) []string {
	result := make([]string, 0, len(config))
	seen := map[string]bool{}
	for _, field := range fieldOrder {
		if _, ok := config[field]; ok {
			result = append(result, field)
			seen[field] = true
		}
	}
	rest := make([]string, 0, len(config))
	for field := range config {
		if !seen[field] {
			rest = append(rest, field)
		}
	}
	sortStrings(rest)
	return append(result, rest...)
}

// fieldValue renders one configuration value for display. escape sanitizes
// server-provided text for the destination: SanitizeDisplay for the terminal
// (table) and EscapeTSVField for TSV, matching output/render.go's scoping.
// Booleans and numbers can't carry control characters, so they pass through
// unescaped; the default branch (e.g. navLinks) JSON-encodes nested
// label/url strings first and then escapes the encoded text, since
// encoding/json does not strip bidi-override characters.
func fieldValue(value any, escape func(string) string) string {
	switch typed := value.(type) {
	case nil:
		return "-"
	case string:
		return escape(typed)
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		encoded, _ := json.Marshal(typed)
		return escape(string(encoded))
	}
}

// marshalOrdered writes the configuration with _etag first and the remaining
// fields in presentation order so exports diff cleanly.
func marshalOrdered(config map[string]any) ([]byte, error) {
	var buf strings.Builder
	buf.WriteString("{")
	first := true
	write := func(field string, value any) error {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if !first {
			buf.WriteString(",")
		}
		first = false
		buf.WriteString("\n  ")
		name, _ := json.Marshal(field)
		buf.Write(name)
		buf.WriteString(": ")
		buf.Write(encoded)
		return nil
	}
	if etag, ok := config["_etag"]; ok {
		if err := write("_etag", etag); err != nil {
			return nil, err
		}
	}
	seen := map[string]bool{"_etag": true}
	for _, field := range fieldOrder {
		if value, ok := config[field]; ok {
			if err := write(field, value); err != nil {
				return nil, err
			}
			seen[field] = true
		}
	}
	rest := make([]string, 0, len(config))
	for field := range config {
		if !seen[field] {
			rest = append(rest, field)
		}
	}
	sortStrings(rest)
	for _, field := range rest {
		if err := write(field, config[field]); err != nil {
			return nil, err
		}
	}
	buf.WriteString("\n}")
	return []byte(buf.String()), nil
}

func sortStrings(values []string) { sort.Strings(values) }

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func containsInt(values []int, value int) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func joinInts(values []int) string {
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = strconv.Itoa(value)
	}
	return strings.Join(parts, ", ")
}

func invalid(message string) error {
	return &Error{Exit: exitInvalidInput, Code: "INVALID_ARGUMENT", Message: message}
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
