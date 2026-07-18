package readops

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"
)

type clientFunc func(context.Context, Request) error

func (f clientFunc) Do(ctx context.Context, r Request) error { return f(ctx, r) }

func TestListRejectsRepeatingCursor(t *testing.T) {
	// SEC-08: a repeated nextCursor must terminate the loop instead of looping.
	cycle := "cycle"
	calls := 0
	client := clientFunc(func(_ context.Context, r Request) error {
		calls++
		doc := r.Result.(*ListEnvelope)
		doc.APIVersion, doc.Kind = "v1", "IncidentList"
		doc.Data = []json.RawMessage{json.RawMessage(`{"id":"one"}`)}
		doc.Meta.NextCursor = &cycle
		return nil
	})
	_, err := List(context.Background(), client, 0, "", true)
	if err == nil {
		t.Fatal("expected a repeating cursor to be rejected")
	}
	if calls > 3 {
		t.Fatalf("made %d requests before detecting the cycle", calls)
	}
}

func TestListMachinePaginationPreservesCursorAndOrder(t *testing.T) {
	var queries []url.Values
	next := "next"
	client := clientFunc(func(_ context.Context, r Request) error {
		queries = append(queries, clone(r.Query))
		doc := r.Result.(*ListEnvelope)
		doc.APIVersion = "v1"
		doc.Kind = "IncidentList"
		if len(queries) == 1 {
			doc.Data = []json.RawMessage{json.RawMessage(`{"id":"one"}`)}
			doc.Meta.NextCursor = &next
		} else {
			doc.Data = []json.RawMessage{json.RawMessage(`{"id":"two"}`)}
		}
		return nil
	})
	doc, err := List(context.Background(), client, 0, "start", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Data) != 2 {
		t.Fatalf("records=%d", len(doc.Data))
	}
	if queries[0].Get("cursor") != "start" || queries[1].Get("cursor") != "next" {
		t.Fatalf("queries=%v", queries)
	}
}

func TestListEmptyDataSerializesAsArray(t *testing.T) {
	client := clientFunc(func(_ context.Context, r Request) error {
		doc := r.Result.(*ListEnvelope)
		doc.APIVersion = "v1"
		doc.Kind = "IncidentList"
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
	if string(encoded) != `{"apiVersion":"v1","kind":"IncidentList","data":[],"meta":{"nextCursor":null}}` {
		t.Fatalf("output = %s", encoded)
	}
}

func TestStatusUsesCanonicalEndpoint(t *testing.T) {
	var path string
	client := clientFunc(func(_ context.Context, r Request) error {
		path = r.Path
		doc := r.Result.(*Envelope)
		doc.APIVersion = "v1"
		doc.Kind = "Status"
		doc.Data = json.RawMessage(`{}`)
		return nil
	})
	cmd := NewStatusCommand(Dependencies{Client: client, Format: func() string { return "json" }})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if path != "/api/v1/status" {
		t.Fatalf("path=%q", path)
	}
}
