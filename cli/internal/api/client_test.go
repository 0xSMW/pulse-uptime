package api

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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
	for _, path := range []string{
		"https://attacker.example/collect",
		"http://attacker.example/collect",
		"//attacker.example/collect",
		"https://pulse.example.com/api/v1/monitors",
	} {
		_, err := client.DoRaw(context.Background(), Request{Path: path})
		apiErr, ok := AsError(err)
		if !ok || apiErr.Code != "INVALID_REQUEST" {
			t.Fatalf("path %q: error = %#v", path, err)
		}
	}
}

func TestBasePathPreservedUnderPrefix(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("/pulse/api/v1/monitors", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pulse/api/v1/monitors" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("cursor"); got != "next/value" {
			t.Errorf("cursor = %q", got)
		}
		if got := r.URL.Query()["status"]; len(got) != 2 || got[0] != "down" || got[1] != "up" {
			t.Errorf("status = %#v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"MonitorList","data":[{"id":"api"}],"meta":{}}`))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	bases := []string{
		server.URL + "/pulse",
		server.URL + "/pulse/",
	}
	// Leading-slash, bare, and embedded-query forms must all resolve under /pulse.
	paths := []string{
		"/api/v1/monitors?status=down",
		"api/v1/monitors?status=down",
	}
	for _, base := range bases {
		for _, path := range paths {
			client := NewClient(base, "token", "pulsectl/test", time.Second, server.Client())
			var envelope Envelope[[]struct {
				ID string `json:"id"`
			}]
			err := client.GetWithOptions(context.Background(), path, &envelope, RequestOptions{Query: url.Values{
				"cursor": {"next/value"},
				"status": {"up"},
			}})
			if err != nil {
				t.Fatalf("base %q path %q: %v", base, path, err)
			}
			if len(envelope.Data) != 1 || envelope.Data[0].ID != "api" {
				t.Fatalf("base %q path %q: unexpected envelope %#v", base, path, envelope)
			}
		}
	}
}

func TestBuildURLRejectsOriginOverride(t *testing.T) {
	t.Parallel()
	client := NewClient("https://pulse.example.com/pulse", "secret", "pulsectl/test", time.Second, nil)
	// Direct buildURL coverage for scheme/host/userinfo replacement attempts.
	for _, path := range []string{
		"https://evil.example/x",
		"//evil.example/x",
		"/api/v1/monitors",
	} {
		// Relative /api under /pulse is allowed; absolute and scheme-relative are not.
		_, _, err := client.buildURL(path, nil)
		if path == "/api/v1/monitors" {
			if err != nil {
				t.Fatalf("path %q: unexpected error %v", path, err)
			}
			continue
		}
		if err == nil {
			t.Fatalf("path %q: expected rejection", path)
		}
	}
	requestURL, safeURL, err := client.buildURL("/api/v1/monitors", url.Values{"q": {"a/b", "c"}})
	if err != nil {
		t.Fatal(err)
	}
	if requestURL != "https://pulse.example.com/pulse/api/v1/monitors?q=a%2Fb&q=c" {
		t.Fatalf("request URL = %q", requestURL)
	}
	if safeURL != "https://pulse.example.com/pulse/api/v1/monitors" {
		t.Fatalf("safe URL = %q", safeURL)
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

func TestParseRetryAfter(t *testing.T) {
	t.Parallel()
	now := time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC)

	if got := parseRetryAfter("31", now); got != 31*time.Second {
		t.Fatalf("ordinary seconds = %v, want 31s", got)
	}
	if got := parseRetryAfter(strconv.FormatInt(maxRetryAfterSeconds, 10), now); got != time.Duration(maxRetryAfterSeconds)*time.Second {
		t.Fatalf("maximum integer = %v", got)
	}
	if got := parseRetryAfter(strconv.FormatInt(maxRetryAfterSeconds+1, 10), now); got != time.Duration(math.MaxInt64) {
		t.Fatalf("overflow maxSeconds+1 = %v, want MaxInt64", got)
	}
	if got := parseRetryAfter("9223372036854775807", now); got != time.Duration(math.MaxInt64) {
		t.Fatalf("overflow MaxInt64 seconds = %v, want MaxInt64", got)
	}
	if got := parseRetryAfter("-1", now); got != 0 {
		t.Fatalf("negative = %v, want 0", got)
	}
	if got := parseRetryAfter("-999999999", now); got != 0 {
		t.Fatalf("large negative = %v, want 0", got)
	}
	if got := parseRetryAfter("0", now); got != 0 {
		t.Fatalf("zero = %v, want 0", got)
	}

	future := now.Add(45 * time.Second)
	if got := parseRetryAfter(future.UTC().Format(http.TimeFormat), now); got != 45*time.Second {
		t.Fatalf("HTTP-date = %v, want 45s", got)
	}
	past := now.Add(-10 * time.Second)
	if got := parseRetryAfter(past.UTC().Format(http.TimeFormat), now); got != 0 {
		t.Fatalf("past HTTP-date = %v, want 0", got)
	}
	if got := parseRetryAfter("not-a-retry-after", now); got != 0 {
		t.Fatalf("invalid = %v, want 0", got)
	}
	// Parsed delays must never be negative (overflow wrap or signed input).
	for _, value := range []string{"-5", "9223372036854775807", strconv.FormatInt(math.MaxInt64, 10)} {
		if got := parseRetryAfter(value, now); got < 0 {
			t.Fatalf("parseRetryAfter(%q) = %v, want non-negative", value, got)
		}
	}
}

func TestOversizedRetryAfterDoesNotImmediateRetry(t *testing.T) {
	t.Parallel()
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		// Larger than time.Duration can represent in seconds; must saturate
		// rather than wrap to a negative or zero delay that retries immediately.
		w.Header().Set("Retry-After", "9223372036854775807")
		http.Error(w, `{"error":{"code":"TEMPORARY"}}`, http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret", "pulsectl/test", time.Second, server.Client())
	started := time.Now()
	err := client.Get(context.Background(), "/api/v1/monitors", nil)
	elapsed := time.Since(started)
	apiErr, ok := AsError(err)
	if !ok || apiErr.Code != "TEMPORARY" {
		t.Fatalf("error = %#v", err)
	}
	if apiErr.RetryAfter != time.Duration(math.MaxInt64) {
		t.Fatalf("RetryAfter = %v, want MaxInt64", apiErr.RetryAfter)
	}
	// delay > maxRetryDelay, so the client must not sleep-and-retry.
	if got := attempts.Load(); got != 1 {
		t.Fatalf("attempts = %d, want 1 (no immediate retry on oversized Retry-After)", got)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("elapsed = %v, oversized Retry-After should not sleep full delay", elapsed)
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
