package monitorops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"
)

type clientFunc func(context.Context, Request) error

func (f clientFunc) Do(ctx context.Context, r Request) error { return f(ctx, r) }

func setListResult(t *testing.T, result any, items []string, next *string) {
	t.Helper()
	doc, ok := result.(*ListEnvelope)
	if !ok {
		t.Fatalf("result type = %T", result)
	}
	doc.APIVersion, doc.Kind, doc.Meta.NextCursor = "v1", "MonitorList", next
	for _, item := range items {
		doc.Data = append(doc.Data, json.RawMessage(item))
	}
}

func TestListAutoPaginationPreservesOrderAndCapsTotal(t *testing.T) {
	var queries []url.Values
	next := "second"
	client := clientFunc(func(_ context.Context, r Request) error {
		queries = append(queries, cloneValues(r.Query))
		if len(queries) == 1 {
			setListResult(t, r.Result, []string{`{"id":"a"}`, `{"id":"b"}`}, &next)
		} else {
			setListResult(t, r.Result, []string{`{"id":"c"}`, `{"id":"d"}`}, nil)
		}
		return nil
	})
	doc, err := List(context.Background(), client, ListOptions{Limit: 3, Machine: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(doc.Data); got != 3 {
		t.Fatalf("records = %d", got)
	}
	if got := queries[1].Get("cursor"); got != "second" {
		t.Fatalf("cursor = %q", got)
	}
	if got := queries[1].Get("limit"); got != "1" {
		t.Fatalf("second limit = %q", got)
	}
}

func TestListRejectsRepeatingCursor(t *testing.T) {
	// SEC-08: a server that keeps returning the same nextCursor must not drive an
	// unbounded request loop; the repeated cursor terminates it quickly.
	cycle := "cycle"
	calls := 0
	client := clientFunc(func(_ context.Context, r Request) error {
		calls++
		setListResult(t, r.Result, []string{`{"id":"a"}`}, &cycle)
		return nil
	})
	_, err := List(context.Background(), client, ListOptions{All: true, Machine: true})
	if err == nil {
		t.Fatal("expected a repeating cursor to be rejected")
	}
	var ce *Error
	if !errors.As(err, &ce) || ce.Code != "PAGINATION_LIMIT" {
		t.Fatalf("error = %#v, want PAGINATION_LIMIT", err)
	}
	if calls > 3 {
		t.Fatalf("made %d requests before detecting the cycle", calls)
	}
}

func TestListCapsTotalPages(t *testing.T) {
	// SEC-08: a server that always advances the cursor is still bounded by the
	// hard page cap rather than looping forever.
	calls := 0
	client := clientFunc(func(_ context.Context, r Request) error {
		calls++
		next := strconv.Itoa(calls)
		setListResult(t, r.Result, []string{`{"id":"a"}`}, &next)
		return nil
	})
	_, err := List(context.Background(), client, ListOptions{All: true, Machine: true})
	if err == nil {
		t.Fatal("expected the page cap to stop an endless stream")
	}
	if calls > maxListPages+1 {
		t.Fatalf("made %d requests, expected at most %d", calls, maxListPages+1)
	}
}

func TestListEmptyDataSerializesAsArray(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		setListResult(t, r.Result, nil, nil)
		return nil
	})
	doc, err := List(context.Background(), client, ListOptions{Machine: true})
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

func TestListSendsGroupIDFilter(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		if got := r.Query.Get("groupId"); got != "production" {
			t.Fatalf("groupId = %q", got)
		}
		setListResult(t, r.Result, nil, nil)
		return nil
	})
	if _, err := List(context.Background(), client, ListOptions{GroupID: "production"}); err != nil {
		t.Fatal(err)
	}
}

func TestListRejectsGroupNameAndID(t *testing.T) {
	d := Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("API called"); return nil }), Format: func() string { return "json" }}
	cmd := NewGroup(d)
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetArgs([]string{"list", "--group", "Production", "--group-id", "production"})
	err := cmd.Execute()
	var ce *Error
	if !errors.As(err, &ce) || ce.Exit != ExitInvalidInput {
		t.Fatalf("error = %#v", err)
	}
}

