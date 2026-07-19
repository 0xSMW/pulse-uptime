package reportops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

type clientFunc func(context.Context, Request) error

func (f clientFunc) Do(ctx context.Context, r Request) error { return f(ctx, r) }

func newID() (string, error) { return "11111111-2222-4333-8444-555555555555", nil }

func run(t *testing.T, d Dependencies, args ...string) error {
	t.Helper()
	cmd := NewGroup(d)
	cmd.SetArgs(args)
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	return cmd.Execute()
}

// TestReportGroupScopes checks every subcommand's advertised scope against
// what it calls. resolve GETs (reports:read) before POSTing its closing
// update (reports:write), so it needs both. list/get are pure reads; the
// rest never read before mutating, so reports:write alone is correct.
func TestReportGroupScopes(t *testing.T) {
	cmd := NewGroup(Dependencies{})
	want := map[string]string{
		"list":        "reports:read",
		"get":         "reports:read",
		"create":      "reports:write",
		"update":      "reports:write",
		"post":        "reports:write",
		"edit-update": "reports:write",
		"delete":      "reports:write",
		"resolve":     "reports:read,reports:write",
		"publish":     "reports:write",
	}
	got := map[string]string{}
	for _, child := range cmd.Commands() {
		name := strings.Fields(child.Use)[0]
		got[name] = child.Annotations["requiredScope"]
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scopes = %#v, want %#v", got, want)
	}
}

func TestListSendsFiltersAndPaginates(t *testing.T) {
	var queries []url.Values
	next := "page2"
	client := clientFunc(func(_ context.Context, r Request) error {
		if r.Method != "GET" || r.Path != "/api/v1/status-reports" {
			t.Fatalf("unexpected request %s %s", r.Method, r.Path)
		}
		queries = append(queries, r.Query)
		doc := r.Result.(*ListEnvelope)
		doc.APIVersion = "v1"
		doc.Kind = "StatusReportList"
		if len(queries) == 1 {
			doc.Data = []json.RawMessage{json.RawMessage(`{"id":"rep_1"}`)}
			doc.Meta.NextCursor = &next
		} else {
			doc.Data = []json.RawMessage{json.RawMessage(`{"id":"rep_2"}`)}
		}
		return nil
	})
	doc, err := List(context.Background(), client, ListOptions{State: "resolved", Type: "incident", Machine: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Data) != 2 {
		t.Fatalf("records=%d", len(doc.Data))
	}
	if queries[0].Get("state") != "resolved" || queries[0].Get("type") != "incident" {
		t.Fatalf("first query=%v", queries[0])
	}
	if queries[1].Get("cursor") != "page2" || queries[1].Get("state") != "resolved" {
		t.Fatalf("second query=%v", queries[1])
	}
}

func TestListRejectsInvalidFilters(t *testing.T) {
	for _, args := range [][]string{{"list", "--state", "open"}, {"list", "--type", "outage"}} {
		err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("request sent"); return nil })}, args...)
		var typed *Error
		if !errors.As(err, &typed) || typed.Exit != ExitInvalidInput {
			t.Fatalf("args=%v err=%v", args, err)
		}
	}
}

func TestListRendersTableWithStateGlyphs(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		doc := r.Result.(*ListEnvelope)
		doc.APIVersion = "v1"
		doc.Kind = "StatusReportList"
		doc.Data = []json.RawMessage{
			json.RawMessage(`{"id":"rep_1","type":"incident","title":"API outage","publishedAt":null,"resolvedAt":null,"currentStatus":"investigating","updatedAt":"2026-07-18T04:00:00Z"}`),
			json.RawMessage(`{"id":"rep_2","type":"incident","title":"DB failover","publishedAt":"2026-07-18T01:00:00Z","resolvedAt":null,"currentStatus":"monitoring","updatedAt":"2026-07-18T05:00:00Z"}`),
			json.RawMessage(`{"id":"rep_3","type":"maintenance","title":"Cache purge","publishedAt":"2026-07-17T01:00:00Z","resolvedAt":"2026-07-17T02:00:00Z","currentStatus":"completed","updatedAt":"2026-07-18T06:00:00Z"}`),
		}
		return nil
	})
	var out bytes.Buffer
	err := run(t, Dependencies{Client: client, Out: &out, Format: func() string { return "table" }}, "list")
	if err != nil {
		t.Fatal(err)
	}
	want := "STATUS\tTITLE\tTYPE\tCURRENT\tUPDATED\n" +
		"○ Draft\tAPI outage\tincident\tinvestigating\t2026-07-18T04:00:00Z\n" +
		"● Ongoing\tDB failover\tincident\tmonitoring\t2026-07-18T05:00:00Z\n" +
		"✓ Resolved\tCache purge\tmaintenance\tcompleted\t2026-07-18T06:00:00Z\n"
	if out.String() != want {
		t.Fatalf("table = %q", out.String())
	}
}

