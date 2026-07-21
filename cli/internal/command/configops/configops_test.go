package configops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
type fakeTransport struct {
	calls []call
	etag  string
	plan  Plan
}

func (f *fakeTransport) Do(_ context.Context, method, path string, body any, headers http.Header, out any) (http.Header, error) {
	f.calls = append(f.calls, call{method, path, body, headers.Clone()})
	switch path {
	case "/api/v1/config":
		if target, ok := out.(*envelope); ok {
			target.APIVersion, target.Kind, target.Data = "v1", "Configuration", json.RawMessage(`{"version":2,"settings":{},"groups":[],"monitors":[]}`)
		}
		headers := make(http.Header)
		etag := f.etag
		if etag == "" {
			etag = `"sha256:base"`
		}
		headers.Set("ETag", etag)
		return headers, nil
	case "/api/v1/config/plan":
		target := out.(*planEnvelope)
		target.APIVersion, target.Kind = "v1", "ConfigurationPlan"
		target.Data = f.plan
		if target.Data.BaseConfigHash == "" {
			target.Data.BaseConfigHash = "sha256:base"
		}
		if target.Data.TargetConfigHash == "" {
			target.Data.TargetConfigHash = "sha256:target"
		}
		if target.Data.PlanHash == "" {
			target.Data.PlanHash = "sha256:plan"
		}
	case "/api/v1/config/apply":
		target := out.(*map[string]any)
		*target = map[string]any{"apiVersion": "v1", "kind": "ConfigurationOperation", "data": map[string]any{"id": "op", "state": "written"}}
	}
	return nil, nil
}

type errorTransport struct{ err error }

func (e *errorTransport) Do(context.Context, string, string, any, http.Header, any) (http.Header, error) {
	return nil, e.err
}

func validConfig() string { return "version: 2\nsettings: {}\ngroups: []\nmonitors: []\n" }

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
	if body["allowDestructiveChanges"] != false {
		t.Fatalf("compatibility consent fields = %#v", body)
	}
}

