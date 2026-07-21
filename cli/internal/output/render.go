package output

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"

	"gopkg.in/yaml.v3"
)

// Table writes an aligned human table with two spaces between columns. Column
// widths are counted in runes, so glyph and em-dash cells line up. Callers must
// sanitize every cell with SanitizeDisplay before passing it in, the SEC-07
// boundary depends on escaped tabs never reaching the writer as cell content.
func Table(w io.Writer, header []string, rows [][]string) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, strings.Join(header, "\t")); err != nil {
		return err
	}
	for _, row := range rows {
		if _, err := fmt.Fprintln(tw, strings.Join(row, "\t")); err != nil {
			return err
		}
	}
	return tw.Flush()
}

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
		return renderRows(w, typed, false)
	case map[string]any:
		keys := sortedKeys(typed)
		for _, key := range keys {
			fmt.Fprintf(w, "%-18s %s\n", SanitizeDisplay(humanLabel(key)), SanitizeDisplay(scalar(typed[key])))
		}
		return nil
	default:
		_, err := fmt.Fprintln(w, SanitizeDisplay(scalar(typed)))
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
		return renderRows(w, typed, true)
	case map[string]any:
		for _, key := range sortedKeys(typed) {
			fmt.Fprintf(w, "%s\t%s\n", EscapeTSVField(key), EscapeTSVField(scalar(typed[key])))
		}
		return nil
	default:
		_, err := fmt.Fprintln(w, EscapeTSVField(scalar(typed)))
		return err
	}
}

// renderRows encodes tabular output. The escape step defends the render
// boundary against server-provided control characters: SanitizeDisplay for the
// terminal and EscapeTSVField for TSV, so an embedded tab, newline, or ESC
// cannot forge cells or reach the terminal. Human tables align through Table,
// TSV keeps raw tab separators because it is a machine format.
func renderRows(w io.Writer, rows []any, tsv bool) error {
	if len(rows) == 0 {
		if tsv {
			return nil
		}
		_, err := fmt.Fprintln(w, "No results")
		return err
	}
	escape := SanitizeDisplay
	if tsv {
		escape = EscapeTSVField
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
		labels[i] = escape(humanLabel(column))
	}
	values := make([][]string, len(rows))
	for r, row := range rows {
		object, _ := row.(map[string]any)
		cells := make([]string, len(columns))
		for i, column := range columns {
			cells[i] = escape(scalar(object[column]))
		}
		values[r] = cells
	}
	if !tsv {
		return Table(w, labels, values)
	}
	fmt.Fprintln(w, strings.Join(labels, "\t"))
	for _, cells := range values {
		fmt.Fprintln(w, strings.Join(cells, "\t"))
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

// isDisplayControl reports whether r is a control or bidi-override character
// that must never reach a terminal verbatim: C0 (except ordinary space), DEL,
// C1, and the Unicode bidirectional embedding/override/isolate controls.
func isDisplayControl(r rune) bool {
	switch {
	case r < 0x20: // C0 controls, including TAB, LF, and CR
		return true
	case r == 0x7f: // DEL
		return true
	case r >= 0x80 && r <= 0x9f: // C1 controls
		return true
	case r >= 0x202a && r <= 0x202e: // LRE, RLE, PDF, LRO, RLO
		return true
	case r >= 0x2066 && r <= 0x2069: // LRI, RLI, FSI, PDI
		return true
	default:
		return false
	}
}

func escapeControl(b *strings.Builder, r rune) {
	if r <= 0xff {
		fmt.Fprintf(b, `\x%02x`, r)
		return
	}
	fmt.Fprintf(b, `\u%04x`, r)
}

// SanitizeDisplay escapes control and bidi characters in a server-provided
// string so raw ESC, CR, tab, or newline cannot manipulate the terminal or
// break single-line column layout. Escaped characters render as \xNN or \uNNNN.
func SanitizeDisplay(value string) string {
	if !strings.ContainsFunc(value, isDisplayControl) {
		return value
	}
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if isDisplayControl(r) {
			escapeControl(&b, r)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// EscapeTSVField encodes a field so an embedded tab or newline cannot forge a
// new TSV column or row, and so control/bidi characters cannot reach the
// terminal. Backslash is escaped first to keep the encoding reversible.
func EscapeTSVField(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if isDisplayControl(r) {
				escapeControl(&b, r)
				continue
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}
