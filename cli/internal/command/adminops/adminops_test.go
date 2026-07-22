package adminops

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"
)

type request struct {
	method, path string
	body         any
}
type fakeClient struct{ requests []request }

func (f *fakeClient) Do(_ context.Context, method, path string, body any, _ http.Header, out any) (http.Header, error) {
	f.requests = append(f.requests, request{method, path, body})
	if target, ok := out.(*map[string]any); ok {
		*target = map[string]any{"apiVersion": "v1", "kind": "CreatedToken", "data": map[string]any{"token": "show-once"}}
	}
	return nil, nil
}

type fakeSessions struct {
	session Session
	cleared bool
}

func (f *fakeSessions) Current(context.Context) (Session, error) {
	return f.session, nil
}

func (f *fakeSessions) Clear(context.Context) error {
	f.cleared = true
	return nil
}

func TestParseExpiryBounds(t *testing.T) {
	if got, err := ParseExpiry("90d"); err != nil || got != 90*24*time.Hour {
		t.Fatalf("got %v, %v", got, err)
	}
	for _, value := range []string{"0d", "366d", "forever"} {
		if _, err := ParseExpiry(value); err == nil {
			t.Errorf("%q accepted", value)
		}
	}
}

func TestTokenCreateSortsScopesAndUsesAbsoluteExpiry(t *testing.T) {
	client := &fakeClient{}
	var out bytes.Buffer
	now := time.Date(2026, 7, 18, 0, 0, 0, 0, time.UTC)
	cmd := NewTokenCommand(Dependencies{Client: client, Out: &out, Output: func(string) string { return "json" }, Now: func() time.Time { return now }})
	cmd.SetArgs([]string{"create", "--name", "agent", "--scope", "tokens:manage", "--scope", "config:read", "--expires-in", "1d"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	body := client.requests[0].body.(map[string]any)
	if body["expiresAt"] != "2026-07-19T00:00:00Z" {
		t.Fatalf("expiresAt = %v", body["expiresAt"])
	}
	scopes := body["scopes"].([]string)
	if scopes[0] != "config:read" || scopes[1] != "tokens:manage" {
		t.Fatalf("scopes = %v", scopes)
	}
}

func TestTokenCreateOmitsExpiryWhenNotRequested(t *testing.T) {
	client := &fakeClient{}
	var out bytes.Buffer
	now := time.Date(2026, 7, 18, 0, 0, 0, 0, time.UTC)
	cmd := NewTokenCommand(Dependencies{Client: client, Out: &out, Output: func(string) string { return "json" }, Now: func() time.Time { return now }})
	cmd.SetArgs([]string{"create", "--name", "agent", "--scope", "monitors:read"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	body := client.requests[0].body.(map[string]any)
	if _, ok := body["expiresAt"]; ok {
		t.Fatalf("expiresAt should be omitted so the server applies and clamps the default, body = %v", body)
	}
	if body["name"] != "agent" {
		t.Fatalf("name = %v", body["name"])
	}
}

func TestTokenRevokeSendsUUIDPath(t *testing.T) {
	client := &fakeClient{}
	var out bytes.Buffer
	id := "9f1c0b2e-3d4a-4b5c-8d6e-7f8091a2b3c4"
	cmd := NewTokenCommand(Dependencies{Client: client, Out: &out, Output: func(string) string { return "json" }})
	cmd.SetArgs([]string{"revoke", id, "--yes"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(client.requests))
	}
	req := client.requests[0]
	if req.method != http.MethodDelete || req.path != "/api/v1/tokens/"+id {
		t.Fatalf("request = %s %s", req.method, req.path)
	}
}

func TestTokenRevokeRejectsBadIDsBeforeRequest(t *testing.T) {
	for _, id := range []string{"", "   ", "not-a-uuid", "9f1c0b2e-3d4a-4b5c-8d6e"} {
		client := &fakeClient{}
		cmd := NewTokenCommand(Dependencies{Client: client, Output: func(string) string { return "json" }})
		cmd.SetArgs([]string{"revoke", id, "--yes"})
		err := cmd.Execute()
		if err == nil {
			t.Fatalf("id %q was accepted", id)
		}
		if ce, ok := err.(*Error); !ok || ce.Code != "INVALID_ARGUMENT" {
			t.Fatalf("id %q error = %#v", id, err)
		}
		if len(client.requests) != 0 {
			t.Fatalf("id %q issued %d requests", id, len(client.requests))
		}
	}
}

func TestAuthUnlinkIsCanonicalAndLogoutIsRetired(t *testing.T) {
	cmd := NewAuthCommand(Dependencies{})
	unlink, _, err := cmd.Find([]string{"unlink"})
	if err != nil {
		t.Fatal(err)
	}
	if unlink.Hidden || unlink.Deprecated != "" {
		t.Fatalf("unlink metadata = hidden:%v deprecated:%q", unlink.Hidden, unlink.Deprecated)
	}
	for _, sub := range cmd.Commands() {
		if sub.Name() == "logout" {
			t.Fatal("logout command is retired and must not be registered")
		}
	}
}

func TestAuthUnlinkRevokesInstallationThenClearsLocalSession(t *testing.T) {
	client := &fakeClient{}
	sessions := &fakeSessions{session: Session{Authenticated: true, Source: "stored"}}
	cmd := NewAuthCommand(Dependencies{
		Client:   client,
		Sessions: sessions,
		Output:   func(string) string { return "json" },
	})
	cmd.SetArgs([]string{"unlink", "--yes"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(client.requests) != 1 || client.requests[0].method != http.MethodPost || client.requests[0].path != "/api/v1/cli-auth/revoke" {
		t.Fatalf("requests = %#v", client.requests)
	}
	if !sessions.cleared {
		t.Fatal("local session was not cleared")
	}
}

func TestSupportedScopesIncludeDependencies(t *testing.T) {
	allowed := scopeSet()
	for _, scope := range []string{"dependencies:read", "dependencies:write"} {
		if !allowed[scope] {
			t.Errorf("scope %q is not supported", scope)
		}
	}
	if len(SupportedScopes) != 13 {
		t.Fatalf("SupportedScopes = %d, want 13", len(SupportedScopes))
	}
}

func TestCompareVersions(t *testing.T) {
	if CompareVersions("v1.2.0", "1.1.9") <= 0 || CompareVersions("1.0.0", "1.0.0") != 0 || CompareVersions("0.9.0", "1.0.0") >= 0 {
		t.Fatal("unexpected version ordering")
	}
}