func TestCreateAcceptsGroupID(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		body, ok := r.Body.(map[string]any)
		if !ok || body["groupId"] != "production" {
			t.Fatalf("body = %#v", r.Body)
		}
		doc := r.Result.(*Envelope)
		doc.APIVersion, doc.Kind, doc.Data = "v1", "Monitor", json.RawMessage(`{"id":"api"}`)
		return nil
	})
	d := Dependencies{Client: client, Format: func() string { return "json" }, NewID: func() (string, error) { return "key", nil }}
	cmd := NewGroup(d)
	cmd.SetArgs([]string{"create", "--id", "api", "--name", "API", "--url", "https://example.com", "--group-id", "production"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupSelectorsAreMutuallyExclusive(t *testing.T) {
	d := Dependencies{Client: clientFunc(func(context.Context, Request) error { t.Fatal("API called"); return nil }), Format: func() string { return "json" }}
	for _, args := range [][]string{
		{"update", "api", "--group", "Production", "--group-id", "production"},
		{"update", "api", "--group-id", "production", "--clear-group"},
	} {
		cmd := NewGroup(d)
		cmd.SilenceErrors, cmd.SilenceUsage = true, true
		cmd.SetArgs(args)
		err := cmd.Execute()
		var ce *Error
		if !errors.As(err, &ce) || ce.Exit != ExitInvalidInput {
			t.Fatalf("args=%v error=%#v", args, err)
		}
	}
}

func TestUpdateClearsGroup(t *testing.T) {
	// Both the discoverable --clear-group flag and an empty --group-id send an
	// explicit null groupId, which the API reads as clear rather than unchanged.
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"clear-group flag", []string{"update", "api", "--clear-group"}},
		{"empty group-id", []string{"update", "api", "--group-id", ""}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			client := clientFunc(func(_ context.Context, r Request) error {
				body, _ = r.Body.(map[string]any)
				doc := r.Result.(*Envelope)
				doc.APIVersion, doc.Kind, doc.Data = "v1", "Monitor", json.RawMessage(`{"id":"api"}`)
				return nil
			})
			d := Dependencies{Client: client, Format: func() string { return "json" }, NewID: func() (string, error) { return "key", nil }}
			cmd := NewGroup(d)
			cmd.SetArgs(tc.args)
			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			value, ok := body["groupId"]
			if !ok {
				t.Fatalf("groupId absent from body %#v", body)
			}
			if value != nil {
				t.Fatalf("groupId = %#v, want nil", value)
			}
		})
	}
}