func TestGetRendersDetailTimelineAndAffected(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		if r.Path != "/api/v1/status-reports/rep_1" {
			t.Fatalf("path=%q", r.Path)
		}
		doc := r.Result.(*Envelope)
		doc.APIVersion = "v1"
		doc.Kind = "StatusReport"
		doc.Data = json.RawMessage(`{
			"id":"rep_1","type":"incident","title":"API outage",
			"startsAt":"2026-07-18T02:00:00Z","endsAt":null,
			"publishedAt":"2026-07-18T02:05:00Z","resolvedAt":null,
			"originIncidentId":"inc_9","currentStatus":"monitoring",
			"updates":[
				{"id":"upd_2","status":"monitoring","markdown":"A fix is deployed.","publishedAt":"2026-07-18T03:00:00Z"},
				{"id":"upd_1","status":"investigating","markdown":"We are investigating.\nMore soon.","publishedAt":"2026-07-18T02:05:00Z"}
			],
			"affected":[{"monitorId":"api-prod","monitorName":"API","groupName":"Core","impact":"down"}]
		}`)
		return nil
	})
	var out bytes.Buffer
	err := run(t, Dependencies{Client: client, Out: &out, Format: func() string { return "table" }}, "get", "rep_1")
	if err != nil {
		t.Fatal(err)
	}
	want := "ID         rep_1\n" +
		"Title      API outage\n" +
		"Type       incident\n" +
		"State      ● Ongoing\n" +
		"Current    monitoring\n" +
		"Starts     2026-07-18T02:00:00Z\n" +
		"Published  2026-07-18T02:05:00Z\n" +
		"Resolved   -\n" +
		"Origin     inc_9\n" +
		"\nAffected:\n" +
		"  MONITOR\tNAME\tGROUP\tIMPACT\n" +
		"  api-prod\tAPI\tCore\tdown\n" +
		"\nUpdates:\n" +
		"  2026-07-18T03:00:00Z  monitoring  (upd_2)\n" +
		"    A fix is deployed.\n" +
		"  2026-07-18T02:05:00Z  investigating  (upd_1)\n" +
		"    We are investigating.\n" +
		"    More soon.\n"
	if out.String() != want {
		t.Fatalf("detail = %q", out.String())
	}
}

func TestCreateSendsInitialUpdateAffectedAndDraft(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.APIVersion = "v1"
		doc.Kind = "StatusReport"
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID},
		"create", "--type", "incident", "--title", "API outage", "--status", "investigating",
		"--message", "Looking into it.", "--affected", "api-prod:down", "--affected", "web:degraded",
		"--starts-at", "2026-07-18T02:00:00Z", "--draft")
	if err != nil {
		t.Fatal(err)
	}
	if captured.Method != "POST" || captured.Path != "/api/v1/status-reports" || captured.IdempotencyKey == "" {
		t.Fatalf("request=%+v", captured)
	}
	encoded, _ := json.Marshal(captured.Body)
	for _, want := range []string{`"type":"incident"`, `"title":"API outage"`, `"draft":true`, `"startsAt":"2026-07-18T02:00:00Z"`, `"update":{"markdown":"Looking into it.","status":"investigating"}`, `"monitorId":"api-prod"`, `"impact":"degraded"`} {
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("body %s missing %s", encoded, want)
		}
	}
}

