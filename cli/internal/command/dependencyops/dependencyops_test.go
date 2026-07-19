package dependencyops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

type fakeClient struct {
	requests []Request
	do       func(Request) error
}

func (f *fakeClient) Do(_ context.Context, request Request) error {
	f.requests = append(f.requests, request)
	if f.do != nil {
		return f.do(request)
	}
	return nil
}

const catalogFixture = `{
	"categories": [
		{
			"category": "ai",
			"presets": [
				{"id": "openai_api", "name": "OpenAI API", "provider": "OpenAI", "enabled": true, "validated": true, "installed": true, "scope": null},
				{"id": "chatgpt", "name": "ChatGPT", "provider": "OpenAI", "enabled": true, "validated": true, "installed": false, "scope": null}
			]
		},
		{
			"category": "data",
			"presets": [
				{"id": "neon_database", "name": "Neon Database", "provider": "Neon", "enabled": true, "validated": true, "installed": false, "scope": {"kind": "required_options"}},
				{"id": "upstash_redis_regional", "name": "Upstash Redis Regional", "provider": "Upstash", "enabled": true, "validated": true, "installed": false, "scope": {"kind": "discovered_children", "required": true}},
				{"id": "upstash_redis_global", "name": "Upstash Redis Global", "provider": "Upstash", "enabled": true, "validated": true, "installed": false, "scope": {"kind": "discovered_children", "required": false}}
			]
		}
	]
}`

