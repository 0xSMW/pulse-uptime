package groupops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
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

func TestGroupTreeAndScopes(t *testing.T) {
	cmd := NewGroup(Dependencies{})
	want := map[string]string{"list": "monitors:read", "create": "monitors:write", "rename": "monitors:write", "delete": "monitors:write"}
	got := map[string]string{}
	for _, child := range cmd.Commands() {
		got[child.Name()] = child.Annotations["requiredScope"]
		if child.Annotations["supportsOutput"] != "table,json,jsonl,yaml,tsv" {
			t.Fatalf("%s output annotation = %q", child.Name(), child.Annotations["supportsOutput"])
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commands = %#v, want %#v", got, want)
	}
}

func TestCreateUsesExactBodyAndIdempotencyKey(t *testing.T) {
	client := &fakeClient{do: func(request Request) error {
		doc := request.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "Group", Data: json.RawMessage(`{"id":"prod","name":"Production"}`)}
		return nil
	}}
	var out bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &out, Format: func() string { return "json" }, NewID: func() (string, error) { return "idem-1", nil }})
	cmd.SetArgs([]string{"create", "--id", "prod", "--name", "Production"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	request := client.requests[0]
	if request.Method != http.MethodPost || request.Path != "/api/v1/groups" || request.IdempotencyKey != "idem-1" {
		t.Fatalf("request = %#v", request)
	}
	if !reflect.DeepEqual(request.Body, map[string]any{"id": "prod", "name": "Production"}) {
		t.Fatalf("body = %#v", request.Body)
	}
	if !strings.Contains(out.String(), `"apiVersion": "v1"`) || !strings.Contains(out.String(), `"kind": "Group"`) {
		t.Fatalf("output = %s", out.String())
	}
}

func TestRenameEscapesGroupID(t *testing.T) {
	client := &fakeClient{do: func(request Request) error {
		*request.Result.(*Envelope) = Envelope{APIVersion: "v1", Kind: "Group", Data: json.RawMessage(`{"id":"prod/west","name":"West"}`)}
		return nil
	}}
	cmd := NewGroup(Dependencies{Client: client, Format: func() string { return "json" }, NewID: func() (string, error) { return "idem-2", nil }})
	cmd.SetArgs([]string{"rename", "prod/west", "--name", "West"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	request := client.requests[0]
	if request.Method != http.MethodPatch || request.Path != "/api/v1/groups/prod%2Fwest" {
		t.Fatalf("request = %#v", request)
	}
	if !reflect.DeepEqual(request.Body, map[string]any{"name": "West"}) {
		t.Fatalf("body = %#v", request.Body)
	}
}

func TestDeleteRequiresYesWhenNoninteractive(t *testing.T) {
	client := &fakeClient{}
	cmd := NewGroup(Dependencies{Client: client, StdinTTY: false, NewID: func() (string, error) { return "unused", nil }})
	cmd.SetArgs([]string{"delete", "prod"})
	err := cmd.Execute()
	var cliErr *Error
	if !errors.As(err, &cliErr) || cliErr.Exit != 2 || cliErr.Code != "INVALID_ARGUMENT" {
		t.Fatalf("error = %#v", err)
	}
	if len(client.requests) != 0 {
		t.Fatalf("unexpected requests: %#v", client.requests)
	}
}

func TestDeletePromptCancellationMakesNoRequest(t *testing.T) {
	client := &fakeClient{}
	var stderr bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, In: strings.NewReader("no\n"), Err: &stderr, StdinTTY: true, NewID: func() (string, error) { return "unused", nil }})
	cmd.SetArgs([]string{"delete", "prod"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 0 || !strings.Contains(stderr.String(), "Canceled") {
		t.Fatalf("requests = %#v, stderr = %q", client.requests, stderr.String())
	}
}

func TestDeleteConfirmedUsesMappedServerErrors(t *testing.T) {
	sentinel := errors.New("GROUP_NOT_EMPTY")
	mapped := errors.New("mapped")
	client := &fakeClient{do: func(Request) error { return sentinel }}
	cmd := NewGroup(Dependencies{Client: client, NewID: func() (string, error) { return "idem-3", nil }, MapError: func(err error) error {
		if !errors.Is(err, sentinel) {
			t.Fatalf("mapped error = %v", err)
		}
		return mapped
	}})
	cmd.SetArgs([]string{"delete", "prod", "--yes"})
	if err := cmd.Execute(); !errors.Is(err, mapped) {
		t.Fatalf("error = %v", err)
	}
	request := client.requests[0]
	if request.Method != http.MethodDelete || request.Path != "/api/v1/groups/prod" || request.IdempotencyKey != "idem-3" {
		t.Fatalf("request = %#v", request)
	}
}

func TestDeleteConfirmedRendersServerEnvelope(t *testing.T) {
	var stdout bytes.Buffer
	client := &fakeClient{do: func(request Request) error {
		doc := request.Result.(*Envelope)
		*doc = Envelope{APIVersion: "v1", Kind: "GroupDeletion", Data: json.RawMessage(`{"id":"prod"}`)}
		return nil
	}}
	cmd := NewGroup(Dependencies{
		Client: client, Out: &stdout, Format: func() string { return "json" },
		NewID: func() (string, error) { return "idem-delete", nil },
	})
	cmd.SetArgs([]string{"delete", "prod", "--yes"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"kind": "GroupDeletion"`) {
		t.Fatalf("output = %q", stdout.String())
	}
}

func TestListMachineAutoPaginatesAndHonorsTotalLimit(t *testing.T) {
	next := "page-2"
	client := &fakeClient{do: func(request Request) error {
		doc := request.Result.(*ListEnvelope)
		if len(clientCursor(request)) == 0 {
			*doc = ListEnvelope{APIVersion: "v1", Kind: "GroupList", Data: []json.RawMessage{json.RawMessage(`{"id":"a","name":"A"}`), json.RawMessage(`{"id":"b","name":"B"}`)}, Meta: Meta{NextCursor: &next}}
		} else {
			*doc = ListEnvelope{APIVersion: "v1", Kind: "GroupList", Data: []json.RawMessage{json.RawMessage(`{"id":"c","name":"C"}`)}}
		}
		return nil
	}}
	doc, err := List(context.Background(), client, ListOptions{Limit: 3, Cursor: "", Machine: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Data) != 3 || len(client.requests) != 2 {
		t.Fatalf("records = %d, requests = %d", len(doc.Data), len(client.requests))
	}
	if client.requests[0].Query.Get("limit") != "3" || client.requests[1].Query.Get("limit") != "1" || client.requests[1].Query.Get("cursor") != next {
		t.Fatalf("queries = %#v / %#v", client.requests[0].Query, client.requests[1].Query)
	}
}

func TestListHumanStopsAfterFirstPageAndPrintsHint(t *testing.T) {
	next := "next"
	client := &fakeClient{do: func(request Request) error {
		*request.Result.(*ListEnvelope) = ListEnvelope{APIVersion: "v1", Kind: "GroupList", Data: []json.RawMessage{json.RawMessage(`{"id":"prod","name":"Production","monitorCount":2}`)}, Meta: Meta{NextCursor: &next}}
		return nil
	}}
	var out, stderr bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &out, Err: &stderr, Format: func() string { return "table" }})
	cmd.SetArgs([]string{"list"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 1 || !strings.Contains(out.String(), "prod\tProduction\t2") || !strings.Contains(stderr.String(), "--cursor next") {
		t.Fatalf("requests = %d, out = %q, err = %q", len(client.requests), out.String(), stderr.String())
	}
}

func TestListJSONLIsRecordsOnly(t *testing.T) {
	client := &fakeClient{do: func(request Request) error {
		*request.Result.(*ListEnvelope) = ListEnvelope{Data: []json.RawMessage{json.RawMessage(`{"id":"a","name":"A"}`), json.RawMessage(`{"id":"b","name":"B"}`)}}
		return nil
	}}
	var out bytes.Buffer
	cmd := NewGroup(Dependencies{Client: client, Out: &out, Format: func() string { return "jsonl" }})
	cmd.SetArgs([]string{"list"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if out.String() != "{\"id\":\"a\",\"name\":\"A\"}\n{\"id\":\"b\",\"name\":\"B\"}\n" {
		t.Fatalf("output = %q", out.String())
	}
}

func TestListRejectsNegativeLimit(t *testing.T) {
	_, err := List(context.Background(), &fakeClient{}, ListOptions{Limit: -1})
	var cliErr *Error
	if !errors.As(err, &cliErr) || cliErr.Exit != 2 {
		t.Fatalf("error = %#v", err)
	}
}

func TestMutationRequiresIdempotencyGenerator(t *testing.T) {
	cmd := NewGroup(Dependencies{Client: &fakeClient{}})
	cmd.SetArgs([]string{"create", "--id", "prod", "--name", "Production"})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "idempotency key generator") {
		t.Fatalf("error = %v", err)
	}
}

func clientCursor(request Request) string { return request.Query.Get("cursor") }