func TestCreateReadsMessageFromStdin(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, In: strings.NewReader("From stdin.\n"), Format: func() string { return "json" }, NewID: newID},
		"create", "--type", "maintenance", "--title", "Upgrade", "--status", "scheduled", "--message-file", "-")
	if err != nil {
		t.Fatal(err)
	}
	body := captured.Body.(map[string]any)
	update := body["update"].(map[string]any)
	if update["markdown"] != "From stdin." || update["status"] != "scheduled" {
		t.Fatalf("update=%v", update)
	}
}

func TestCreateRejectsStatusFromWrongFamily(t *testing.T) {
	err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("request sent"); return nil }), NewID: newID},
		"create", "--type", "incident", "--title", "x", "--status", "in_progress", "--message", "y")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != ExitInvalidInput {
		t.Fatalf("err=%v", err)
	}
}

func TestUpdateRequiresAtLeastOneFlagAndReplacesAffected(t *testing.T) {
	if err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { return nil }), NewID: newID}, "update", "rep_1"); err == nil {
		t.Fatal("expected error without flags")
	}
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID},
		"update", "rep_1", "--title", "New title", "--affected", "api-prod:maintenance", "--ends-at", "2026-07-19T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if captured.Method != "PATCH" || captured.Path != "/api/v1/status-reports/rep_1" {
		t.Fatalf("request=%+v", captured)
	}
	encoded, _ := json.Marshal(captured.Body)
	if !strings.Contains(string(encoded), `"title":"New title"`) || !strings.Contains(string(encoded), `"impact":"maintenance"`) || !strings.Contains(string(encoded), `"endsAt":"2026-07-19T00:00:00Z"`) {
		t.Fatalf("body=%s", encoded)
	}
}

func TestUpdateEmptyEndsAtClearsMaintenanceWindow(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID},
		"update", "rep_1", "--ends-at", "")
	if err != nil {
		t.Fatal(err)
	}
	value, present := captured.Body.(map[string]any)["endsAt"]
	if !present || value != nil {
		t.Fatalf("endsAt=%v present=%v", value, present)
	}
	encoded, _ := json.Marshal(captured.Body)
	if !strings.Contains(string(encoded), `"endsAt":null`) {
		t.Fatalf("body=%s", encoded)
	}
}

func TestUpdateAffectedNoneSendsEmptySet(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID},
		"update", "rep_1", "--affected", "none")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(captured.Body)
	if !strings.Contains(string(encoded), `"affected":[]`) {
		t.Fatalf("body=%s", encoded)
	}
}

func TestAffectedNoneCannotMixWithOtherValues(t *testing.T) {
	err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("request sent"); return nil }), NewID: newID},
		"update", "rep_1", "--affected", "none", "--affected", "api-prod:down")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != ExitInvalidInput {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(typed.Message, "none") {
		t.Fatalf("message=%q", typed.Message)
	}
}

func TestCreateBackdatesInitialUpdateWithPublishedAt(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID},
		"create", "--type", "incident", "--title", "API outage", "--status", "investigating",
		"--message", "Looking into it.", "--published-at", "2026-07-17T22:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	update := captured.Body.(map[string]any)["update"].(map[string]any)
	if update["publishedAt"] != "2026-07-17T22:00:00Z" {
		t.Fatalf("update=%v", update)
	}
}

func TestCreateRejectsInvalidPublishedAt(t *testing.T) {
	err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("request sent"); return nil }), NewID: newID},
		"create", "--type", "incident", "--title", "x", "--status", "investigating", "--message", "y", "--published-at", "yesterday")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != ExitInvalidInput {
		t.Fatalf("err=%v", err)
	}
}

