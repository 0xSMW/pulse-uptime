package output

import (
	"bytes"
	"strings"
	"testing"
)

func TestRenderHumanUsesStableColumns(t *testing.T) {
	value := map[string]any{"apiVersion": "v1", "kind": "MonitorList", "data": []any{map[string]any{"state": "UP", "name": "API", "id": "api"}}}
	var out bytes.Buffer
	if err := Render(&out, "table", value); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || lines[0] != "ID  NAME  STATE" || lines[1] != "api  API  UP" {
		t.Fatalf("unexpected table: %q", out.String())
	}
}

func TestSanitizeDisplayEscapesControlAndBidi(t *testing.T) {
	// SEC-07: ESC, CR, tab, newline, and bidi overrides must never survive.
	in := "API\x1b[31m\t\r\n‮DOWN"
	got := SanitizeDisplay(in)
	if strings.ContainsAny(got, "\x1b\t\r\n") || strings.ContainsRune(got, '‮') {
		t.Fatalf("sanitized value still holds control characters: %q", got)
	}
	for _, want := range []string{`\x1b`, `\x09`, `\x0d`, `\x0a`, "\\u202e"} {
		if !strings.Contains(got, want) {
			t.Fatalf("sanitized value %q missing %q", got, want)
		}
	}
	if plain := SanitizeDisplay("normal name 123"); plain != "normal name 123" {
		t.Fatalf("plain value changed: %q", plain)
	}
}

func TestEscapeTSVFieldPreventsForgedRowsAndCells(t *testing.T) {
	// SEC-07: an embedded tab or newline must not forge a new TSV column or row.
	got := EscapeTSVField("evil\tCOL\nROW\rX\\Y")
	if strings.ContainsAny(got, "\t\n\r") {
		t.Fatalf("escaped field still holds raw delimiters: %q", got)
	}
	if got != `evil\tCOL\nROW\rX\\Y` {
		t.Fatalf("unexpected escaping: %q", got)
	}
}

func TestRenderTableNeutralizesInjectedName(t *testing.T) {
	value := map[string]any{"apiVersion": "v1", "kind": "MonitorList", "data": []any{map[string]any{"id": "api", "name": "API\x1b[2K\tDOWN"}}}
	var out bytes.Buffer
	if err := Render(&out, "table", value); err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(out.String(), "\x1b") {
		t.Fatalf("table output leaked an ESC byte: %q", out.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("injected name changed the row count: %q", out.String())
	}
}

func TestRenderTSVInjectedNameStaysOneRow(t *testing.T) {
	value := map[string]any{"apiVersion": "v1", "kind": "MonitorList", "data": []any{map[string]any{"id": "api", "name": "API\tFORGED\nrow2\tx"}}}
	var out bytes.Buffer
	if err := Render(&out, "tsv", value); err != nil {
		t.Fatal(err)
	}
	// Header row plus exactly one data row: the injected tab/newline are escaped.
	if lines := strings.Split(strings.TrimSpace(out.String()), "\n"); len(lines) != 2 {
		t.Fatalf("injected name forged extra rows: %q", out.String())
	}
}

func TestRenderJSONPreservesEnvelope(t *testing.T) {
	value := map[string]any{"apiVersion": "v1", "kind": "Status", "data": map[string]any{"ok": true}}
	var out bytes.Buffer
	if err := Render(&out, "json", value); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"apiVersion": "v1"`) || !strings.HasSuffix(out.String(), "\n") {
		t.Fatalf("unexpected JSON: %q", out.String())
	}
}
