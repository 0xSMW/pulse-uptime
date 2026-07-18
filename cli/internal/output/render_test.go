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