func TestEnvelopeMetaShapes(t *testing.T) {
	object, err := json.Marshal(Envelope{APIVersion: "v1", Kind: "StatusReport", Data: json.RawMessage(`{}`), Meta: Meta{RequestID: "req_1"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(object), "nextCursor") {
		t.Fatalf("object meta must omit nextCursor: %s", object)
	}
	list, err := json.Marshal(ListEnvelope{APIVersion: "v1", Kind: "StatusReportList", Data: []json.RawMessage{}, Meta: ListMeta{RequestID: "req_1"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(list), `"nextCursor":null`) {
		t.Fatalf("list meta must emit nextCursor: %s", list)
	}
}

func TestPostSendsUpdateWithPublishedAt(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"upd_9"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID},
		"post", "rep_1", "--status", "monitoring", "--message", "Watching.", "--published-at", "2026-07-18T03:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if captured.Method != "POST" || captured.Path != "/api/v1/status-reports/rep_1/updates" {
		t.Fatalf("request=%+v", captured)
	}
	body := captured.Body.(map[string]any)
	if body["status"] != "monitoring" || body["markdown"] != "Watching." || body["publishedAt"] != "2026-07-18T03:00:00Z" {
		t.Fatalf("body=%v", body)
	}
}

func TestPostRejectsInvalidTimestamp(t *testing.T) {
	err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("request sent"); return nil }), NewID: newID},
		"post", "rep_1", "--status", "monitoring", "--message", "x", "--published-at", "yesterday")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != ExitInvalidInput {
		t.Fatalf("err=%v", err)
	}
}

func TestEditUpdatePatchesOnlyChangedFields(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"upd_1"}`)
		return nil
	})
	err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID},
		"edit-update", "rep_1", "upd_1", "--published-at", "2026-07-18T01:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if captured.Method != "PATCH" || captured.Path != "/api/v1/status-reports/rep_1/updates/upd_1" {
		t.Fatalf("request=%+v", captured)
	}
	body := captured.Body.(map[string]any)
	if len(body) != 1 || body["publishedAt"] != "2026-07-18T01:00:00Z" {
		t.Fatalf("body=%v", body)
	}
}

func TestDeleteNoninteractiveRequiresYes(t *testing.T) {
	err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("request sent"); return nil }), NewID: newID}, "delete", "rep_1")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != ExitInvalidInput {
		t.Fatalf("err=%v", err)
	}
}

func TestDeleteWithYesSendsDeleteAndPreservesServerEnvelope(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.APIVersion = "v1"
		doc.Kind = "StatusReportDeleted"
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		doc.Meta.RequestID = "req_del"
		return nil
	})
	var out bytes.Buffer
	err := run(t, Dependencies{Client: client, Out: &out, Format: func() string { return "json" }, NewID: newID}, "delete", "rep_1", "--yes")
	if err != nil {
		t.Fatal(err)
	}
	if captured.Method != "DELETE" || captured.Path != "/api/v1/status-reports/rep_1" || captured.IdempotencyKey == "" {
		t.Fatalf("request=%+v", captured)
	}
	if !strings.Contains(out.String(), `"kind": "StatusReportDeleted"`) || !strings.Contains(out.String(), `"requestId": "req_del"`) {
		t.Fatalf("output=%s", out.String())
	}
	if strings.Contains(out.String(), "nextCursor") {
		t.Fatalf("object envelope must omit nextCursor: %s", out.String())
	}
}

func TestDeleteRendersOneLineConfirmation(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		doc := r.Result.(*Envelope)
		doc.APIVersion = "v1"
		doc.Kind = "StatusReportDeleted"
		doc.Data = json.RawMessage(`{"id":"rep_1"}`)
		doc.Meta.RequestID = "req_del"
		return nil
	})
	var out bytes.Buffer
	if err := run(t, Dependencies{Client: client, Out: &out, Format: func() string { return "table" }, NewID: newID}, "delete", "rep_1", "--yes"); err != nil {
		t.Fatal(err)
	}
	if out.String() != "Deleted status report rep_1\n" {
		t.Fatalf("output=%q", out.String())
	}
	out.Reset()
	if err := run(t, Dependencies{Client: client, Out: &out, Format: func() string { return "tsv" }, NewID: newID}, "delete", "rep_1", "--yes"); err != nil {
		t.Fatal(err)
	}
	if out.String() != "rep_1\tdeleted\n" {
		t.Fatalf("tsv output=%q", out.String())
	}
}

func TestDeleteWithoutServerEnvelopeStillConfirms(t *testing.T) {
	client := clientFunc(func(context.Context, Request) error { return nil })
	var out bytes.Buffer
	if err := run(t, Dependencies{Client: client, Out: &out, Format: func() string { return "table" }, NewID: newID}, "delete", "rep_9", "--yes"); err != nil {
		t.Fatal(err)
	}
	if out.String() != "Deleted status report rep_9\n" {
		t.Fatalf("output=%q", out.String())
	}
}

func TestResolvePicksClosingStatusByType(t *testing.T) {
	cases := []struct{ reportType, wantStatus, wantMarkdown string }{
		{"incident", "resolved", "Resolved."},
		{"maintenance", "completed", "Completed."},
	}
	for _, tc := range cases {
		var posted Request
		client := clientFunc(func(_ context.Context, r Request) error {
			if r.Method == "GET" {
				doc := r.Result.(*Envelope)
				doc.Data = json.RawMessage(`{"id":"rep_1","type":"` + tc.reportType + `"}`)
				return nil
			}
			posted = r
			doc := r.Result.(*Envelope)
			doc.Data = json.RawMessage(`{"id":"upd_9"}`)
			return nil
		})
		if err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID}, "resolve", "rep_1"); err != nil {
			t.Fatal(err)
		}
		if posted.Path != "/api/v1/status-reports/rep_1/updates" {
			t.Fatalf("path=%q", posted.Path)
		}
		body := posted.Body.(map[string]any)
		if body["status"] != tc.wantStatus || body["markdown"] != tc.wantMarkdown {
			t.Fatalf("type=%s body=%v", tc.reportType, body)
		}
	}
}

func TestResolveUsesProvidedMessage(t *testing.T) {
	var posted Request
	client := clientFunc(func(_ context.Context, r Request) error {
		if r.Method == "GET" {
			doc := r.Result.(*Envelope)
			doc.Data = json.RawMessage(`{"id":"rep_1","type":"incident"}`)
			return nil
		}
		posted = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"upd_9"}`)
		return nil
	})
	if err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID}, "resolve", "rep_1", "--message", "All clear."); err != nil {
		t.Fatal(err)
	}
	if posted.Body.(map[string]any)["markdown"] != "All clear." {
		t.Fatalf("body=%v", posted.Body)
	}
}

