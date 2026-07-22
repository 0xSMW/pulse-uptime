package userops

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

type fakeClient struct {
	requests []Request
	respond  func(Request) json.RawMessage
	kind     string
}

func (f *fakeClient) Do(_ context.Context, request Request) error {
	f.requests = append(f.requests, request)
	if request.Result == nil {
		return nil
	}
	envelope, ok := request.Result.(*Envelope)
	if !ok {
		return nil
	}
	envelope.APIVersion = "v1"
	envelope.Kind = f.kind
	if f.respond != nil {
		envelope.Data = f.respond(request)
	}
	return nil
}

func dependencies(client Client, out *bytes.Buffer, format string) Dependencies {
	return Dependencies{
		Client:    client,
		Out:       out,
		Err:       &bytes.Buffer{},
		Format:    func() string { return format },
		NewID:     func() (string, error) { return "key-1", nil },
		ServerURL: func() string { return "https://pulse.example.com/" },
	}
}

func inviteData() json.RawMessage {
	return json.RawMessage(`{"id":"inv-1","role":"viewer","token":"pulse_join_secret","joinPath":"/join/pulse_join_secret","createdAt":"2026-07-22T00:00:00Z","expiresAt":"2026-07-29T00:00:00Z"}`)
}

func TestInviteComposesFullLinkForHumans(t *testing.T) {
	client := &fakeClient{kind: "CreatedInvite", respond: func(Request) json.RawMessage { return inviteData() }}
	var out bytes.Buffer
	cmd := NewGroup(dependencies(client, &out, "table"))
	cmd.SetArgs([]string{"invite", "--role", "viewer"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 1 {
		t.Fatalf("expected one request, got %d", len(client.requests))
	}
	request := client.requests[0]
	if request.Method != http.MethodPost || request.Path != "/api/v1/users/invites" {
		t.Fatalf("unexpected request %s %s", request.Method, request.Path)
	}
	if request.IdempotencyKey != "key-1" {
		t.Fatalf("mutation must carry an idempotency key, got %q", request.IdempotencyKey)
	}
	body := request.Body.(map[string]any)
	if body["role"] != "viewer" {
		t.Fatalf("unexpected body %v", body)
	}
	text := out.String()
	if !strings.Contains(text, "https://pulse.example.com/join/pulse_join_secret") {
		t.Fatalf("output missing composed link: %q", text)
	}
}

func TestInviteAddsURLFieldForMachines(t *testing.T) {
	client := &fakeClient{kind: "CreatedInvite", respond: func(Request) json.RawMessage { return inviteData() }}
	var out bytes.Buffer
	cmd := NewGroup(dependencies(client, &out, "json"))
	cmd.SetArgs([]string{"invite", "--role", "admin"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Data CreatedInvite `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("invalid json output: %v: %q", err, out.String())
	}
	if doc.Data.URL != "https://pulse.example.com/join/pulse_join_secret" {
		t.Fatalf("machine output missing url field: %+v", doc.Data)
	}
	if doc.Data.Token != "pulse_join_secret" {
		t.Fatalf("machine output missing token: %+v", doc.Data)
	}
}

func TestInviteRejectsUnknownRole(t *testing.T) {
	client := &fakeClient{kind: "CreatedInvite"}
	cmd := NewGroup(dependencies(client, &bytes.Buffer{}, "json"))
	cmd.SetArgs([]string{"invite", "--role", "owner"})
	cmd.SilenceErrors = true
	cmd.SilenceUsage = true
	if err := cmd.Execute(); err == nil {
		t.Fatal("expected role validation error")
	}
	if len(client.requests) != 0 {
		t.Fatalf("invalid role must not reach the API, got %d requests", len(client.requests))
	}
}

func TestListRendersUsersAndInvitesTable(t *testing.T) {
	client := &fakeClient{kind: "Team", respond: func(Request) json.RawMessage {
		return json.RawMessage(`{"users":[{"id":"usr-1","email":"stephen@example.com","name":"Stephen","role":"admin","createdAt":"2026-07-01T00:00:00Z","lastSeenAt":null}],"invites":[{"id":"inv-1","role":"viewer","createdBy":"human:usr-1","createdAt":"2026-07-21T00:00:00Z","expiresAt":"2026-07-28T00:00:00Z"}]}`)
	}}
	var out bytes.Buffer
	cmd := NewGroup(dependencies(client, &out, "table"))
	cmd.SetArgs([]string{"list"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	for _, expected := range []string{"stephen@example.com", "admin", "PENDING INVITE", "inv-1", "never"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("table output missing %q: %q", expected, text)
		}
	}
}

func TestListTSVCarriesInviteExpiry(t *testing.T) {
	client := &fakeClient{kind: "Team", respond: func(Request) json.RawMessage {
		return json.RawMessage(`{"users":[{"id":"usr-1","email":"stephen@example.com","name":null,"role":"admin","createdAt":"2026-07-01T00:00:00Z","lastSeenAt":"2026-07-22T00:00:00Z"}],"invites":[{"id":"inv-1","role":"viewer","createdBy":"human:usr-1","createdAt":"2026-07-21T00:00:00Z","expiresAt":"2026-07-28T00:00:00Z"}]}`)
	}}
	var out bytes.Buffer
	cmd := NewGroup(dependencies(client, &out, "tsv"))
	cmd.SetArgs([]string{"list"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 rows, got %q", out.String())
	}
	for _, line := range lines {
		if got := strings.Count(line, "\t"); got != 5 {
			t.Fatalf("expected 6 columns, got %d tabs in %q", got, line)
		}
	}
	if !strings.Contains(lines[0], "2026-07-22T00:00:00Z") {
		t.Fatalf("user row missing lastSeenAt: %q", lines[0])
	}
	if !strings.Contains(lines[1], "2026-07-28T00:00:00Z") {
		t.Fatalf("invite row missing expiresAt: %q", lines[1])
	}
}

func TestRoleAndRemoveTargetTheUserPath(t *testing.T) {
	client := &fakeClient{kind: "TeamUser"}
	cmd := NewGroup(dependencies(client, &bytes.Buffer{}, "json"))
	cmd.SetArgs([]string{"role", "usr-2", "--role", "viewer"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if client.requests[0].Method != http.MethodPatch || client.requests[0].Path != "/api/v1/users/usr-2" {
		t.Fatalf("unexpected request %+v", client.requests[0])
	}

	remove := NewGroup(dependencies(client, &bytes.Buffer{}, "json"))
	remove.SetArgs([]string{"remove", "usr-2", "--yes"})
	if err := remove.Execute(); err != nil {
		t.Fatal(err)
	}
	last := client.requests[len(client.requests)-1]
	if last.Method != http.MethodDelete || last.Path != "/api/v1/users/usr-2" {
		t.Fatalf("unexpected request %+v", last)
	}
}

func TestRemoveRequiresConfirmationWithoutTTY(t *testing.T) {
	client := &fakeClient{kind: "TeamUser"}
	cmd := NewGroup(dependencies(client, &bytes.Buffer{}, "json"))
	cmd.SetArgs([]string{"remove", "usr-2"})
	cmd.SilenceErrors = true
	cmd.SilenceUsage = true
	if err := cmd.Execute(); err == nil {
		t.Fatal("expected --yes requirement without a TTY")
	}
	if len(client.requests) != 0 {
		t.Fatalf("unconfirmed removal must not reach the API")
	}
}
