package command

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/0xSMW/pulse-uptime/cli/internal/api"
	"github.com/0xSMW/pulse-uptime/cli/internal/auth"
	"github.com/0xSMW/pulse-uptime/cli/internal/buildinfo"
	"github.com/0xSMW/pulse-uptime/cli/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func TestFullAccessRequiresEveryScope(t *testing.T) {
	all := []string{"config:read", "config:write", "dependencies:read", "dependencies:write", "incidents:read", "monitors:read", "monitors:write", "notifications:test", "reports:read", "reports:write", "status:read", "tokens:manage"}
	if !fullAccess(all) {
		t.Fatalf("full scope set was not recognized as full access")
	}
	if fullAccess(all[:len(all)-1]) {
		t.Fatalf("partial scope set was recognized as full access")
	}
	missingDependencies := append([]string{}, all...)
	missingDependencies[2] = "monitors:read"
	if fullAccess(missingDependencies) {
		t.Fatalf("scope set without dependencies:read was recognized as full access")
	}
}

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

func TestMeWithoutCredentialRequiresInteractiveAuthorization(t *testing.T) {
	t.Setenv("PULSECTL_URL", "https://pulse.example.com")
	t.Setenv("PULSECTL_TOKEN", "")
	t.Setenv("PULSECTL_OUTPUT", "json")
	code, stdout, stderr := execute(t, "me")
	if code != ExitPermission || stdout != "" {
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
	if doc.Error.Code != "INTERACTIVE_AUTH_REQUIRED" {
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

func TestReportScopeDenialIncludesRolloutHint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"Error","error":{"code":"SCOPE_DENIED","message":"Scope denied","details":{"scope":"reports:read"},"requestId":"req_scope"}}`)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", "pulse_live_legacy")
	t.Setenv("PULSECTL_OUTPUT", "json")
	code, _, stderr := execute(t, "report", "list")
	if code != ExitPermission || !strings.Contains(stderr, `"code": "SCOPE_DENIED"`) {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(stderr, "token lacks reports:*") || !strings.Contains(stderr, "re-run pulsectl login") {
		t.Fatalf("hint missing from stderr: %s", stderr)
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
	for _, path := range []string{"auth login", "context remove", "token create", "monitor watch", "group rename", "incident get", "incident promote", "report create", "report publish", "status-page set", "status-page apply", "config apply", "notification test", "status", "doctor", "completion", "version", "dependency catalog", "dependency add", "dependency backfill", "dependency remove"} {
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
	if got.SchemaVersion != 1 || got.Binary != "pulsectl" || len(got.Commands) != 57 {
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

func TestJSONHelpMarksRequiredFlagsAndMutationMetadata(t *testing.T) {
	t.Setenv("PULSECTL_OUTPUT", "json")
	_, stdout, _ := execute(t, "help", "monitor", "create", "--output", "json")
	var got manifest
	if err := json.Unmarshal([]byte(stdout), &got); err != nil || len(got.Commands) != 1 {
		t.Fatalf("manifest: %v %s", err, stdout)
	}
	item := got.Commands[0]
	if !item.Idempotent || item.RequiredScope != "monitors:write" || len(item.ExitCodes) == 0 {
		t.Fatalf("metadata missing: %#v", item)
	}
	required := map[string]bool{}
	for _, flag := range item.Flags {
		if flag.Required {
			required[flag.Name] = true
		}
		if flag.Description == "" {
			t.Errorf("flag %s has no description", flag.Name)
		}
	}
	for _, name := range []string{"id", "name", "url"} {
		if !required[name] {
			t.Errorf("%s not marked required", name)
		}
	}
}

func TestJSONHelpIncludesGroupContract(t *testing.T) {
	t.Setenv("PULSECTL_OUTPUT", "json")
	_, stdout, _ := execute(t, "help", "group", "create", "--output", "json")
	var got manifest
	if err := json.Unmarshal([]byte(stdout), &got); err != nil || len(got.Commands) != 1 {
		t.Fatalf("manifest: %v %s", err, stdout)
	}
	item := got.Commands[0]
	if !item.Idempotent || item.RequiredScope != "monitors:write" {
		t.Fatalf("group create metadata missing: %#v", item)
	}
	required := map[string]bool{}
	for _, flag := range item.Flags {
		required[flag.Name] = flag.Required
	}
	if !required["id"] || !required["name"] {
		t.Fatalf("required flags = %#v", required)
	}
}

type testCredentialStore struct {
	mu    sync.Mutex
	token string
}

func (s *testCredentialStore) Get(_, _ string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token == "" {
		return "", auth.ErrCredentialNotFound
	}
	return s.token, nil
}
func (s *testCredentialStore) Set(_, _, token string) error {
	s.mu.Lock()
	s.token = token
	s.mu.Unlock()
	return nil
}
func (s *testCredentialStore) Delete(_, _ string) error {
	s.mu.Lock()
	s.token = ""
	s.mu.Unlock()
	return nil
}

func TestInteractiveMeLinksInstallationAndStoresSession(t *testing.T) {
	store := &testCredentialStore{}
	var pollCount int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/cli-auth/device":
			if r.Header.Get("Authorization") != "" {
				t.Error("anonymous device request included Authorization")
			}
			body, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(body), `"clientName":"pulsectl"`) || !strings.Contains(string(body), `"scopeProfile":"administrator"`) {
				t.Errorf("unexpected device body: %s", body)
			}
			fmt.Fprintf(w, `{"apiVersion":"v1","kind":"DeviceAuthorization","data":{"deviceCode":"device-secret","userCode":"ABCD-EFGH","verificationUri":%q,"verificationUriComplete":%q,"expiresIn":600,"interval":1},"meta":{"requestId":"req_device"}}`, serverURL(r), serverURL(r)+"?user_code=ABCD-EFGH")
		case "/api/v1/cli-auth/token":
			pollCount++
			if pollCount == 1 {
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprint(w, `{"apiVersion":"v1","kind":"Error","error":{"code":"authorization_pending","message":"pending","details":{},"requestId":"req_pending"}}`)
				return
			}
			fmt.Fprint(w, `{"apiVersion":"v1","kind":"CliSession","data":{"token":"session-secret","tokenType":"Bearer","expiresAt":"2026-08-01T00:00:00Z","scopes":["monitors:read"]},"meta":{"requestId":"req_token"}}`)
		case "/api/v1/me":
			if r.Header.Get("Authorization") != "Bearer session-secret" {
				t.Error("me request did not use stored session")
			}
			fmt.Fprint(w, `{"apiVersion":"v1","kind":"Me","data":{"principalType":"cli_session","email":"operator@example.com","tokenId":null,"tokenName":null,"scopes":["monitors:read"],"installation":{"id":"ins_1","name":"Test Mac","platform":"darwin","arch":"arm64","clientVersion":"0.1.0-dev","linkedAt":"2026-07-18T00:00:00Z"}},"meta":{"requestId":"req_me"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	t.Setenv("PULSECTL_TOKEN", "")
	t.Setenv("PULSECTL_OUTPUT", "json")
	var stdout, stderr bytes.Buffer
	app := New(Options{In: strings.NewReader(""), Out: &stdout, Err: &stderr, StdinTTY: true, ConfigPath: t.TempDir() + "/config.yaml", Credentials: store, OpenBrowser: func(context.Context, string) error { t.Fatal("browser should not open with --no-browser"); return nil }, PollWait: func(context.Context, time.Duration) error { return nil }})
	code := app.Execute([]string{"me", "--server", server.URL, "--no-browser"})
	if code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr.String())
	}
	if store.token != "session-secret" || pollCount != 2 {
		t.Fatalf("stored=%q polls=%d", store.token, pollCount)
	}
	if strings.Contains(stdout.String(), "session-secret") || strings.Contains(stderr.String(), "session-secret") || strings.Contains(stdout.String(), "device-secret") || strings.Contains(stderr.String(), "device-secret") {
		t.Fatal("device or session secret leaked")
	}
	if !strings.Contains(stdout.String(), `"principalType": "cli_session"`) || !strings.Contains(stderr.String(), "Enter code: ABCD-EFGH") {
		t.Fatalf("stdout=%s stderr=%s", stdout.String(), stderr.String())
	}
}

func TestNoninteractiveMeDoesNotStartDeviceAuthorization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("noninteractive me made request %s %s", r.Method, r.URL.Path)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_TOKEN", "")
	var stdout, stderr bytes.Buffer
	app := New(Options{
		In:          strings.NewReader(""),
		Out:         &stdout,
		Err:         &stderr,
		StdinTTY:    false,
		ConfigPath:  t.TempDir() + "/config.yaml",
		Credentials: &testCredentialStore{},
		OpenBrowser: func(context.Context, string) error {
			t.Fatal("noninteractive me opened a browser")
			return nil
		},
	})
	code := app.Execute([]string{"me", "--server", server.URL})
	if code != ExitPermission {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "INTERACTIVE_AUTH_REQUIRED") {
		t.Fatalf("stderr=%s", stderr.String())
	}
}

