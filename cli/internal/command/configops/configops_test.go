package configops

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type call struct {
	method, path string
	body         any
	headers      http.Header
}
type fakeTransport struct{ calls []call }

func (f *fakeTransport) Do(_ context.Context, method, path string, body any, headers http.Header, out any) (http.Header, error) {
	f.calls = append(f.calls, call{method, path, body, headers.Clone()})
	switch path {
	case "/api/v1/config":
		if target, ok := out.(*envelope); ok {
			target.APIVersion, target.Kind, target.Data = "v1", "Configuration", json.RawMessage(`{"version":1,"settings":{},"monitors":[]}`)
		}
		headers := make(http.Header)
		headers.Set("ETag", `"sha256:base"`)
		return headers, nil
	case "/api/v1/config/plan":
		target := out.(*planEnvelope)
		target.APIVersion, target.Kind = "v1", "ConfigurationPlan"
		target.Data = Plan{BaseConfigHash: "sha256:base", TargetConfigHash: "sha256:target", PlanHash: "sha256:plan"}
	case "/api/v1/config/apply":
		target := out.(*map[string]any)
		*target = map[string]any{"apiVersion": "v1", "kind": "ConfigurationOperation", "data": map[string]any{"id": "op", "state": "written"}}
	}
	return nil, nil
}

func validConfig() string { return "version: 1\nsettings: {}\nmonitors: []\n" }

func TestApplyCarriesPlanMetadataAndIfMatch(t *testing.T) {
	client := &fakeTransport{}
	var out bytes.Buffer
	cmd := NewCommand(Dependencies{Client: client, In: strings.NewReader(validConfig()), Out: &out, StdinTTY: false, Output: func(string) string { return "json" }, Sleep: func(context.Context, time.Duration) error { return context.DeadlineExceeded }})
	cmd.SetArgs([]string{"apply", "--file", "-", "--yes", "--no-wait"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.calls) != 3 {
		t.Fatalf("got %d calls", len(client.calls))
	}
	apply := client.calls[2]
	if apply.headers.Get("If-Match") != `"sha256:base"` {
		t.Fatalf("If-Match = %q", apply.headers.Get("If-Match"))
	}
	body := apply.body.(map[string]any)
	for key, want := range map[string]string{"baseConfigHash": "sha256:base", "targetConfigHash": "sha256:target", "planHash": "sha256:plan"} {
		if body[key] != want {
			t.Errorf("%s = %v", key, body[key])
		}
	}
}

func TestReadDocumentRejectsOversize(t *testing.T) {
	_, err := ReadDocument(defaults(Dependencies{In: io.LimitReader(strings.NewReader(strings.Repeat("x", MaxDocumentBytes+2)), MaxDocumentBytes+2)}), "-")
	if err == nil || !strings.Contains(err.Error(), "55 KB") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateDocumentFindsDuplicateIDsAndRanges(t *testing.T) {
	doc, err := ReadDocument(defaults(Dependencies{In: strings.NewReader("version: 1\nsettings:\n  defaultTimeoutMs: 20\nmonitors:\n  - {id: api, name: API, url: https://a}\n  - {id: api, name: API2, url: https://b}\n")}), "-")
	if err != nil {
		t.Fatal(err)
	}
	issues := ValidateDocument(doc)
	if len(issues) != 2 {
		t.Fatalf("issues = %#v", issues)
	}
}
