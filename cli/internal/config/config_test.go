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

func TestSaveLoadAndContextCRUD(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "config.yaml")
	f := File{Installation: Installation{ID: "ins_local_test", Name: "Test Mac"}}
	if err := f.SetContext("production", Context{Server: "https://pulse.example.com/", Output: "table", Timeout: 15 * time.Second}, true); err != nil {
		t.Fatal(err)
	}
	if err := f.SetContext("local", Context{Server: "http://localhost:3000"}, false); err != nil {
		t.Fatal(err)
	}
	if err := Save(path, f); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %o", info.Mode().Perm())
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Installation != f.Installation || loaded.CurrentContext != "production" || loaded.Contexts["production"].Timeout != 15*time.Second {
		t.Fatalf("unexpected round trip: %#v", loaded)
	}
	if got := loaded.ListContexts(); len(got) != 2 || got[0].Name != "local" || got[1].Name != "production" {
		t.Fatalf("contexts not sorted: %#v", got)
	}
	if err := loaded.RemoveContext("production"); err != nil || loaded.CurrentContext != "" {
		t.Fatalf("remove active context: current=%q err=%v", loaded.CurrentContext, err)
	}
}

func TestEnsureServerContextReusesNormalizedServer(t *testing.T) {
	f := File{Version: 1, Contexts: map[string]Context{"prod": {Server: "https://pulse.example.com/"}}}
	name, changed, err := f.EnsureServerContext("https://pulse.example.com")
	if err != nil || name != "prod" || !changed || f.CurrentContext != "prod" {
		t.Fatalf("reuse: name=%q changed=%v current=%q err=%v", name, changed, f.CurrentContext, err)
	}
	name, changed, err = f.EnsureServerContext("https://another.example.com")
	if err != nil || name != "another.example.com" || !changed || f.Contexts[name].Server != "https://another.example.com" {
		t.Fatalf("create: name=%q changed=%v file=%#v err=%v", name, changed, f, err)
	}
}
