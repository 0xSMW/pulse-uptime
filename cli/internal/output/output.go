package output

import (
	"encoding/json"
	"fmt"
	"io"

	"gopkg.in/yaml.v3"
)

type ErrorDocument struct {
	APIVersion string      `json:"apiVersion" yaml:"apiVersion"`
	Kind       string      `json:"kind" yaml:"kind"`
	Error      ErrorObject `json:"error" yaml:"error"`
}

type ErrorObject struct {
	Code      string `json:"code" yaml:"code"`
	Message   string `json:"message" yaml:"message"`
	Details   any    `json:"details,omitempty" yaml:"details,omitempty"`
	RequestID string `json:"requestId,omitempty" yaml:"requestId,omitempty"`
}

func JSON(w io.Writer, value any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

// RenderStructured writes the shared machine formats used by command
// envelopes. It leaves table and TSV rendering to the owning command because
// those layouts are resource specific.
func RenderStructured(w io.Writer, format string, value any) (bool, error) {
	switch format {
	case "json":
		return true, JSON(w, value)
	case "jsonl":
		return true, json.NewEncoder(w).Encode(value)
	case "yaml":
		return true, renderJSONShapedYAML(w, value)
	default:
		return false, nil
	}
}

// RenderStructuredList writes list envelopes for JSON and YAML. JSONL stays a
// record stream and deliberately omits the envelope and pagination metadata.
func RenderStructuredList(w io.Writer, format string, value any, records []json.RawMessage) (bool, error) {
	if format != "jsonl" {
		return RenderStructured(w, format, value)
	}
	for _, record := range records {
		if _, err := fmt.Fprintln(w, string(record)); err != nil {
			return true, err
		}
	}
	return true, nil
}

// renderJSONShapedYAML preserves JSON field names and omission rules before
// YAML encoding.
func renderJSONShapedYAML(w io.Writer, value any) error {
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

// CursorHint prints the shared continuation hint for a partial human list.
// Machine formats follow pagination before rendering and never call it.
func CursorHint(w io.Writer, resource string, cursor *string) {
	if cursor == nil || *cursor == "" {
		return
	}
	fmt.Fprintf(w, "More %s available. Continue with --cursor %s\n", resource, SanitizeDisplay(*cursor))
}

// IsMachine reports whether a format is one of the non-interactive outputs.
func IsMachine(format string) bool {
	return format == "json" || format == "jsonl" || format == "yaml" || format == "tsv"
}

func HumanError(w io.Writer, message string) {
	fmt.Fprintf(w, "Error: %s\n", SanitizeDisplay(message))
}