func TestPublishPostsToPublishPath(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.Data = json.RawMessage(`{"id":"rep_1","publishedAt":"2026-07-18T04:00:00Z"}`)
		return nil
	})
	if err := run(t, Dependencies{Client: client, Format: func() string { return "json" }, NewID: newID}, "publish", "rep_1"); err != nil {
		t.Fatal(err)
	}
	if captured.Method != "POST" || captured.Path != "/api/v1/status-reports/rep_1/publish" || captured.IdempotencyKey == "" {
		t.Fatalf("request=%+v", captured)
	}
}

func TestPromotePostsAndRendersDraft(t *testing.T) {
	var captured Request
	client := clientFunc(func(_ context.Context, r Request) error {
		captured = r
		doc := r.Result.(*Envelope)
		doc.APIVersion = "v1"
		doc.Kind = "StatusReport"
		doc.Data = json.RawMessage(`{"id":"rep_7","type":"incident","title":"api-prod outage","publishedAt":null,"resolvedAt":null,"currentStatus":"investigating","originIncidentId":"inc_3","startsAt":"2026-07-18T01:00:00Z"}`)
		return nil
	})
	var out bytes.Buffer
	cmd := NewPromoteCommand(Dependencies{Client: client, Out: &out, Format: func() string { return "table" }, NewID: newID})
	cmd.SetArgs([]string{"inc_3"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if captured.Method != "POST" || captured.Path != "/api/v1/incidents/inc_3/promote" || captured.IdempotencyKey == "" {
		t.Fatalf("request=%+v", captured)
	}
	if !strings.Contains(out.String(), "State      ○ Draft") || !strings.Contains(out.String(), "Origin     inc_3") {
		t.Fatalf("output=%q", out.String())
	}
}

func TestMessageAndMessageFileCannotBeCombined(t *testing.T) {
	err := run(t, Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("request sent"); return nil }), NewID: newID},
		"post", "rep_1", "--status", "monitoring", "--message", "a", "--message-file", "b.md")
	var typed *Error
	if !errors.As(err, &typed) || typed.Exit != ExitInvalidInput {
		t.Fatalf("err=%v", err)
	}
}
