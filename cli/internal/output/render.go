package output

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Render writes a complete API envelope without adding diagnostics or prose.
// Human rendering is intentionally simple and deterministic for the first CLI.
func Render(w io.Writer, format string, value any) error {
	switch format {
	case "json":
		return JSON(w, value)
	case "jsonl":
		return json.NewEncoder(w).Encode(value)
	case "yaml":
		return yaml.NewEncoder(w).Encode(value)
	case "tsv":
		return renderTSV(w, value)
	case "table":
		return renderHuman(w, value)
	default:
		return fmt.Errorf("unsupported output format %q", format)
	}
}

func renderHuman(w io.Writer, value any) error {
	normalized, err := normalize(value)
	if err != nil {
		return err
	}
	data := normalized
	if envelope, ok := normalized.(map[string]any); ok {
		if nested, found := envelope["data"]; found {
			data = nested
		}
	}
	switch typed := data.(type) {
	case []any:
		return renderRows(w, typed, "  ")
	case map[string]any:
		keys := sortedKeys(typed)
		for _, key := range keys {
			fmt.Fprintf(w, "%-18s %s\n", humanLabel(key), scalar(typed[key]))
		}
		return nil
	default:
		_, err := fmt.Fprintln(w, scalar(typed))
		return err
	}
}

func renderTSV(w io.Writer, value any) error {
	normalized, err := normalize(value)
	if err != nil {
		return err
	}
	if envelope, ok := normalized.(map[string]any); ok {
		if nested, found := envelope["data"]; found {
			normalized = nested
		}
	}
	switch typed := normalized.(type) {
	case []any:
		return renderRows(w, typed, "\t")
	case map[string]any:
		for _, key := range sortedKeys(typed) {
			fmt.Fprintf(w, "%s\t%s\n", key, scalar(typed[key]))
		}
		return nil
	default:
		_, err := fmt.Fprintln(w, scalar(typed))
		return err
	}
}

func renderRows(w io.Writer, rows []any, separator string) error {
	if len(rows) == 0 {
		if separator == "\t" {
			return nil
		}
		_, err := fmt.Fprintln(w, "No results")
		return err
	}
	columnSet := map[string]bool{}
	for _, row := range rows {
		if object, ok := row.(map[string]any); ok {
			for key := range object {
				columnSet[key] = true
			}
		}
	}
	columns := orderedColumns(columnSet)
	labels := make([]string, len(columns))
	for i, column := range columns {
		labels[i] = humanLabel(column)
	}
	fmt.Fprintln(w, strings.Join(labels, separator))
	for _, row := range rows {
		object, _ := row.(map[string]any)
		values := make([]string, len(columns))
		for i, column := range columns {
			values[i] = scalar(object[column])
		}
		fmt.Fprintln(w, strings.Join(values, separator))
	}
	return nil
}

func orderedColumns(set map[string]bool) []string {
	preferred := []string{"id", "name", "monitorId", "state", "url", "enabled", "openedAt", "resolvedAt", "createdAt", "expiresAt"}
	result := make([]string, 0, len(set))
	for _, key := range preferred {
		if set[key] {
			result = append(result, key)
			delete(set, key)
		}
	}
	rest := make([]string, 0, len(set))
	for key := range set {
		rest = append(rest, key)
	}
	sort.Strings(rest)
	return append(result, rest...)
}

func sortedKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func normalize(value any) (any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var normalized any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

func scalar(value any) string {
	switch typed := value.(type) {
	case nil:
		return "-"
	case string:
		return typed
	case bool, float64:
		return fmt.Sprint(typed)
	default:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	}
}

func humanLabel(value string) string {
	var out []rune
	for i, r := range value {
		if i > 0 && r >= 'A' && r <= 'Z' {
			out = append(out, ' ')
		}
		out = append(out, r)
	}
	return strings.ToUpper(string(out))
}
