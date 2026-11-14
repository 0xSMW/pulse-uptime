package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

func TestTableAlignsMixedWidthCells(t *testing.T) {
	// Widths count runes, so the em-dash placeholder, glyph cells, and a
	// SanitizeDisplay-escaped tab all occupy exactly their visible width.
	header := []string{"ID", "STATE", "UPTIME"}
	rows := [][]string{
		{"photos-stephenwalker-co", "● UP", "100.0000%"},
		{"smw-ai", "PENDING", "—"},
		{"tabbed", SanitizeDisplay("API\tDOWN"), "✓"},
	}
	var out bytes.Buffer
	if err := Table(&out, header, rows); err != nil {
		t.Fatal(err)
	}
	want := "ID                       STATE        UPTIME\n" +
		"photos-stephenwalker-co  ● UP         100.0000%\n" +
		"smw-ai                   PENDING      —\n" +
		`tabbed                   API\x09DOWN  ` + "✓\n"
	if out.String() != want {
		t.Fatalf("table = %q", out.String())
	}
}

func TestTableWithLimitTruncatesWidestColumn(t *testing.T) {
	// Total content width is 47 plus separators. A limit of 40 must come out
	// of the widest column (NAME) alone, with every line fitting the limit
	// and narrow columns untouched.
	header := []string{"ID", "NAME", "STATE"}
	rows := [][]string{
		{"dep-1", "a very long dependency incident title here", "UP"},
		{"dep-2", "short", "DOWN"},
	}
	var out bytes.Buffer
	if err := tableWithLimit(&out, header, rows, 40, false); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	for _, line := range lines {
		if width := len([]rune(strings.TrimRight(line, " "))); width > 40 {
			t.Errorf("line exceeds limit (%d runes): %q", width, line)
		}
	}
	if !strings.Contains(out.String(), "…") {
		t.Fatalf("expected ellipsis in truncated output: %q", out.String())
	}
	if !strings.Contains(out.String(), "dep-1") || !strings.Contains(out.String(), "DOWN") {
		t.Fatalf("narrow columns must stay intact: %q", out.String())
	}
}

func TestTableWithLimitKeepsFittingRowsUntouched(t *testing.T) {
	header := []string{"ID", "STATE"}
	rows := [][]string{{"api", "UP"}}
	var wide, unlimited bytes.Buffer
	if err := tableWithLimit(&wide, header, rows, 80, false); err != nil {
		t.Fatal(err)
	}
	if err := tableWithLimit(&unlimited, header, rows, 0, false); err != nil {
		t.Fatal(err)
	}
	if wide.String() != unlimited.String() {
		t.Fatalf("fitting table changed under a limit: %q vs %q", wide.String(), unlimited.String())
	}
}

func TestTableWithLimitStopsShrinkingAtColumnFloors(t *testing.T) {
	// Both columns bottom out at their floors under an impossible limit, so
	// output still renders instead of vanishing, merely wider than asked.
	header := []string{"ID", "NAME"}
	rows := [][]string{{"a-rather-long-identifier", "an even longer display name value"}}
	var out bytes.Buffer
	if err := tableWithLimit(&out, header, rows, 10, false); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected header and one row: %q", out.String())
	}
	for _, line := range lines[1:] {
		if width := len([]rune(strings.TrimRight(line, " "))); width > 18 {
			t.Errorf("columns must bottom out at floor widths (8 each plus separator), got %d runes: %q", width, line)
		}
	}
}

func TestTableDimHeaderWrapsOnlyHeaderLine(t *testing.T) {
	// The dim codes wrap the aligned header line whole, after width math, so
	// styling adds no width and data rows stay byte-identical to unstyled.
	header := []string{"ID", "STATE"}
	rows := [][]string{{"api", "UP"}}
	var dimmed, plain bytes.Buffer
	if err := tableWithLimit(&dimmed, header, rows, 0, true); err != nil {
		t.Fatal(err)
	}
	if err := tableWithLimit(&plain, header, rows, 0, false); err != nil {
		t.Fatal(err)
	}
	dimLines := strings.SplitN(dimmed.String(), "\n", 2)
	plainLines := strings.SplitN(plain.String(), "\n", 2)
	if dimLines[0] != "\x1b[2m"+plainLines[0]+"\x1b[0m" {
		t.Fatalf("header line = %q, want dim-wrapped %q", dimLines[0], plainLines[0])
	}
	if dimLines[1] != plainLines[1] {
		t.Fatalf("data rows changed under styling: %q vs %q", dimLines[1], plainLines[1])
	}
}

