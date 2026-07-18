package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
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
	CurrentContext string             `yaml:"currentContext"`
	Contexts       map[string]Context `yaml:"contexts"`
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
	f, err := load(path)
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

func load(path string) (File, error) {
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
