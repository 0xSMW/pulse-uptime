package interactive

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCollectOptionsFlatEnvelope(t *testing.T) {
	raw := []byte(`{"apiVersion":"v1","kind":"MonitorList","data":[
		{"id":"mon_1","name":"Checkout","url":"https://a"},
		{"id":"mon_2","name":"Search","url":"https://b"}
	],"meta":{"nextCursor":""}}`)
	options := CollectOptions(raw, "id", []string{"name", "url"})
	if len(options) != 2 {
		t.Fatalf("got %d options, want 2", len(options))
	}
	if options[0].Value != "mon_1" || options[0].Label != "Checkout (mon_1)" {
		t.Fatalf("unexpected first option %+v", options[0])
	}
	if options[1].Value != "mon_2" {
		t.Fatalf("unexpected second option %+v", options[1])
	}
}

func TestCollectOptionsNestedCatalog(t *testing.T) {
	raw := []byte(`{"data":{"categories":[
		{"name":"Cloud","presets":[{"id":"aws","name":"AWS"},{"id":"gcp","name":"GCP"}]},
		{"name":"Payments","presets":[{"id":"stripe","name":"Stripe"}]}
	]}}`)
	options := CollectOptions(raw, "id", []string{"name"})
	if len(options) != 3 {
		t.Fatalf("got %d options, want 3", len(options))
	}
}

func TestCollectOptionsSkipsObjectsWithoutLabel(t *testing.T) {
	raw := []byte(`{"data":[
		{"id":"rep_1","title":"Outage","affected":[{"id":"mon_1","impact":"down"}]},
		{"id":"orphan"}
	]}`)
	options := CollectOptions(raw, "id", []string{"title"})
	if len(options) != 1 || options[0].Value != "rep_1" {
		t.Fatalf("unexpected options %+v", options)
	}
}

func TestCollectOptionsIdenticalLabelOmitsSuffix(t *testing.T) {
	raw := []byte(`{"data":[{"name":"production","server":"https://p"}]}`)
	options := CollectOptions(raw, "name", []string{"name"})
	if len(options) != 1 || options[0].Label != "production" || options[0].Value != "production" {
		t.Fatalf("unexpected options %+v", options)
	}
}

func TestCollectOptionsDeduplicatesAndCaps(t *testing.T) {
	raw := []byte(`{"data":[{"id":"a","name":"One"},{"id":"a","name":"One again"}]}`)
	options := CollectOptions(raw, "id", []string{"name"})
	if len(options) != 1 {
		t.Fatalf("duplicate id not collapsed: %+v", options)
	}
	big := `{"data":[`
	for i := 0; i < maxPickerOptions+50; i++ {
		if i > 0 {
			big += ","
		}
		big += fmt.Sprintf(`{"id":"id_%d","name":"Item %d"}`, i, i)
	}
	big += `]}`
	options = CollectOptions([]byte(big), "id", []string{"name"})
	if len(options) != maxPickerOptions {
		t.Fatalf("got %d options, want cap %d", len(options), maxPickerOptions)
	}
}

func TestCollectOptionsInvalidJSON(t *testing.T) {
	if options := CollectOptions([]byte("not json"), "id", []string{"name"}); options != nil {
		t.Fatalf("expected nil, got %+v", options)
	}
}

// TestCollectOptionsSanitizesHostileLabels proves API-supplied ESC, CR,
// newline, and tab bytes are escaped before they can reach the terminal,
// while the raw id survives as the argv value.
func TestCollectOptionsSanitizesHostileLabels(t *testing.T) {
	raw, err := json.Marshal(map[string]any{"data": []map[string]any{
		{"id": "mon_\x1b[2Jevil", "name": "Bad\x1b[31mname\r\nrow\ttail"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	options := CollectOptions(raw, "id", []string{"name"})
	if len(options) != 1 {
		t.Fatalf("got %d options, want 1", len(options))
	}
	label := options[0].Label
	for _, forbidden := range []string{"\x1b", "\r", "\n", "\t"} {
		if strings.Contains(label, forbidden) {
			t.Fatalf("label %q still contains raw control byte %q", label, forbidden)
		}
	}
	for _, escaped := range []string{`\x1b`, `\x0d`, `\x0a`, `\x09`} {
		if !strings.Contains(label, escaped) {
			t.Fatalf("label %q missing escaped form %s", label, escaped)
		}
	}
	if options[0].Value != "mon_\x1b[2Jevil" {
		t.Fatalf("value %q was altered, argv must carry the raw id", options[0].Value)
	}
}