func TestCatalogUsesCanonicalEndpointAndScope(t *testing.T) {
	client := &fakeClient{do: func(r Request) error {
		doc := r.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "DependencyCatalog", Data: json.RawMessage(catalogFixture)}
		return nil
	}}
	var stdout bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &stdout, Format: func() string { return "table" }})
	cmd.SetArgs([]string{"catalog"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	request := client.requests[0]
	if request.Method != http.MethodGet || request.Path != "/api/v1/dependency-catalog" {
		t.Fatalf("request = %#v", request)
	}
	out := stdout.String()
	if !strings.Contains(out, "ID\tNAME\tCATEGORY\tPROVIDER\tREGION\tINSTALLED") {
		t.Fatalf("missing header: %q", out)
	}
	for _, row := range []string{
		"openai_api\tOpenAI API\tai\tOpenAI\t\tyes",
		"chatgpt\tChatGPT\tai\tOpenAI\t\t",
		"neon_database\tNeon Database\tdata\tNeon\trequired\t",
		"upstash_redis_regional\tUpstash Redis Regional\tdata\tUpstash\trequired\t",
		"upstash_redis_global\tUpstash Redis Global\tdata\tUpstash\t\t",
	} {
		if !strings.Contains(out, row) {
			t.Errorf("missing row %q in:\n%s", row, out)
		}
	}
}

func TestCatalogJSONPassesEnvelopeThrough(t *testing.T) {
	client := &fakeClient{do: func(r Request) error {
		doc := r.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "DependencyCatalog", Data: json.RawMessage(catalogFixture)}
		return nil
	}}
	var stdout bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &stdout, Format: func() string { return "json" }})
	cmd.SetArgs([]string{"catalog"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"kind": "DependencyCatalog"`) {
		t.Fatalf("output = %q", stdout.String())
	}
}

func TestCatalogMapsServerError(t *testing.T) {
	sentinel := errors.New("SCOPE_DENIED")
	mapped := errors.New("mapped")
	client := &fakeClient{do: func(Request) error { return sentinel }}
	cmd := NewGroup(Dependencies{Client: client, MapError: func(err error) error {
		if !errors.Is(err, sentinel) {
			t.Fatalf("mapped error = %v", err)
		}
		return mapped
	}})
	cmd.SetArgs([]string{"catalog"})
	if err := cmd.Execute(); !errors.Is(err, mapped) {
		t.Fatalf("error = %v", err)
	}
}

func setListResult(t *testing.T, result any, items []string, next *string) {
	t.Helper()
	doc, ok := result.(*ListEnvelope)
	if !ok {
		t.Fatalf("result type = %T", result)
	}
	doc.APIVersion, doc.Kind, doc.Meta.NextCursor = "v1", "DependencyList", next
	for _, item := range items {
		doc.Data = append(doc.Data, json.RawMessage(item))
	}
}

func TestListRejectsRepeatingCursor(t *testing.T) {
	// SEC-08: a repeated nextCursor must terminate the loop instead of looping.
	cycle := "cycle"
	calls := 0
	client := clientFunc(func(_ context.Context, r Request) error {
		calls++
		setListResult(t, r.Result, []string{`{"id":"dep-1"}`}, &cycle)
		return nil
	})
	_, err := List(context.Background(), client, 0, "", true)
	if err == nil {
		t.Fatal("expected a repeating cursor to be rejected")
	}
	var ce *Error
	if !errors.As(err, &ce) || ce.Code != "PAGINATION_LIMIT" {
		t.Fatalf("error = %#v", err)
	}
	if calls > 3 {
		t.Fatalf("made %d requests before detecting the cycle", calls)
	}
}

func TestListSendsCursorAndLimitAndRendersTable(t *testing.T) {
	dep1 := `{"id":"dep-1","catalogId":"vercel_runtime","name":"Vercel Runtime","provider":"Vercel","state":"OPERATIONAL","providerUpdatedAt":null,"activeIncidentTitle":null}`
	dep2 := `{"id":"dep-2","catalogId":"stripe_api","name":"Stripe API","provider":"Stripe","state":"DEGRADED","providerUpdatedAt":"2026-07-19T00:00:00Z","activeIncidentTitle":"Elevated error rates"}`
	client := &fakeClient{do: func(r Request) error {
		if got := r.Query.Get("cursor"); got != "start" {
			t.Errorf("cursor = %q", got)
		}
		setListResult(t, r.Result, []string{dep1, dep2}, nil)
		return nil
	}}
	var stdout, stderr bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &stdout, Err: &stderr, Format: func() string { return "table" }})
	cmd.SetArgs([]string{"list", "--cursor", "start"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	out := stdout.String()
	if !strings.Contains(out, "STATE\tNAME\tPROVIDER\tINCIDENT\tUPDATED") {
		t.Fatalf("missing header: %q", out)
	}
	if !strings.Contains(out, "OPERATIONAL\tVercel Runtime\tVercel\t\t") {
		t.Fatalf("missing operational row: %q", out)
	}
	if !strings.Contains(out, "DEGRADED\tStripe API\tStripe\tElevated error rates\t2026-07-19T00:00:00Z") {
		t.Fatalf("missing degraded row: %q", out)
	}
	// Provider reported caption belongs on stderr, never inside the piped table data.
	if strings.Contains(out, "provider reported") {
		t.Fatalf("caption leaked into stdout table data: %q", out)
	}
	if !strings.Contains(stderr.String(), "provider reported") {
		t.Fatalf("missing provider reported caption on stderr: %q", stderr.String())
	}
}

func TestListTSVKeepsCaptionOffStdout(t *testing.T) {
	dep1 := `{"id":"dep-1","catalogId":"vercel_runtime","name":"Vercel Runtime","provider":"Vercel","state":"OPERATIONAL","providerUpdatedAt":null,"activeIncidentTitle":null}`
	client := &fakeClient{do: func(r Request) error {
		setListResult(t, r.Result, []string{dep1}, nil)
		return nil
	}}
	var stdout, stderr bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &stdout, Err: &stderr, Format: func() string { return "tsv" }})
	cmd.SetArgs([]string{"list"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "OPERATIONAL\tVercel Runtime\tVercel\t\t") {
		t.Fatalf("missing tsv row: %q", stdout.String())
	}
	if strings.Contains(stdout.String(), "provider reported") {
		t.Fatalf("caption leaked into tsv stdout: %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "provider reported") {
		t.Fatalf("missing provider reported caption on stderr: %q", stderr.String())
	}
}

func TestListJSONHasNoProviderReportedCaption(t *testing.T) {
	dep1 := `{"id":"dep-1","catalogId":"vercel_runtime","name":"Vercel Runtime","provider":"Vercel","state":"OPERATIONAL","providerUpdatedAt":null,"activeIncidentTitle":null}`
	client := &fakeClient{do: func(r Request) error {
		setListResult(t, r.Result, []string{dep1}, nil)
		return nil
	}}
	var stdout, stderr bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &stdout, Err: &stderr, Format: func() string { return "json" }})
	cmd.SetArgs([]string{"list"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stdout.String(), "provider reported") || strings.Contains(stderr.String(), "provider reported") {
		t.Fatalf("json output must stay pure data: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), `"kind": "DependencyList"`) {
		t.Fatalf("output = %q", stdout.String())
	}
}

func TestListEmptyDataSerializesAsArray(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		setListResult(t, r.Result, nil, nil)
		return nil
	})
	doc, err := List(context.Background(), client, 0, "", true)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"data":[]`)) {
		t.Fatalf("output = %s", encoded)
	}
}

