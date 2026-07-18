package monitorops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
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

func TestDeleteRequiresYesWhenNoninteractive(t *testing.T) {
	called := false
	d := Dependencies{Client: clientFunc(func(context.Context, Request) error { called = true; return nil }), Format: func() string { return "json" }, NewID: func() (string, error) { return "key", nil }}
	cmd := NewGroup(d)
	cmd.SilenceErrors = true
	cmd.SilenceUsage = true
	cmd.SetArgs([]string{"delete", "api"})
	err := cmd.Execute()
	var ce *Error
	if !errors.As(err, &ce) || ce.Exit != ExitInvalidInput {
		t.Fatalf("error = %#v", err)
	}
	if called {
		t.Fatal("API called")
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
