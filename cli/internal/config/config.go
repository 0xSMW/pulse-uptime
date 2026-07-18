package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const DefaultTimeout = 15 * time.Second

type Context struct {
	Server  string        `yaml:"server"`
	Output  string        `yaml:"output,omitempty"`
	Timeout time.Duration `yaml:"-"`
}

func (c Context) MarshalYAML() (any, error) {
	type rawContext struct {
		Server  string `yaml:"server"`
		Output  string `yaml:"output,omitempty"`
		Timeout string `yaml:"timeout,omitempty"`
	}
	raw := rawContext{Server: c.Server, Output: c.Output}
	if c.Timeout > 0 {
		raw.Timeout = c.Timeout.String()
	}
	return raw, nil
}

func (c *Context) UnmarshalYAML(node *yaml.Node) error {
	var raw struct {
		Server  string `yaml:"server"`
		Output  string `yaml:"output"`
		Timeout string `yaml:"timeout"`
	}
	if err := node.Decode(&raw); err != nil {
		return err
	}
	c.Server, c.Output = raw.Server, raw.Output
	if raw.Timeout != "" {
		d, err := time.ParseDuration(raw.Timeout)
		if err != nil {
			return fmt.Errorf("invalid context timeout %q: %w", raw.Timeout, err)
		}
		c.Timeout = d
	}
	return nil
}

type File struct {
	Version        int                `yaml:"version"`
	Installation   Installation       `yaml:"installation,omitempty"`
	CurrentContext string             `yaml:"currentContext"`
	Contexts       map[string]Context `yaml:"contexts"`
}

type Installation struct {
	ID   string `yaml:"id"`
	Name string `yaml:"name"`
}

type NamedContext struct {
	Name string
	Context
}

type Overrides struct {
	ConfigPath string
	Context    string
	Server     string
	Output     string
	Timeout    time.Duration
	TimeoutSet bool
}

type Resolved struct {
	Context string
	Server  string
	Token   string
	Output  string
	Timeout time.Duration
}

func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find user config directory: %w", err)
	}
	return filepath.Join(dir, "pulsectl", "config.yaml"), nil
}

func Resolve(o Overrides, stdoutTTY bool) (Resolved, error) {
	path := o.ConfigPath
	if path == "" {
		var err error
		path, err = DefaultPath()
		if err != nil {
			return Resolved{}, err
		}
	}
	f, err := Load(path)
	if err != nil {
		return Resolved{}, err
	}

	contextName := first(o.Context, os.Getenv("PULSECTL_CONTEXT"), f.CurrentContext)
	ctx := f.Contexts[contextName]
	server := first(o.Server, os.Getenv("PULSECTL_URL"), ctx.Server)
	if server != "" {
		server, err = NormalizeServer(server)
		if err != nil {
			return Resolved{}, err
		}
	}

	defaultOutput := "json"
	if stdoutTTY {
		defaultOutput = "table"
	}
	output := first(o.Output, os.Getenv("PULSECTL_OUTPUT"), ctx.Output, defaultOutput)
	if !validOutput(output) {
		return Resolved{}, fmt.Errorf("invalid output format %q", output)
	}

	timeout := DefaultTimeout
	if ctx.Timeout > 0 {
		timeout = ctx.Timeout
	}
	if raw := os.Getenv("PULSECTL_TIMEOUT"); raw != "" {
		timeout, err = time.ParseDuration(raw)
		if err != nil {
			return Resolved{}, fmt.Errorf("invalid PULSECTL_TIMEOUT: %w", err)
		}
	}
	if o.TimeoutSet {
		timeout = o.Timeout
	}
	if timeout <= 0 {
		return Resolved{}, errors.New("timeout must be greater than zero")
	}

	return Resolved{Context: contextName, Server: server, Token: os.Getenv("PULSECTL_TOKEN"), Output: output, Timeout: timeout}, nil
}

// Load reads a non-secret pulsectl configuration file. A missing file is an
// empty version-one configuration.
func Load(path string) (File, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return File{Version: 1, Contexts: map[string]Context{}}, nil
	}
	if err != nil {
		return File{}, fmt.Errorf("read config: %w", err)
	}
	var f File
	if err := yaml.Unmarshal(b, &f); err != nil {
		return File{}, fmt.Errorf("parse config: %w", err)
	}
	if f.Version != 1 {
		return File{}, fmt.Errorf("unsupported config version %d", f.Version)
	}
	if f.Contexts == nil {
		f.Contexts = map[string]Context{}
	}
	return f, nil
}

