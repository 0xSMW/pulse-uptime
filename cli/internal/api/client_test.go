package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGetWithOptionsQueryAndEnvelope(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s", r.Method)
		}
		if got := r.URL.Query().Get("cursor"); got != "next/value" {
			t.Errorf("cursor = %q", got)
		}
		if got := r.URL.Query()["status"]; len(got) != 2 || got[0] != "down" || got[1] != "up" {
			t.Errorf("status = %#v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"MonitorList","data":[{"id":"api"}],"meta":{"nextCursor":"cursor-2"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", "pulsectl/test", time.Second, server.Client())
	var envelope Envelope[[]struct {
		ID string `json:"id"`
	}]
	err := client.GetWithOptions(context.Background(), "/api/v1/monitors?status=down", &envelope, RequestOptions{Query: url.Values{
		"cursor": {"next/value"},
		"status": {"up"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Kind != "MonitorList" || len(envelope.Data) != 1 || envelope.Data[0].ID != "api" || envelope.Meta.NextCursor != "cursor-2" {
		t.Fatalf("unexpected envelope: %#v", envelope)
	}
}

func TestMutationRetriesReuseIdempotencyKeyAndBody(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var keys, bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		bodies = append(bodies, string(body))
		attempt := len(keys)
		mu.Unlock()
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("content type = %q", got)
		}
		if got := r.Header.Get("If-Match"); got != `"base-hash"` {
			t.Errorf("If-Match = %q", got)
		}
		if attempt < 3 {
			w.Header().Set("Retry-After", "0")
			http.Error(w, `{"error":{"code":"TEMPORARY"}}`, http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"Monitor","data":{"id":"api"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", "pulsectl/test", time.Second, server.Client())
	var out Envelope[map[string]string]
	err := client.PatchWithOptions(context.Background(), "/api/v1/monitors/api", map[string]string{"name": "API"}, &out, RequestOptions{IfMatch: `"base-hash"`})
	if err != nil {
		t.Fatal(err)
	}
	if out.Data["id"] != "api" {
		t.Fatalf("data = %#v", out.Data)
	}
	if len(keys) != 3 || keys[0] == "" || keys[0] != keys[1] || keys[1] != keys[2] {
		t.Fatalf("idempotency keys = %#v", keys)
	}
	if bodies[0] != bodies[1] || bodies[1] != bodies[2] {
		t.Fatalf("request bodies differed: %#v", bodies)
	}
}

func TestDoRawReturnsDocumentAndMetadata(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Request-ID", "req_server")
		w.Header().Set("ETag", `"v4"`)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"arbitrary":true}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", "pulsectl/test", time.Second, server.Client())
	resp, err := client.DoRaw(context.Background(), Request{Method: http.MethodPost, Path: "/api/v1/example", Body: map[string]bool{"ok": true}})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated || resp.RequestID != "req_server" || resp.Header.Get("ETag") != `"v4"` || string(resp.Body) != `{"arbitrary":true}` {
		t.Fatalf("unexpected raw response: %#v", resp)
	}
	resp.Header.Set("ETag", "changed")
	if got := resp.Header.Get("ETag"); got != "changed" {
		t.Fatalf("response header is not writable clone: %q", got)
	}
}

func TestRateLimitErrorExposesRetryAfter(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "31")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"code":"RATE_LIMITED","message":"Wait before retrying","details":{"limit":1},"requestId":"req_api"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", "pulsectl/test", time.Second, server.Client())
	err := client.Post(context.Background(), "/api/v1/tokens", map[string]string{"name": "ci"}, nil)
	apiErr, ok := AsError(err)
	if !ok {
		t.Fatalf("error = %#v", err)
	}
	if apiErr.Status != http.StatusTooManyRequests || apiErr.Code != "RATE_LIMITED" || apiErr.RequestID != "req_api" || apiErr.RetryAfter != 31*time.Second {
		t.Fatalf("api error = %#v", apiErr)
	}
	if !IsCode(err, "RATE_LIMITED") {
		t.Fatal("IsCode did not match")
	}
}

func TestDebugHookOmitsSecretsAndQuery(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	const token = "pulse_live_top_secret"
	client := NewClient(server.URL, token, "pulsectl/test", time.Second, server.Client())
	var event DebugEvent
	client.SetDebugHook(func(got DebugEvent) { event = got })
	_, err := client.DoRaw(context.Background(), Request{
		Method: http.MethodPost,
		Path:   "/api/v1/tokens?existing=private",
		Query:  url.Values{"token": {token}},
		Body:   map[string]string{"secret": token},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	debugText := string(encoded)
	if strings.Contains(debugText, token) || strings.Contains(debugText, "private") || strings.Contains(debugText, "token=") || strings.Contains(debugText, "secret") {
		t.Fatalf("debug event leaked sensitive data: %s", debugText)
	}
	if event.Method != http.MethodPost || event.URL != server.URL+"/api/v1/tokens" || event.Attempt != 1 || event.Status != http.StatusOK {
		t.Fatalf("unexpected debug event: %#v", event)
	}
}

func TestProgressHookSpansRetriesAndErrorPaths(t *testing.T) {
	t.Parallel()
	var attempts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		w.Header().Set("Retry-After", "0")
		http.Error(w, `{"error":{"code":"TEMPORARY"}}`, http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", "pulsectl/test", time.Second, server.Client())
	var starts, ends int
	client.SetProgressHook(func() func() {
		starts++
		return func() { ends++ }
	})
	_, err := client.DoRaw(context.Background(), Request{Method: http.MethodGet, Path: "/api/v1/monitors"})
	if err == nil {
		t.Fatal("expected error")
	}
	if attempts != maxAttempts {
		t.Fatalf("attempts = %d, want %d", attempts, maxAttempts)
	}
	if starts != 1 || ends != 1 {
		t.Fatalf("starts = %d, ends = %d, want exactly one begin/end spanning the retry loop", starts, ends)
	}
}

func TestRejectsAbsoluteRequestURL(t *testing.T) {
	t.Parallel()
	client := NewClient("https://pulse.example.com", "secret", "pulsectl/test", time.Second, nil)
	_, err := client.DoRaw(context.Background(), Request{Path: "https://attacker.example/collect"})
	apiErr, ok := AsError(err)
	if !ok || apiErr.Code != "INVALID_REQUEST" {
		t.Fatalf("error = %#v", err)
	}
}

func TestAnonymousClientOmitsAuthorization(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, present := r.Header["Authorization"]; present {
			t.Errorf("Authorization header present: %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "", "pulsectl/test", time.Second, server.Client())
	if err := client.Post(context.Background(), "/api/v1/cli-auth/device", map[string]string{"client": "pulsectl"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestClientRefusesRedirects(t *testing.T) {
	t.Parallel()
	var destinationCalled bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		destinationCalled = true
		_, _ = w.Write([]byte(`{"secret":"captured"}`))
	}))
	defer destination.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer redirector.Close()

	client := NewClient(redirector.URL, "secret", "pulsectl/test", time.Second, redirector.Client())
	err := client.Get(context.Background(), "/api/v1/tokens/", nil)
	apiErr, ok := AsError(err)
	if !ok || apiErr.Status != http.StatusFound {
		t.Fatalf("error = %#v", err)
	}
	if apiErr.Code != "UNEXPECTED_REDIRECT" {
		t.Fatalf("code = %q, want UNEXPECTED_REDIRECT", apiErr.Code)
	}
	if !strings.Contains(apiErr.Message, "/api/v1/tokens/") {
		t.Fatalf("message %q does not name the requested path", apiErr.Message)
	}
	if destinationCalled {
		t.Fatal("redirect destination was called")
	}
}