func TestGetRendersRuntimeState(t *testing.T) {
	data := json.RawMessage(`{"id":"api","name":"API","url":"https://example.com","state":"UP","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z"}`)
	client := clientFunc(func(_ context.Context, r Request) error {
		doc := r.Result.(*Envelope)
		doc.APIVersion, doc.Kind, doc.Data = "v1", "Monitor", data
		return nil
	})

	var table bytes.Buffer
	tableCmd := NewGroup(Dependencies{Client: client, Out: &table, Format: func() string { return "table" }})
	tableCmd.SetArgs([]string{"get", "api"})
	if err := tableCmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(table.Bytes(), []byte("State    UP")) {
		t.Fatalf("table missing state: %s", table.String())
	}

	var out bytes.Buffer
	jsonCmd := NewGroup(Dependencies{Client: client, Out: &out, Format: func() string { return "json" }})
	jsonCmd.SetArgs([]string{"get", "api"})
	if err := jsonCmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var env Envelope
	if err := json.Unmarshal(out.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	var m Monitor
	if err := json.Unmarshal(env.Data, &m); err != nil {
		t.Fatal(err)
	}
	if m.State != "UP" || m.CreatedAt != "2026-01-01T00:00:00Z" || m.UpdatedAt != "2026-01-02T00:00:00Z" {
		t.Fatalf("monitor runtime fields = %#v", m)
	}
}

func TestArchiveRequiresYesWhenNoninteractive(t *testing.T) {
	called := false
	d := Dependencies{Client: clientFunc(func(context.Context, Request) error { called = true; return nil }), Format: func() string { return "json" }, NewID: func() (string, error) { return "key", nil }}
	cmd := NewGroup(d)
	cmd.SilenceErrors = true
	cmd.SilenceUsage = true
	cmd.SetArgs([]string{"archive", "api"})
	err := cmd.Execute()
	var ce *Error
	if !errors.As(err, &ce) || ce.Exit != ExitInvalidInput {
		t.Fatalf("error = %#v", err)
	}
	if called {
		t.Fatal("API called")
	}
}

func TestArchiveIsCanonicalAndDeleteIsRetired(t *testing.T) {
	cmd := NewGroup(Dependencies{})
	archive, _, err := cmd.Find([]string{"archive"})
	if err != nil {
		t.Fatal(err)
	}
	if archive.Hidden || archive.Deprecated != "" {
		t.Fatalf("archive metadata = hidden:%v deprecated:%q", archive.Hidden, archive.Deprecated)
	}
	for _, sub := range cmd.Commands() {
		if sub.Name() == "delete" {
			t.Fatal("delete command is retired and must not be registered")
		}
	}
}

func TestMutationUsesOneGeneratedIdempotencyKey(t *testing.T) {
	var keys []string
	generated := 0
	var out bytes.Buffer
	client := clientFunc(func(_ context.Context, r Request) error {
		keys = append(keys, r.IdempotencyKey)
		doc := r.Result.(*Envelope)
		doc.APIVersion = "v1"
		doc.Kind = "Monitor"
		doc.Data = json.RawMessage(`{"id":"api"}`)
		return nil
	})
	d := Dependencies{Client: client, Out: &out, Format: func() string { return "json" }, NewID: func() (string, error) { generated++; return "stable-key", nil }}
	cmd := NewGroup(d)
	cmd.SetArgs([]string{"pause", "api"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if generated != 1 || !reflect.DeepEqual(keys, []string{"stable-key"}) {
		t.Fatalf("generated=%d keys=%v", generated, keys)
	}
}

func TestWatchSortsTransitionsAndStopsOnCancel(t *testing.T) {
	call := 0
	var out bytes.Buffer
	client := clientFunc(func(_ context.Context, r Request) error {
		call++
		if call == 1 {
			setListResult(t, r.Result, []string{`{"id":"b","state":"UP"}`, `{"id":"a","state":"UP"}`}, nil)
		} else {
			setListResult(t, r.Result, []string{`{"id":"b","state":"DOWN"}`, `{"id":"a","state":"DOWN"}`}, nil)
		}
		return nil
	})
	d := Dependencies{Client: client, Out: &out, Format: func() string { return "jsonl" }, Now: func() time.Time { return time.Unix(0, 0) }, Poll: func(context.Context, time.Duration) error {
		if call >= 2 {
			return context.Canceled
		}
		return nil
	}}
	err := Watch(context.Background(), d, "", time.Second)
	var ce *Error
	if !errors.As(err, &ce) || ce.Exit != ExitInterrupted {
		t.Fatalf("error=%#v", err)
	}
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	if len(lines) != 4 {
		t.Fatalf("lines=%d: %s", len(lines), out.String())
	}
	var first, second WatchEvent
	json.Unmarshal(lines[2], &first)
	json.Unmarshal(lines[3], &second)
	if first.MonitorID != "a" || second.MonitorID != "b" {
		t.Fatalf("transition order=%s,%s", first.MonitorID, second.MonitorID)
	}
}

func TestExactMonitorIDWhitespaceOnlyPositionalIsLocalInvalid(t *testing.T) {
	called := false
	d := Dependencies{
		Client: clientFunc(func(context.Context, Request) error {
			called = true
			return nil
		}),
		Format: func() string { return "json" },
	}
	cmd := NewGroup(d)
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetArgs([]string{"get", "   "})
	err := cmd.Execute()
	var ce *Error
	if !errors.As(err, &ce) || ce.Exit != ExitInvalidInput || ce.Code != "INVALID_ARGUMENT" {
		t.Fatalf("error = %#v", err)
	}
	if called {
		t.Fatal("API called for whitespace-only positional id")
	}
}

func TestExactMonitorIDWhitespaceOnlyFlagIsLocalInvalid(t *testing.T) {
	called := false
	d := Dependencies{
		Client: clientFunc(func(context.Context, Request) error {
			called = true
			return nil
		}),
		Format: func() string { return "json" },
	}
	cmd := NewGroup(d)
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetArgs([]string{"get", "--id", "\t  "})
	err := cmd.Execute()
	var ce *Error
	if !errors.As(err, &ce) || ce.Exit != ExitInvalidInput || ce.Code != "INVALID_ARGUMENT" {
		t.Fatalf("error = %#v", err)
	}
	if called {
		t.Fatal("API called for whitespace-only --id")
	}
}

func TestExactMonitorIDTrimsPaddedValidIDInPath(t *testing.T) {
	var path string
	client := clientFunc(func(_ context.Context, r Request) error {
		path = r.Path
		doc := r.Result.(*Envelope)
		doc.APIVersion, doc.Kind, doc.Data = "v1", "Monitor", json.RawMessage(`{"id":"api"}`)
		return nil
	})
	d := Dependencies{Client: client, Format: func() string { return "json" }}
	cmd := NewGroup(d)
	cmd.SetArgs([]string{"get", "  api  "})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if path != "/api/v1/monitors/api" {
		t.Fatalf("path = %q, want trimmed id", path)
	}
}

func TestExactMonitorIDPositionalAndFlagConflict(t *testing.T) {
	called := false
	d := Dependencies{
		Client: clientFunc(func(context.Context, Request) error {
			called = true
			return nil
		}),
		Format: func() string { return "json" },
	}
	cmd := NewGroup(d)
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetArgs([]string{"get", "api", "--id", "other"})
	err := cmd.Execute()
	var ce *Error
	if !errors.As(err, &ce) || ce.Exit != ExitInvalidInput || ce.Code != "INVALID_ARGUMENT" {
		t.Fatalf("error = %#v", err)
	}
	if called {
		t.Fatal("API called when both positional and --id were set")
	}
}

func TestExactMonitorIDValidExactIDKeepsExistingBehavior(t *testing.T) {
	var path string
	client := clientFunc(func(_ context.Context, r Request) error {
		path = r.Path
		doc := r.Result.(*Envelope)
		doc.APIVersion, doc.Kind, doc.Data = "v1", "Monitor", json.RawMessage(`{"id":"api"}`)
		return nil
	})
	d := Dependencies{Client: client, Format: func() string { return "json" }}

	for _, args := range [][]string{
		{"get", "api"},
		{"get", "--id", "api"},
	} {
		path = ""
		cmd := NewGroup(d)
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("args=%v err=%v", args, err)
		}
		if path != "/api/v1/monitors/api" {
			t.Fatalf("args=%v path=%q", args, path)
		}
	}
}

func TestExactMonitorIDUnitHelper(t *testing.T) {
	if id, err := exactMonitorID([]string{"  api  "}, ""); err != nil || id != "api" {
		t.Fatalf("positional trim: id=%q err=%v", id, err)
	}
	if id, err := exactMonitorID(nil, "  api  "); err != nil || id != "api" {
		t.Fatalf("flag trim: id=%q err=%v", id, err)
	}
	if _, err := exactMonitorID([]string{" "}, ""); err == nil {
		t.Fatal("expected whitespace positional to fail")
	}
	if _, err := exactMonitorID(nil, "\t"); err == nil {
		t.Fatal("expected whitespace flag to fail")
	}
	if _, err := exactMonitorID([]string{"a"}, "b"); err == nil {
		t.Fatal("expected conflict to fail")
	}
	if _, err := exactMonitorID(nil, ""); err == nil {
		t.Fatal("expected missing id to fail")
	}
}
