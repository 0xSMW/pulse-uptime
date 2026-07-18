package command

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/productos-ai/pulse-uptime/cli/internal/api"
	"github.com/productos-ai/pulse-uptime/cli/internal/buildinfo"
)

func TestMeCallsCanonicalEndpointWithHeaders(t *testing.T) {
	token := "pulse_live_do_not_print"
	uuid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/me" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Error("unexpected Authorization header")
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q", got)
		}
		if got := r.Header.Get("User-Agent"); got != buildinfo.UserAgent() {
			t.Errorf("User-Agent = %q", got)
		}
		if got := r.Header.Get("X-Request-ID"); !uuid.MatchString(got) {
			t.Errorf("X-Request-ID = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"Me","data":{"principalType":"api_token","email":null,"tokenId":"tok_1","tokenName":"deploy","scopes":["status:read","monitors:read"],"installation":null}}`)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", token)
	t.Setenv("PULSECTL_OUTPUT", "json")

	code, stdout, stderr := execute(t, "me")
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d stderr=%q", code, stderr)
	}
	if strings.Contains(stdout, token) || strings.Contains(stderr, token) {
		t.Fatal("token leaked into command output")
	}
	var got meEnvelope
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, stdout)
	}
	if got.APIVersion != "v1" || got.Kind != "Me" || got.Data.Server != server.URL || got.Data.TokenName == nil || *got.Data.TokenName != "deploy" {
		t.Fatalf("unexpected output: %#v", got)
	}
	if strings.Join(got.Data.Scopes, ",") != "monitors:read,status:read" {
		t.Fatalf("scopes were not deterministic: %#v", got.Data.Scopes)
	}
}

func TestMeWithoutCredentialReturnsCanonicalExitThree(t *testing.T) {
	t.Setenv("PULSECTL_URL", "https://pulse.example.com")
	t.Setenv("PULSECTL_TOKEN", "")
	t.Setenv("PULSECTL_OUTPUT", "json")
	code, stdout, stderr := execute(t, "me")
	if code != 3 || stdout != "" {
		t.Fatalf("code=%d stdout=%q", code, stdout)
	}
	var doc struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(stderr), &doc); err != nil {
		t.Fatalf("invalid JSON error: %v\n%s", err, stderr)
	}
	if doc.Error.Code != "AUTHENTICATION_REQUIRED" {
		t.Fatalf("error code = %q", doc.Error.Code)
	}
}

func TestMeMapsServiceErrorsAndPreservesRequestID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"Error","error":{"code":"SCOPE_DENIED","message":"Scope denied","details":{"scope":"status:read"},"requestId":"req_test"}}`)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", "pulse_live_secret")
	t.Setenv("PULSECTL_OUTPUT", "json")
	code, _, stderr := execute(t, "me")
	if code != 7 || !strings.Contains(stderr, `"code": "SCOPE_DENIED"`) || !strings.Contains(stderr, `"requestId": "req_test"`) {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if strings.Contains(stderr, "pulse_live_secret") {
		t.Fatal("token leaked into error")
	}
}

func TestMapAPIErrorUsesStableExitCodes(t *testing.T) {
	cases := map[int]int{0: 9, 400: 2, 401: 3, 403: 7, 404: 5, 408: 8, 409: 6, 412: 6, 422: 2, 429: 8, 503: 9}
	for status, want := range cases {
		err := mapAPIError(&api.Error{Status: status, Code: "TEST", Message: "test"})
		var got *commandError
		if !errors.As(err, &got) || got.Exit != want {
			t.Errorf("status %d: got %#v, want exit %d", status, got, want)
		}
	}
}

func TestRootHelpListsEveryLeafAndFitsBudget(t *testing.T) {
	code, stdout, stderr := execute(t, "--help")
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d stderr=%q", code, stderr)
	}
	for _, path := range []string{"auth login", "context remove", "token create", "monitor watch", "incident get", "config apply", "notification test", "status", "doctor", "completion", "version"} {
		if !strings.Contains(stdout, path) {
			t.Errorf("root help missing %q", path)
		}
	}
	if lines := strings.Count(stdout, "\n"); lines > 100 {
		t.Errorf("root help is %d lines", lines)
	}
}

func TestJSONHelpIsGeneratedFromCommandTree(t *testing.T) {
	t.Setenv("PULSECTL_OUTPUT", "")
	code, stdout, stderr := execute(t, "help", "--output", "json")
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d stderr=%q", code, stderr)
	}
	var got manifest
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatal(err)
	}
	if got.SchemaVersion != 1 || got.Binary != "pulsectl" || len(got.Commands) != 33 {
		t.Fatalf("incomplete manifest: %#v", got)
	}
	for _, item := range got.Commands {
		if len(item.Path) == 2 && item.Path[0] == "config" && item.Path[1] == "apply" {
			if !item.SupportsStdin {
				t.Fatal("config apply stdin support missing")
			}
			return
		}
	}
	t.Fatal("config apply missing from manifest")
}

func execute(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	app := New(Options{In: strings.NewReader(""), Out: &stdout, Err: &stderr, ConfigPath: t.TempDir() + "/missing.yaml"})
	code := app.Execute(args)
	return code, stdout.String(), stderr.String()
}