type clientFunc func(context.Context, Request) error

func (f clientFunc) Do(ctx context.Context, r Request) error { return f(ctx, r) }

func TestGetEscapesIDAndRendersDetail(t *testing.T) {
	detail := `{
		"id": "dep-1",
		"catalogId": "vercel_runtime",
		"name": "Vercel Runtime",
		"provider": "Vercel",
		"componentLabel": "us-east-1",
		"notificationsEnabled": true,
		"state": "DEGRADED",
		"checking": false,
		"lastSuccessfulPollAt": "2026-07-19T00:00:00Z",
		"canonicalUrl": "https://www.vercel-status.com/",
		"incidents": [
			{
				"id": "inc-1",
				"title": "Elevated error rates",
				"state": "investigating",
				"startedAt": "2026-07-18T23:00:00Z",
				"resolvedAt": null,
				"updates": [
					{"state": "investigating", "bodyText": "We are investigating.", "createdAt": "2026-07-18T23:00:00Z", "updatedAt": "2026-07-18T23:00:00Z"},
					{"state": "identified", "bodyText": "Root cause identified.", "createdAt": "2026-07-18T23:10:00Z", "updatedAt": "2026-07-18T23:10:00Z"}
				]
			},
			{
				"id": "inc-0",
				"title": "Past incident",
				"state": "resolved",
				"startedAt": "2026-07-01T00:00:00Z",
				"resolvedAt": "2026-07-01T01:00:00Z",
				"updates": []
			}
		]
	}`
	client := &fakeClient{do: func(r Request) error {
		doc := r.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "Dependency", Data: json.RawMessage(detail)}
		return nil
	}}
	var stdout bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &stdout, Format: func() string { return "table" }})
	cmd.SetArgs([]string{"get", "dep 1"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	request := client.requests[0]
	if request.Method != http.MethodGet || request.Path != "/api/v1/dependencies/dep%201" {
		t.Fatalf("request = %#v", request)
	}
	out := stdout.String()
	for _, want := range []string{
		"State         DEGRADED",
		"Source        Provider reported",
		"Provider      Vercel",
		"Component     Vercel Runtime",
		"Region        us-east-1",
		"Notifications enabled",
		"Last poll     2026-07-19T00:00:00Z",
		"Canonical URL https://www.vercel-status.com/",
		"Active incidents:",
		"Elevated error rates (investigating) started 2026-07-18T23:00:00Z",
		"We are investigating.",
		"Root cause identified.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Past incident") {
		t.Errorf("resolved incident should be trimmed from human output: %s", out)
	}
}

func TestGetJSONOutputUnaffectedByProviderReportedLabel(t *testing.T) {
	detail := `{"id":"dep-1","catalogId":"vercel_runtime","name":"Vercel Runtime","provider":"Vercel","state":"DEGRADED"}`
	client := &fakeClient{do: func(r Request) error {
		doc := r.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "Dependency", Data: json.RawMessage(detail)}
		return nil
	}}
	var stdout bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &stdout, Format: func() string { return "json" }})
	cmd.SetArgs([]string{"get", "dep-1"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var envelope Envelope
	if err := json.Unmarshal(stdout.Bytes(), &envelope); err != nil {
		t.Fatalf("output is not valid json: %v", err)
	}
	var got, want map[string]any
	if err := json.Unmarshal(envelope.Data, &got); err != nil {
		t.Fatalf("data is not valid json: %v", err)
	}
	if err := json.Unmarshal([]byte(detail), &want); err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("json data must pass through unchanged: got %#v, want %#v", got, want)
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("field %s = %#v, want %#v", key, got[key], value)
		}
	}
	if strings.Contains(stdout.String(), "Provider reported") {
		t.Fatalf("json output must stay pure data: %q", stdout.String())
	}
}

