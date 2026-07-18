package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResolvePrecedence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := []byte("version: 1\ncurrentContext: production\ncontexts:\n  production:\n    server: https://context.example.com/\n    output: table\n    timeout: 30s\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PULSECTL_CONTEXT", "production")
	t.Setenv("PULSECTL_URL", "https://environment.example.com/")
	t.Setenv("PULSECTL_OUTPUT", "yaml")
	t.Setenv("PULSECTL_TIMEOUT", "20s")
	t.Setenv("PULSECTL_TOKEN", "pulse_live_secret")

	got, err := Resolve(Overrides{ConfigPath: path, Server: "https://flag.example.com/", Output: "json", Timeout: 5 * time.Second, TimeoutSet: true}, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.Server != "https://flag.example.com" || got.Output != "json" || got.Timeout != 5*time.Second || got.Token != "pulse_live_secret" {
		t.Fatalf("unexpected resolution: %#v", got)
	}
}

func TestResolveUsesContextThenDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	contents := []byte("version: 1\ncurrentContext: local\ncontexts:\n  local:\n    server: http://localhost:3000/\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"PULSECTL_CONTEXT", "PULSECTL_URL", "PULSECTL_OUTPUT", "PULSECTL_TIMEOUT", "PULSECTL_TOKEN"} {
		t.Setenv(key, "")
	}
	got, err := Resolve(Overrides{ConfigPath: path}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got.Server != "http://localhost:3000" || got.Output != "json" || got.Timeout != DefaultTimeout {
		t.Fatalf("unexpected resolution: %#v", got)
	}
}

func TestNormalizeServerRequiresHTTPSOutsideLocalhost(t *testing.T) {
	if _, err := NormalizeServer("http://pulse.example.com"); err == nil {
		t.Fatal("expected non-local HTTP URL to fail")
	}
	if got, err := NormalizeServer("http://127.0.0.1:3000/"); err != nil || got != "http://127.0.0.1:3000" {
		t.Fatalf("local URL: got %q, err %v", got, err)
	}
}