func TestRenderHumanUsesStableColumns(t *testing.T) {
	value := map[string]any{"apiVersion": "v1", "kind": "MonitorList", "data": []any{map[string]any{"state": "UP", "name": "API", "id": "api"}}}
	var out bytes.Buffer
	if err := Render(&out, "table", value); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || lines[0] != "ID   NAME  STATE" || lines[1] != "api  API   UP" {
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

func TestHumanErrorSanitizesHostileServiceText(t *testing.T) {
	var out bytes.Buffer
	HumanError(&out, "denied\x1b]52;c;copied\x07\nforged")
	if strings.ContainsAny(out.String(), "\x1b\x07") {
		t.Fatalf("human error leaked terminal controls: %q", out.String())
	}
	for _, want := range []string{`\x1b`, `\x07`, `\x0a`} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("human error %q missing %q", out.String(), want)
		}
	}
}

func FuzzSanitizeDisplayNeverEmitsTerminalControls(f *testing.F) {
	f.Add("plain Unicode สวัสดี 🌐")
	f.Add("\x1b]52;c;clipboard\x07\nforged\u202e")
	f.Fuzz(func(t *testing.T, value string) {
		got := SanitizeDisplay(value)
		if strings.ContainsFunc(got, isDisplayControl) {
			t.Fatalf("sanitized output contains a terminal control: %q", got)
		}
	})
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

func TestRenderStructuredPreservesMachineFormatBytes(t *testing.T) {
	value := struct {
		APIVersion string          `json:"apiVersion" yaml:"wrong_api_version"`
		Data       json.RawMessage `json:"data" yaml:"wrong_data"`
	}{APIVersion: "v1", Data: json.RawMessage(`{"label":"<api>"}`)}
	tests := []struct {
		format string
		want   string
	}{
		{format: "json", want: "{\n  \"apiVersion\": \"v1\",\n  \"data\": {\n    \"label\": \"<api>\"\n  }\n}\n"},
		{format: "jsonl", want: `{"apiVersion":"v1","data":{"label":"\u003capi\u003e"}}` + "\n"},
		{format: "yaml", want: "apiVersion: v1\ndata:\n    label: <api>\n"},
	}
	for _, tt := range tests {
		t.Run(tt.format, func(t *testing.T) {
			var out bytes.Buffer
			handled, err := RenderStructured(&out, tt.format, value)
			if err != nil {
				t.Fatal(err)
			}
			if !handled {
				t.Fatal("format was not handled")
			}
			if out.String() != tt.want {
				t.Fatalf("output = %q, want %q", out.String(), tt.want)
			}
		})
	}
	var out bytes.Buffer
	handled, err := RenderStructured(&out, "table", value)
	if err != nil || handled || out.Len() != 0 {
		t.Fatalf("custom format = handled %t, error %v, output %q", handled, err, out.String())
	}
}

func TestRenderStructuredListJSONLWritesRawRecordsOnly(t *testing.T) {
	records := []json.RawMessage{json.RawMessage(`{"id":"first","label":"<api>"}`), json.RawMessage(`not-json`)}
	var out bytes.Buffer
	handled, err := RenderStructuredList(&out, "jsonl", map[string]any{"data": records}, records)
	if err != nil {
		t.Fatal(err)
	}
	if !handled {
		t.Fatal("jsonl was not handled")
	}
	want := "{\"id\":\"first\",\"label\":\"<api>\"}\nnot-json\n"
	if out.String() != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
}

func TestStructuredRenderersReturnWriterErrors(t *testing.T) {
	if handled, err := RenderStructured(errorWriter{}, "json", map[string]string{"id": "api"}); !handled || err == nil {
		t.Fatalf("json = handled %t, error %v", handled, err)
	}
	if handled, err := RenderStructuredList(errorWriter{}, "jsonl", nil, []json.RawMessage{json.RawMessage(`{"id":"api"}`)}); !handled || err == nil {
		t.Fatalf("jsonl list = handled %t, error %v", handled, err)
	}
}

func TestCursorHintPreservesWordingAndSanitizesCursor(t *testing.T) {
	malicious := "next\x1b]52;c;copied\x07"
	var out bytes.Buffer
	CursorHint(&out, "monitors", &malicious)
	want := `More monitors available. Continue with --cursor next\x1b]52;c;copied\x07` + "\n"
	if out.String() != want {
		t.Fatalf("hint = %q, want %q", out.String(), want)
	}
	CursorHint(&out, "monitors", nil)
	empty := ""
	CursorHint(&out, "monitors", &empty)
	if out.String() != want {
		t.Fatalf("empty cursor changed output: %q", out.String())
	}
}

func TestIsMachineMatchesSupportedStructuredAndTabularFormats(t *testing.T) {
	for _, format := range []string{"json", "jsonl", "yaml", "tsv"} {
		if !IsMachine(format) {
			t.Errorf("%q must be machine output", format)
		}
	}
	for _, format := range []string{"", "table", "csv", "JSON"} {
		if IsMachine(format) {
			t.Errorf("%q must be human output", format)
		}
	}
}