func TestAddSendsBodyAndRendersCreatedDependency(t *testing.T) {
	created := `{"id":"dep-9","catalogId":"neon_database","name":"Neon Database","provider":"Neon","state":"UNKNOWN","checking":true,"notificationsEnabled":false}`
	client := &fakeClient{do: func(r Request) error {
		doc := r.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "Dependency", Data: json.RawMessage(created)}
		return nil
	}}
	var stdout bytes.Buffer
	cmd := NewGroup(Dependencies{
		Client: client, Out: &stdout, Format: func() string { return "json" },
		NewID: func() (string, error) { return "idem-add", nil },
	})
	cmd.SetArgs([]string{"add", "neon_database", "--scope", "aws-us-east-1", "--no-notifications"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	request := client.requests[0]
	if request.Method != http.MethodPost || request.Path != "/api/v1/dependencies" || request.IdempotencyKey != "idem-add" {
		t.Fatalf("request = %#v", request)
	}
	body, ok := request.Body.(map[string]any)
	if !ok {
		t.Fatalf("body type = %T", request.Body)
	}
	if body["presetId"] != "neon_database" || body["scopeId"] != "aws-us-east-1" || body["notificationsEnabled"] != false {
		t.Fatalf("body = %#v", body)
	}
	if !strings.Contains(stdout.String(), `"kind": "Dependency"`) {
		t.Fatalf("output = %q", stdout.String())
	}
}

func TestAddOmitsOptionalFieldsWhenNotSet(t *testing.T) {
	client := &fakeClient{do: func(r Request) error {
		doc := r.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "Dependency", Data: json.RawMessage(`{"id":"dep-1"}`)}
		return nil
	}}
	cmd := NewGroup(Dependencies{Client: client, NewID: func() (string, error) { return "idem-1", nil }})
	cmd.SetArgs([]string{"add", "vercel_runtime"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	body := client.requests[0].Body.(map[string]any)
	if _, present := body["scopeId"]; present {
		t.Fatalf("scopeId should be omitted: %#v", body)
	}
	if _, present := body["notificationsEnabled"]; present {
		t.Fatalf("notificationsEnabled should be omitted: %#v", body)
	}
	if body["presetId"] != "vercel_runtime" {
		t.Fatalf("body = %#v", body)
	}
}

func TestAddMapsDuplicateConflict(t *testing.T) {
	sentinel := errors.New("DEPENDENCY_EXISTS")
	mapped := errors.New("mapped-conflict")
	client := &fakeClient{do: func(Request) error { return sentinel }}
	cmd := NewGroup(Dependencies{Client: client, NewID: func() (string, error) { return "idem-2", nil }, MapError: func(err error) error {
		if !errors.Is(err, sentinel) {
			t.Fatalf("mapped error = %v", err)
		}
		return mapped
	}})
	cmd.SetArgs([]string{"add", "vercel_runtime"})
	if err := cmd.Execute(); !errors.Is(err, mapped) {
		t.Fatalf("error = %v", err)
	}
}

func TestRemoveRequiresYesWhenNoninteractive(t *testing.T) {
	client := &fakeClient{}
	cmd := NewGroup(Dependencies{Client: client, StdinTTY: false, NewID: func() (string, error) { return "unused", nil }})
	cmd.SetArgs([]string{"remove", "dep-1"})
	err := cmd.Execute()
	var cliErr *Error
	if !errors.As(err, &cliErr) || cliErr.Exit != 2 || cliErr.Code != "INVALID_ARGUMENT" {
		t.Fatalf("error = %#v", err)
	}
	if len(client.requests) != 0 {
		t.Fatalf("unexpected requests: %#v", client.requests)
	}
}

func TestRemovePromptCancellationMakesNoRequest(t *testing.T) {
	client := &fakeClient{}
	var stderr bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, In: strings.NewReader("no\n"), Err: &stderr, StdinTTY: true, NewID: func() (string, error) { return "unused", nil }})
	cmd.SetArgs([]string{"remove", "dep-1"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 0 || !strings.Contains(stderr.String(), "Canceled") {
		t.Fatalf("requests = %#v, stderr = %q", client.requests, stderr.String())
	}
}

func TestRemoveConfirmedSendsDeleteAndPrintsStderrConfirmation(t *testing.T) {
	var stdout, stderr bytes.Buffer
	client := &fakeClient{do: func(Request) error { return nil }}
	cmd := NewGroup(Dependencies{
		Client: client, Out: &stdout, Err: &stderr, Format: func() string { return "json" },
		NewID: func() (string, error) { return "idem-remove", nil },
	})
	cmd.SetArgs([]string{"remove", "dep-1", "--yes"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	request := client.requests[0]
	if request.Method != http.MethodDelete || request.Path != "/api/v1/dependencies/dep-1" || request.IdempotencyKey != "idem-remove" {
		t.Fatalf("request = %#v", request)
	}
	if stdout.String() != "" {
		t.Fatalf("stdout should stay empty on a 204 removal: %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "Removed dependency dep-1") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRemoveMapsNotFound(t *testing.T) {
	sentinel := errors.New("DEPENDENCY_NOT_FOUND")
	mapped := errors.New("mapped-not-found")
	client := &fakeClient{do: func(Request) error { return sentinel }}
	cmd := NewGroup(Dependencies{Client: client, NewID: func() (string, error) { return "idem-3", nil }, MapError: func(err error) error {
		if !errors.Is(err, sentinel) {
			t.Fatalf("mapped error = %v", err)
		}
		return mapped
	}})
	cmd.SetArgs([]string{"remove", "dep-1", "--yes"})
	if err := cmd.Execute(); !errors.Is(err, mapped) {
		t.Fatalf("error = %v", err)
	}
}

func TestGroupTreeAndScopes(t *testing.T) {
	cmd := NewGroup(Dependencies{})
	names := map[string]string{}
	for _, child := range cmd.Commands() {
		names[child.Name()] = child.Annotations["requiredScope"]
	}
	want := map[string]string{
		"catalog": "dependencies:read",
		"list":    "dependencies:read",
		"get":     "dependencies:read",
		"add":     "dependencies:write",
		"remove":  "dependencies:write",
	}
	for name, scope := range want {
		if names[name] != scope {
			t.Errorf("%s scope = %q, want %q", name, names[name], scope)
		}
	}
	for _, child := range cmd.Commands() {
		if child.Annotations["supportsOutput"] == "" {
			t.Errorf("%s missing supportsOutput annotation", child.Name())
		}
	}
}
