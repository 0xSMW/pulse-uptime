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

func TestCompareVersions(t *testing.T) {
	if CompareVersions("v1.2.0", "1.1.9") <= 0 || CompareVersions("1.0.0", "1.0.0") != 0 || CompareVersions("0.9.0", "1.0.0") >= 0 {
		t.Fatal("unexpected version ordering")
	}
}