func TestApplyRequiresExplicitConsentForTripwireOnlyPlan(t *testing.T) {
	client := &fakeTransport{plan: Plan{
		DestructiveConsentRequired: true,
		DestructiveChange: DestructiveChange{Reasons: []DestructiveChangeReason{{
			Type:                "all-active-monitors-removed",
			PreviousActiveCount: 3,
		}}},
	}}
	cmd := NewCommand(Dependencies{
		Client:   client,
		In:       strings.NewReader(validConfig()),
		Out:      io.Discard,
		StdinTTY: false,
		Output:   func(string) string { return "json" },
	})
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetArgs([]string{"apply", "--file", "-", "--no-wait"})
	err := cmd.Execute()
	var got *Error
	if !errors.As(err, &got) || got.Code != "INVALID_ARGUMENT" || !strings.Contains(got.Message, "--allow-destructive") {
		t.Fatalf("error = %#v", err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("calls = %d, want plan only", len(client.calls))
	}
}

func TestApplySendsNewAndCompatibilityConsentFields(t *testing.T) {
	client := &fakeTransport{plan: Plan{DestructiveConsentRequired: true}}
	cmd := NewCommand(Dependencies{
		Client:   client,
		In:       strings.NewReader(validConfig()),
		Out:      io.Discard,
		StdinTTY: false,
		Output:   func(string) string { return "json" },
	})
	cmd.SetArgs([]string{"apply", "--file", "-", "--allow-destructive", "--yes", "--no-wait"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	body := client.calls[2].body.(map[string]any)
	if body["allowDestructiveChanges"] != true {
		t.Fatalf("consent fields = %#v", body)
	}
}

func TestApplyExplainsTripwireReasonsBeforeInteractiveConsent(t *testing.T) {
	client := &fakeTransport{plan: Plan{
		DestructiveConsentRequired: true,
		DestructiveChange: DestructiveChange{Reasons: []DestructiveChangeReason{{
			Type:                "removed-monitor-percentage",
			RemovedCount:        2,
			PreviousActiveCount: 4,
			Percentage:          50,
		}}},
	}}
	var prompts bytes.Buffer
	cmd := NewCommand(Dependencies{
		Client:   client,
		In:       strings.NewReader("yes\n"),
		Out:      io.Discard,
		Err:      &prompts,
		StdinTTY: true,
		Output:   func(string) string { return "json" },
		OpenFile: func(string) (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader(validConfig())), nil
		},
	})
	cmd.SetArgs([]string{"apply", "--file", "config.yaml", "--no-wait"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(prompts.String(), "2 of 4 active monitors would be removed (50.0%)") {
		t.Fatalf("prompt = %q", prompts.String())
	}
}

func TestAllowDeleteFlagIsRetired(t *testing.T) {
	cmd := NewCommand(Dependencies{})
	apply, _, err := cmd.Find([]string{"apply"})
	if err != nil {
		t.Fatal(err)
	}
	if flag := apply.Flags().Lookup("allow-delete"); flag != nil {
		t.Fatalf("allow-delete flag = %#v", flag)
	}
}

func TestReadDocumentRejectsOversize(t *testing.T) {
	_, err := ReadDocument(defaults(Dependencies{In: io.LimitReader(strings.NewReader(strings.Repeat("x", MaxDocumentBytes+2)), MaxDocumentBytes+2)}), "-")
	if err == nil || !strings.Contains(err.Error(), "55 KB") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateSendsSemanticallyInvalidDocumentToServer(t *testing.T) {
	client := &fakeTransport{}
	cmd := NewCommand(Dependencies{Client: client, In: strings.NewReader("version: 1\nsettings:\n  defaultTimeoutMs: 20\nmonitors:\n  - {id: api, name: API, url: https://a}\n  - {id: api, name: API2, url: https://b}\n"), Out: io.Discard, Output: func(string) string { return "json" }})
	cmd.SetArgs([]string{"validate", "--file", "-"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.calls) != 1 || client.calls[0].path != "/api/v1/config/validate" {
		t.Fatalf("calls = %#v", client.calls)
	}
}

func TestValidatePropagatesServerErrors(t *testing.T) {
	client := &errorTransport{err: &Error{Exit: 2, Code: "INVALID_CONFIGURATION", Message: "configuration is invalid"}}
	cmd := NewCommand(Dependencies{Client: client, In: strings.NewReader(validConfig()), Out: io.Discard, Output: func(string) string { return "json" }})
	cmd.SetArgs([]string{"validate", "--file", "-"})
	err := cmd.Execute()
	var got *Error
	if !errors.As(err, &got) || got.Code != "INVALID_CONFIGURATION" {
		t.Fatalf("err = %#v", err)
	}
}

func TestReadDocumentUpgradesV1GroupsDeterministically(t *testing.T) {
	doc, err := ReadDocument(defaults(Dependencies{In: strings.NewReader(`version: 1
settings: {}
monitors:
  - {id: web, name: Web, url: https://web.example, group: Production}
  - {id: api, name: API, url: https://api.example, group: Production}
  - {id: jobs, name: Jobs, url: https://jobs.example, group: null}
`)}), "-")
	if err != nil {
		t.Fatal(err)
	}
	if doc["version"] != float64(2) {
		t.Fatalf("version = %v", doc["version"])
	}
	groups := doc["groups"].([]any)
	if len(groups) != 1 {
		t.Fatalf("groups = %#v", groups)
	}
	group := groups[0].(map[string]any)
	if group["id"] != "group-ab8e18ef4ebe" || group["name"] != "Production" {
		t.Fatalf("group = %#v", group)
	}
	monitors := doc["monitors"].([]any)
	if monitors[0].(map[string]any)["id"] != "api" || monitors[0].(map[string]any)["groupId"] != group["id"] {
		t.Fatalf("monitors = %#v", monitors)
	}
	if monitors[1].(map[string]any)["groupId"] != nil {
		t.Fatalf("ungrouped monitor = %#v", monitors[1])
	}
	if _, exists := monitors[2].(map[string]any)["group"]; exists {
		t.Fatal("legacy group field survived upgrade")
	}
}

func TestReadDocumentFoldsV1GroupNameCaseVariants(t *testing.T) {
	doc, err := ReadDocument(defaults(Dependencies{In: strings.NewReader(`version: 1
settings: {}
monitors:
  - {id: one, name: One, url: https://one.example, group: Production}
  - {id: two, name: Two, url: https://two.example, group: production}
`)}), "-")
	if err != nil {
		t.Fatal(err)
	}
	groups := doc["groups"].([]any)
	monitors := doc["monitors"].([]any)
	if len(groups) != 1 || groups[0].(map[string]any)["name"] != "Production" {
		t.Fatalf("groups = %#v", groups)
	}
	if monitors[0].(map[string]any)["groupId"] != monitors[1].(map[string]any)["groupId"] {
		t.Fatalf("monitors = %#v", monitors)
	}
}

func TestPlanSendsUpgradedV2Target(t *testing.T) {
	client := &fakeTransport{}
	cmd := NewCommand(Dependencies{Client: client, In: strings.NewReader("version: 1\nsettings: {}\nmonitors: []\n"), Out: io.Discard, Output: func(string) string { return "json" }})
	cmd.SetArgs([]string{"plan", "--file", "-"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	body := client.calls[1].body.(map[string]any)
	target := body["targetConfig"].(map[string]any)
	if target["version"] != float64(2) || target["groups"] == nil {
		t.Fatalf("targetConfig = %#v", target)
	}
}

func TestPlanNormalizesWeakConfigurationETag(t *testing.T) {
	client := &fakeTransport{etag: `W/"sha256:base"`}
	cmd := NewCommand(Dependencies{Client: client, In: strings.NewReader(validConfig()), Out: io.Discard, Output: func(string) string { return "json" }})
	cmd.SetArgs([]string{"plan", "--file", "-"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	body := client.calls[1].body.(map[string]any)
	if body["baseConfigHash"] != "sha256:base" {
		t.Fatalf("baseConfigHash = %q", body["baseConfigHash"])
	}
}