// Save atomically persists a non-secret pulsectl configuration with private
// file permissions. Secret tokens must never be added to File.
func Save(path string, f File) error {
	if path == "" {
		return errors.New("config path is required")
	}
	if f.Version == 0 {
		f.Version = 1
	}
	if f.Version != 1 {
		return fmt.Errorf("unsupported config version %d", f.Version)
	}
	if f.Contexts == nil {
		f.Contexts = map[string]Context{}
	}
	if f.CurrentContext != "" {
		if _, ok := f.Contexts[f.CurrentContext]; !ok {
			return fmt.Errorf("current context %q does not exist", f.CurrentContext)
		}
	}
	for name, context := range f.Contexts {
		if err := ValidateContextName(name); err != nil {
			return err
		}
		normalized, err := NormalizeServer(context.Server)
		if err != nil {
			return fmt.Errorf("context %q: %w", name, err)
		}
		context.Server = normalized
		if context.Output != "" && !validOutput(context.Output) {
			return fmt.Errorf("context %q has invalid output format %q", name, context.Output)
		}
		if context.Timeout < 0 {
			return fmt.Errorf("context %q timeout must be greater than zero", name)
		}
		f.Contexts[name] = context
	}

	data, err := yaml.Marshal(f)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".config-*.yaml")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("protect temporary config: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temporary config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temporary config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary config: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

func ValidateContextName(name string) error {
	if name == "" {
		return errors.New("context name is required")
	}
	if len(name) > 64 {
		return errors.New("context name cannot exceed 64 characters")
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return fmt.Errorf("invalid context name %q", name)
	}
	return nil
}

func (f *File) SetContext(name string, context Context, activate bool) error {
	if err := ValidateContextName(name); err != nil {
		return err
	}
	server, err := NormalizeServer(context.Server)
	if err != nil {
		return err
	}
	context.Server = server
	if context.Output != "" && !validOutput(context.Output) {
		return fmt.Errorf("invalid output format %q", context.Output)
	}
	if context.Timeout < 0 {
		return errors.New("timeout must be greater than zero")
	}
	if f.Contexts == nil {
		f.Contexts = map[string]Context{}
	}
	f.Contexts[name] = context
	if activate || f.CurrentContext == "" {
		f.CurrentContext = name
	}
	if f.Version == 0 {
		f.Version = 1
	}
	return nil
}

func (f File) GetContext(name string) (Context, bool) {
	context, ok := f.Contexts[name]
	return context, ok
}

func (f File) ListContexts() []NamedContext {
	names := make([]string, 0, len(f.Contexts))
	for name := range f.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	contexts := make([]NamedContext, 0, len(names))
	for _, name := range names {
		contexts = append(contexts, NamedContext{Name: name, Context: f.Contexts[name]})
	}
	return contexts
}

func (f *File) UseContext(name string) error {
	if _, ok := f.Contexts[name]; !ok {
		return fmt.Errorf("context %q does not exist", name)
	}
	f.CurrentContext = name
	return nil
}

func (f *File) RemoveContext(name string) error {
	if _, ok := f.Contexts[name]; !ok {
		return fmt.Errorf("context %q does not exist", name)
	}
	delete(f.Contexts, name)
	if f.CurrentContext == name {
		f.CurrentContext = ""
	}
	return nil
}

// EnsureServerContext creates and activates a hostname-derived context when no
// existing context targets server. It returns the selected name and whether the
// file changed.
func (f *File) EnsureServerContext(server string) (string, bool, error) {
	normalized, err := NormalizeServer(server)
	if err != nil {
		return "", false, err
	}
	for name, context := range f.Contexts {
		existing, normalizeErr := NormalizeServer(context.Server)
		if normalizeErr == nil && existing == normalized {
			changed := f.CurrentContext != name
			f.CurrentContext = name
			return name, changed, nil
		}
	}
	u, _ := url.Parse(normalized)
	base := strings.ToLower(u.Hostname())
	if base == "" {
		base = "server"
	}
	name := base
	for suffix := 2; ; suffix++ {
		if _, exists := f.Contexts[name]; !exists {
			break
		}
		name = fmt.Sprintf("%s-%d", base, suffix)
	}
	if err := f.SetContext(name, Context{Server: normalized}, true); err != nil {
		return "", false, err
	}
	return name, true, nil
}

func NormalizeServer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil {
		return "", fmt.Errorf("invalid server URL %q", raw)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("server URL cannot contain a query or fragment")
	}
	host := strings.ToLower(u.Hostname())
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", errors.New("server URL must use HTTPS outside localhost")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/"), nil
}

func first(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func validOutput(v string) bool {
	switch v {
	case "table", "json", "jsonl", "yaml", "tsv":
		return true
	default:
		return false
	}
}