func TestMonitorCreateSendsIdempotentMutation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/monitors" || r.Header.Get("Idempotency-Key") == "" {
			t.Errorf("unexpected mutation %s %s key=%q", r.Method, r.URL.Path, r.Header.Get("Idempotency-Key"))
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"id":"api"`) || !strings.Contains(string(body), `"url":"https://example.com"`) {
			t.Errorf("unexpected body: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"Monitor","data":{"id":"api","name":"API","url":"https://example.com"},"meta":{"requestId":"req_create"}}`)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", "pulse_live_test")
	t.Setenv("PULSECTL_OUTPUT", "json")
	code, stdout, stderr := execute(t, "monitor", "create", "--id", "api", "--name", "API", "--url", "https://example.com")
	if code != 0 || stderr != "" || !strings.Contains(stdout, `"kind": "Monitor"`) {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
}

func TestMonitorTestFailureReturnsExitFour(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"MonitorTest","data":{"successful":false},"meta":{"requestId":"req_test"}}`)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", "pulse_live_test")
	t.Setenv("PULSECTL_OUTPUT", "json")
	code, stdout, stderr := execute(t, "monitor", "test", "api")
	if code != ExitConditionFailed || !strings.Contains(stdout, `"successful": false`) || !strings.Contains(stderr, `"code": "MONITOR_TEST_FAILED"`) {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
	}
}

func TestTokenStdinAuthenticatesWithoutKeyring(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer stdin-secret" {
			t.Error("stdin token was not used")
		}
		fmt.Fprint(w, `{"apiVersion":"v1","kind":"Me","data":{"principalType":"api_token","email":null,"tokenId":"tok","tokenName":"stdin","scopes":[],"installation":null},"meta":{}}`)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", "")
	t.Setenv("PULSECTL_OUTPUT", "json")
	var stdout, stderr bytes.Buffer
	app := New(Options{In: strings.NewReader("stdin-secret\n"), Out: &stdout, Err: &stderr, ConfigPath: t.TempDir() + "/config.yaml", Credentials: &testCredentialStore{}})
	if code := app.Execute([]string{"me", "--token-stdin"}); code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr.String())
	}
	if strings.Contains(stdout.String(), "stdin-secret") || strings.Contains(stderr.String(), "stdin-secret") {
		t.Fatal("stdin token leaked")
	}
}

func TestTokenStdinRejectsStdinPayloadFlags(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		t.Errorf("guarded command reached the server: %s %s", r.Method, r.URL.Path)
	}))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", "")
	t.Setenv("PULSECTL_OUTPUT", "json")
	cases := [][]string{
		{"config", "validate", "--file", "-"},
		{"config", "plan", "--file", "-"},
		{"config", "apply", "--file", "-"},
		{"status-page", "apply", "--file", "-"},
		{"report", "create", "--type", "incident", "--title", "API outage", "--status", "investigating", "--message-file", "-"},
		{"report", "post", "rep_1", "--status", "monitoring", "--message-file", "-"},
		{"report", "edit-update", "rep_1", "upd_1", "--message-file", "-"},
	}
	for _, args := range cases {
		var stdout, stderr bytes.Buffer
		app := New(Options{In: strings.NewReader("stdin-secret\n"), Out: &stdout, Err: &stderr, ConfigPath: t.TempDir() + "/config.yaml", Credentials: &testCredentialStore{}})
		code := app.Execute(append([]string{"--token-stdin"}, args...))
		if code != ExitInvalidInput || !strings.Contains(stderr.String(), "STDIN_CONFLICT") {
			t.Errorf("%v: code=%d stderr=%s", args, code, stderr.String())
		}
		if strings.Contains(stdout.String(), "stdin-secret") || strings.Contains(stderr.String(), "stdin-secret") {
			t.Errorf("%v: stdin token leaked", args)
		}
	}
}

func TestTokenStdinGuardCoversEveryStdinConsumingCommand(t *testing.T) {
	app := New(Options{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard, ConfigPath: t.TempDir() + "/missing.yaml"})
	guarded := map[string]bool{}
	for _, name := range stdinPayloadFlags {
		guarded[name] = true
	}
	for _, cmd := range leafCommands(app.Root()) {
		supportsStdin := cmd.Annotations["supportsStdin"] == "true"
		hasGuardedFlag := false
		cmd.Flags().VisitAll(func(flag *pflag.Flag) {
			readsStdin := strings.Contains(flag.Usage, "- for stdin")
			if readsStdin && !guarded[flag.Name] {
				t.Errorf("%s --%s reads stdin but is missing from stdinPayloadFlags", cmd.CommandPath(), flag.Name)
			}
			if readsStdin && !supportsStdin {
				t.Errorf("%s --%s reads stdin but the command lacks the supportsStdin annotation", cmd.CommandPath(), flag.Name)
			}
			if readsStdin && guarded[flag.Name] {
				hasGuardedFlag = true
			}
		})
		if supportsStdin && !hasGuardedFlag {
			t.Errorf("%s is annotated supportsStdin but declares no guarded stdin flag", cmd.CommandPath())
		}
	}
}

func TestRedirectedDefaultsUseJSONAndJSONL(t *testing.T) {
	app := New(Options{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard, StdoutTTY: false, ConfigPath: t.TempDir() + "/config.yaml"})
	if got := app.outputFor("table"); got != "json" {
		t.Fatalf("ordinary output=%q", got)
	}
	if got := app.outputFor("yaml"); got != "yaml" {
		t.Fatalf("export output=%q", got)
	}
	if got := app.monitorDependencies().WatchFormat(); got != "jsonl" {
		t.Fatalf("watch output=%q", got)
	}
}

func TestCanceledRequestReturnsInterruptedExit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	t.Setenv("PULSECTL_URL", server.URL)
	t.Setenv("PULSECTL_TOKEN", "pulse_live_test")
	t.Setenv("PULSECTL_OUTPUT", "json")
	var stdout, stderr bytes.Buffer
	app := New(Options{In: strings.NewReader(""), Out: &stdout, Err: &stderr, ConfigPath: t.TempDir() + "/config.yaml"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if code := app.ExecuteContext(ctx, []string{"me"}); code != ExitInterrupted {
		t.Fatalf("code=%d stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), `"code": "INTERRUPTED"`) {
		t.Fatalf("stderr=%s", stderr.String())
	}
}

func TestNewClientProgressHookGate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()

	cases := []struct {
		name      string
		stderrTTY bool
		debug     bool
		term      string
		wantSpin  bool
	}{
		{"tty and not debug installs the spinner", true, false, "", true},
		{"non-tty does not install the spinner", false, false, "", false},
		{"debug does not install the spinner", true, true, "", false},
		{"dumb terminal does not install the spinner", true, false, "dumb", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TERM", tc.term)
			var stderr bytes.Buffer
			app := New(Options{In: strings.NewReader(""), Out: io.Discard, Err: &stderr, StderrTTY: tc.stderrTTY, ConfigPath: t.TempDir() + "/config.yaml"})
			app.debug = tc.debug
			client := app.newClient(config.Resolved{Server: server.URL, Timeout: time.Second}, "")
			if _, err := client.DoRaw(context.Background(), api.Request{Method: http.MethodGet, Path: "/api/v1/example"}); err != nil {
				t.Fatal(err)
			}
			if gotSpin := strings.Contains(stderr.String(), "\x1b[K"); gotSpin != tc.wantSpin {
				t.Fatalf("stderr = %q, want spinner=%v", stderr.String(), tc.wantSpin)
			}
		})
	}
}

func serverURL(r *http.Request) string { return "http://" + r.Host + "/cli/authorize" }

func execute(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	app := New(Options{In: strings.NewReader(""), Out: &stdout, Err: &stderr, ConfigPath: t.TempDir() + "/missing.yaml"})
	code := app.Execute(args)
	return code, stdout.String(), stderr.String()
}

func TestRootVersionFlagPrintsLocalVersion(t *testing.T) {
	for _, flag := range []string{"--version", "-v"} {
		code, stdout, stderr := execute(t, flag)
		if code != 0 || stderr != "" {
			t.Fatalf("%s: code=%d stderr=%q", flag, code, stderr)
		}
		want := "pulsectl version " + buildinfo.Version + "\n"
		if stdout != want {
			t.Fatalf("%s printed %q, want %q", flag, stdout, want)
		}
	}
}

func TestAliasesResolveToCanonicalCommands(t *testing.T) {
	root := New(Options{}).Root()
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"whoami"}, "pulsectl me"},
		{[]string{"st"}, "pulsectl status"},
		{[]string{"monitors", "ls"}, "pulsectl monitor list"},
		{[]string{"mon", "rm"}, "pulsectl monitor archive"},
		{[]string{"deps", "show"}, "pulsectl dependency get"},
		{[]string{"incidents", "ls"}, "pulsectl incident list"},
		{[]string{"reports", "new"}, "pulsectl report create"},
		{[]string{"tokens", "delete"}, "pulsectl token revoke"},
		{[]string{"ctx", "get"}, "pulsectl context show"},
		{[]string{"auth", "logout"}, "pulsectl auth unlink"},
		{[]string{"statuspage", "update"}, "pulsectl status-page set"},
		{[]string{"groups", "add"}, "pulsectl group create"},
	}
	for _, tc := range cases {
		target, _, err := root.Find(tc.args)
		if err != nil {
			t.Fatalf("%v did not resolve: %v", tc.args, err)
		}
		if got := target.CommandPath(); got != tc.want {
			t.Fatalf("%v resolved to %q, want %q", tc.args, got, tc.want)
		}
	}
}

// TestNoSiblingAliasCollisions sweeps the whole tree and asserts every name
// and alias is claimed by exactly one child within each parent, so a new
// alias can never silently shadow a sibling command.
func TestNoSiblingAliasCollisions(t *testing.T) {
	root := New(Options{}).Root()
	var visit func(cmd *cobra.Command)
	visit = func(cmd *cobra.Command) {
		claimed := map[string]string{}
		for _, child := range cmd.Commands() {
			for _, token := range append([]string{child.Name()}, child.Aliases...) {
				if owner, ok := claimed[token]; ok {
					t.Errorf("%s: %q is claimed by both %q and %q", cmd.CommandPath(), token, owner, child.Name())
					continue
				}
				claimed[token] = child.Name()
			}
			visit(child)
		}
	}
	visit(root)
}
