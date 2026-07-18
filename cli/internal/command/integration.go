package command

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/productos-ai/pulse-uptime/cli/internal/api"
	"github.com/productos-ai/pulse-uptime/cli/internal/auth"
	"github.com/productos-ai/pulse-uptime/cli/internal/buildinfo"
	"github.com/productos-ai/pulse-uptime/cli/internal/command/adminops"
	"github.com/productos-ai/pulse-uptime/cli/internal/command/configops"
	"github.com/productos-ai/pulse-uptime/cli/internal/command/groupops"
	"github.com/productos-ai/pulse-uptime/cli/internal/command/monitorops"
	"github.com/productos-ai/pulse-uptime/cli/internal/command/readops"
	"github.com/productos-ai/pulse-uptime/cli/internal/config"
	"github.com/productos-ai/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
)

func (a *App) configPath() (string, error) {
	if a.opts.ConfigPath != "" {
		return a.opts.ConfigPath, nil
	}
	return config.DefaultPath()
}

func (a *App) runMe(ctx context.Context, noBrowser bool) error {
	if err := a.persistExplicitServer(); err != nil {
		return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
	}
	r, err := a.resolve()
	if err != nil {
		return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
	}
	if r.Server == "" {
		return cliError(ExitInvalidInput, "SERVER_REQUIRED", "service URL required. Set PULSECTL_URL or --server")
	}

	// Environment credentials are pure passthrough and never cause local writes.
	if r.Token != "" {
		return a.fetchAndRenderMe(ctx, r, r.Token)
	}
	if a.tokenStdin {
		credential, credentialErr := a.resolveCredential(r)
		if credentialErr != nil {
			return cliError(ExitAuthentication, "AUTHENTICATION_REQUIRED", authRequired)
		}
		return a.fetchAndRenderMe(ctx, r, credential.Token)
	}
	path, err := a.configPath()
	if err != nil {
		return cliError(ExitUnexpected, "CONFIG_ERROR", err.Error())
	}
	f, err := config.Load(path)
	if err != nil {
		return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
	}
	if f.Installation.ID != "" {
		credential, credentialErr := auth.ResolveCredential(r.Server, f.Installation.ID, "", a.credentials)
		if credentialErr == nil {
			err = a.fetchAndRenderMe(ctx, r, credential.Token)
			if err == nil || credential.Source == auth.CredentialSourceEnvironment || !a.opts.StdinTTY || !isAuthenticationError(err) {
				return err
			}
		} else if !errors.Is(credentialErr, auth.ErrCredentialNotFound) {
			return cliError(ExitUnexpected, "KEYRING_ERROR", credentialErr.Error())
		}
	}
	if !a.opts.StdinTTY {
		return cliError(ExitPermission, "INTERACTIVE_AUTH_REQUIRED", "interactive authorization required. Run pulsectl me in a terminal or set PULSECTL_TOKEN")
	}
	token, err := a.linkInstallation(ctx, r, noBrowser)
	if err != nil {
		return err
	}
	return a.fetchAndRenderMe(ctx, r, token)
}

func (a *App) fetchAndRenderMe(ctx context.Context, r config.Resolved, token string) error {
	c := a.newClient(r, token)
	var envelope meEnvelope
	if err := c.Get(ctx, "/api/v1/me", &envelope); err != nil {
		return mapAPIError(err)
	}
	if envelope.APIVersion == "" {
		envelope.APIVersion = "v1"
	}
	if envelope.Kind == "" {
		envelope.Kind = "Me"
	}
	if envelope.Data.PrincipalType == "" {
		envelope.Data.PrincipalType = envelope.Data.Type
	}
	envelope.Data.Type = ""
	envelope.Data.Server = r.Server
	sort.Strings(envelope.Data.Scopes)
	return a.renderMe(r.Output, envelope)
}

func (a *App) persistExplicitServer() error {
	flag := a.root.PersistentFlags().Lookup("server")
	if flag == nil || !flag.Changed || a.server == "" {
		return nil
	}
	path, err := a.configPath()
	if err != nil {
		return err
	}
	f, err := config.Load(path)
	if err != nil {
		return err
	}
	_, changed, err := f.EnsureServerContext(a.server)
	if err != nil || !changed {
		return err
	}
	return config.Save(path, f)
}

func (a *App) linkInstallation(ctx context.Context, r config.Resolved, noBrowser bool) (string, error) {
	path, err := a.configPath()
	if err != nil {
		return "", cliError(ExitUnexpected, "CONFIG_ERROR", err.Error())
	}
	installation, err := auth.EnsureInstallation(path, "")
	if err != nil {
		return "", cliError(ExitUnexpected, "INSTALLATION_ERROR", err.Error())
	}
	request, err := auth.NewDeviceRequest(installation, buildinfo.Version)
	if err != nil {
		return "", cliError(ExitUnexpected, "INSTALLATION_ERROR", err.Error())
	}
	client := a.newClient(r, "")
	var started api.Envelope[auth.DeviceAuthorization]
	if _, err := client.DoJSON(ctx, api.Request{Method: http.MethodPost, Path: "/api/v1/cli-auth/device", Body: request}, &started); err != nil {
		return "", mapAPIError(err)
	}
	if err := started.Data.Validate(); err != nil {
		return "", cliError(ExitUnexpected, "INVALID_RESPONSE", err.Error())
	}
	fmt.Fprintf(a.opts.Err, "Open %s\n\nEnter code: %s\n\nWaiting for approval...\n", started.Data.VerificationURI, started.Data.UserCode)
	if !noBrowser && a.opts.StdinTTY {
		if err := a.openBrowser(ctx, started.Data.VerificationURIComplete); err != nil {
			fmt.Fprintf(a.opts.Err, "Browser unavailable: %s\n", err)
		}
	}
	poller := auth.Poller{Wait: a.pollWait}
	session, err := poller.Poll(ctx, started.Data, func(ctx context.Context, body auth.DeviceTokenRequest) (auth.DeviceSession, error) {
		var result api.Envelope[auth.DeviceSession]
		_, exchangeErr := client.DoJSON(ctx, api.Request{Method: http.MethodPost, Path: "/api/v1/cli-auth/token", Body: body}, &result)
		if exchangeErr == nil {
			return result.Data, nil
		}
		if apiErr, ok := api.AsError(exchangeErr); ok {
			switch apiErr.Code {
			case string(auth.AuthorizationPending), string(auth.SlowDown), string(auth.AccessDenied), string(auth.ExpiredToken):
				return auth.DeviceSession{}, &auth.DeviceFlowError{Code: auth.DeviceErrorCode(apiErr.Code), Description: apiErr.Message}
			}
		}
		return auth.DeviceSession{}, exchangeErr
	})
	if err != nil {
		var flowErr *auth.DeviceFlowError
		if errors.As(err, &flowErr) {
			if flowErr.Code == auth.AccessDenied {
				return "", cliError(ExitPermission, "ACCESS_DENIED", "device authorization denied")
			}
			if flowErr.Code == auth.ExpiredToken {
				return "", cliError(ExitAuthentication, "EXPIRED_TOKEN", "device authorization expired")
			}
		}
		return "", mapAPIOrCLIError(err)
	}
	token := session.Token
	if err := a.credentials.Set(r.Server, installation.ID, token); err != nil {
		return "", cliError(ExitUnexpected, "KEYRING_ERROR", err.Error())
	}
	return token, nil
}

func (a *App) authGroup() *cobra.Command {
	group := adminops.NewAuthCommand(a.adminDependencies())
	var noBrowser, reauthorize bool
	login := &cobra.Command{Use: "login", Short: "Link this installation", Args: cobra.NoArgs, Annotations: map[string]string{"supportsOutput": "table,json,yaml"}, RunE: func(cmd *cobra.Command, _ []string) error {
		if err := a.persistExplicitServer(); err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
		}
		r, err := a.resolve()
		if err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
		}
		if r.Server == "" {
			return cliError(ExitInvalidInput, "SERVER_REQUIRED", "service URL required. Set PULSECTL_URL or --server")
		}
		if r.Token != "" {
			return cliError(ExitInvalidInput, "ENVIRONMENT_TOKEN_ACTIVE", "unset PULSECTL_TOKEN before linking a human session")
		}
		if !reauthorize {
			path, _ := a.configPath()
			f, _ := config.Load(path)
			if f.Installation.ID != "" {
				if credential, credentialErr := auth.ResolveCredential(r.Server, f.Installation.ID, "", a.credentials); credentialErr == nil {
					if fetchErr := a.fetchAndRenderMe(cmd.Context(), r, credential.Token); fetchErr == nil {
						return nil
					} else if !isAuthenticationError(fetchErr) {
						return fetchErr
					}
				}
			}
		}
		token, err := a.linkInstallation(cmd.Context(), r, noBrowser)
		if err != nil {
			return err
		}
		return a.fetchAndRenderMe(cmd.Context(), r, token)
	}}
	login.Flags().BoolVar(&noBrowser, "no-browser", false, "Print authorization instructions without opening a browser")
	login.Flags().BoolVar(&reauthorize, "reauthorize", false, "Force a new authorization")
	group.AddCommand(login)
	return group
}

func (a *App) contextGroup() *cobra.Command {
	group := &cobra.Command{Use: "context", Short: "Manage service contexts", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	group.AddCommand(a.contextAddCommand(), a.contextListCommand(), a.contextShowCommand(), a.contextUseCommand(), a.contextRemoveCommand())
	return group
}

func (a *App) contextAddCommand() *cobra.Command {
	var server, format string
	var timeout time.Duration
	var activate, force bool
	cmd := &cobra.Command{Use: "add <name>", Short: "Add a context", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if server == "" {
			return cliError(ExitInvalidInput, "INVALID_ARGUMENT", "--url is required")
		}
		path, _ := a.configPath()
		f, err := config.Load(path)
		if err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
		}
		if _, exists := f.Contexts[args[0]]; exists && !force {
			return cliError(ExitConflict, "CONTEXT_EXISTS", "context already exists; use --force to replace it")
		}
		if err := f.SetContext(args[0], config.Context{Server: server, Output: format, Timeout: timeout}, activate); err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONTEXT", err.Error())
		}
		if err := config.Save(path, f); err != nil {
			return cliError(ExitUnexpected, "CONFIG_ERROR", err.Error())
		}
		return output.Render(a.opts.Out, a.outputFor("table"), contextEnvelope(args[0], f.Contexts[args[0]], f.CurrentContext == args[0]))
	}}
	cmd.Flags().StringVar(&server, "url", "", "Service URL")
	cmd.Flags().StringVar(&format, "default-output", "", "Default output format")
	cmd.Flags().DurationVar(&timeout, "request-timeout", 0, "Default request timeout")
	cmd.Flags().BoolVar(&activate, "use", false, "Make this context active")
	cmd.Flags().BoolVar(&force, "force", false, "Replace an existing context")
	return cmd
}

func (a *App) contextListCommand() *cobra.Command {
	return &cobra.Command{Use: "list", Short: "List contexts", Args: cobra.NoArgs, RunE: func(_ *cobra.Command, _ []string) error {
		path, _ := a.configPath()
		f, err := config.Load(path)
		if err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
		}
		items := make([]any, 0, len(f.Contexts))
		for _, item := range f.ListContexts() {
			items = append(items, map[string]any{"name": item.Name, "server": item.Server, "output": item.Output, "timeout": durationString(item.Timeout), "current": item.Name == f.CurrentContext})
		}
		return output.Render(a.opts.Out, a.outputFor("table"), map[string]any{"apiVersion": "v1", "kind": "ContextList", "data": items})
	}}
}

func (a *App) contextShowCommand() *cobra.Command {
	return &cobra.Command{Use: "show [name]", Short: "Show a context", Args: cobra.MaximumNArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		path, _ := a.configPath()
		f, err := config.Load(path)
		if err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
		}
		name := f.CurrentContext
		if len(args) == 1 {
			name = args[0]
		}
		value, ok := f.GetContext(name)
		if !ok {
			return cliError(ExitNotFound, "CONTEXT_NOT_FOUND", "context not found")
		}
		return output.Render(a.opts.Out, a.outputFor("table"), contextEnvelope(name, value, name == f.CurrentContext))
	}}
}

func (a *App) contextUseCommand() *cobra.Command {
	return &cobra.Command{Use: "use <name>", Short: "Select the active context", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		path, _ := a.configPath()
		f, err := config.Load(path)
		if err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
		}
		if err := f.UseContext(args[0]); err != nil {
			return cliError(ExitNotFound, "CONTEXT_NOT_FOUND", err.Error())
		}
		if err := config.Save(path, f); err != nil {
			return cliError(ExitUnexpected, "CONFIG_ERROR", err.Error())
		}
		return output.Render(a.opts.Out, a.outputFor("table"), contextEnvelope(args[0], f.Contexts[args[0]], true))
	}}
}

func (a *App) contextRemoveCommand() *cobra.Command {
	return &cobra.Command{Use: "remove <name>", Short: "Remove a context", Args: cobra.ExactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		path, _ := a.configPath()
		f, err := config.Load(path)
		if err != nil {
			return cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
		}
		if err := f.RemoveContext(args[0]); err != nil {
			return cliError(ExitNotFound, "CONTEXT_NOT_FOUND", err.Error())
		}
		if err := config.Save(path, f); err != nil {
			return cliError(ExitUnexpected, "CONFIG_ERROR", err.Error())
		}
		return output.Render(a.opts.Out, a.outputFor("table"), map[string]any{"apiVersion": "v1", "kind": "ContextRemoved", "data": map[string]any{"name": args[0]}})
	}}
}

func contextEnvelope(name string, value config.Context, current bool) map[string]any {
	return map[string]any{"apiVersion": "v1", "kind": "Context", "data": map[string]any{"name": name, "server": value.Server, "output": value.Output, "timeout": durationString(value.Timeout), "current": current}}
}

func durationString(value time.Duration) string {
	if value == 0 {
		return ""
	}
	return value.String()
}

func (a *App) doctorCommand() *cobra.Command {
	return &cobra.Command{Use: "doctor", Short: "Diagnose local and service health", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		checks := []any{}
		add := func(name, status, message string) {
			checks = append(checks, map[string]any{"name": name, "status": status, "message": message})
		}
		path, pathErr := a.configPath()
		if pathErr != nil {
			add("config", "failed", pathErr.Error())
		} else if _, err := config.Load(path); err != nil {
			add("config", "failed", err.Error())
		} else {
			add("config", "ok", path)
		}
		r, err := a.resolve()
		if err != nil {
			add("context", "failed", err.Error())
		} else if r.Server == "" {
			add("server", "failed", "service URL is not configured")
		} else {
			add("server", "ok", r.Server)
			var version map[string]any
			if _, requestErr := a.newClient(r, "").DoJSON(cmd.Context(), api.Request{Method: http.MethodGet, Path: "/api/v1/version"}, &version); requestErr != nil {
				add("api", "failed", requestErr.Error())
			} else {
				add("api", "ok", "v1 reachable")
			}
			if credential, credentialErr := a.resolveCredential(r); credentialErr != nil {
				add("authentication", "failed", "credential unavailable")
			} else {
				var me map[string]any
				if requestErr := a.newClient(r, credential.Token).Get(cmd.Context(), "/api/v1/me", &me); requestErr != nil {
					add("authentication", "failed", requestErr.Error())
				} else {
					add("authentication", "ok", string(credential.Source))
				}
			}
		}
		return output.Render(a.opts.Out, a.outputFor("table"), map[string]any{"apiVersion": "v1", "kind": "Doctor", "data": checks})
	}}
}

type appTransport struct{ app *App }

func (t appTransport) Do(ctx context.Context, method, path string, body any, headers http.Header, out any) (http.Header, error) {
	r, err := t.app.resolve()
	if err != nil {
		return nil, cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
	}
	if path == "/api/v1/version" && r.Server == "" {
		if out != nil {
			_ = json.Unmarshal([]byte(`{"apiVersion":"v1","kind":"Version","data":{},"meta":{}}`), out)
		}
		return http.Header{}, nil
	}
	if r.Server == "" {
		return nil, cliError(ExitInvalidInput, "SERVER_REQUIRED", "service URL required. Set PULSECTL_URL or --server")
	}
	token := ""
	if path != "/api/v1/version" && path != "/api/v1/cli-auth/device" && path != "/api/v1/cli-auth/token" {
		credential, credentialErr := t.app.resolveCredential(r)
		if credentialErr != nil {
			return nil, cliError(ExitAuthentication, "AUTHENTICATION_REQUIRED", authRequired)
		}
		token = credential.Token
	}
	requestPath := path
	var query url.Values
	if parsed, parseErr := url.Parse(path); parseErr == nil {
		requestPath, query = parsed.Path, parsed.Query()
	}
	req := api.Request{Method: method, Path: requestPath, Query: query, Body: body}
	if headers != nil {
		req.IfMatch = headers.Get("If-Match")
		req.IdempotencyKey = headers.Get("Idempotency-Key")
	}
	response, requestErr := t.app.newClient(r, token).DoJSON(ctx, req, out)
	if requestErr != nil {
		return nil, mapAPIError(requestErr)
	}
	return response.Header, nil
}

type monitorAdapter struct{ app *App }

func (t monitorAdapter) Do(ctx context.Context, request monitorops.Request) error {
	r, client, err := t.app.authenticatedClient()
	_ = r
	if err != nil {
		return err
	}
	_, requestErr := client.DoJSON(ctx, api.Request{Method: request.Method, Path: request.Path, Query: request.Query, Body: request.Body, IdempotencyKey: request.IdempotencyKey}, request.Result)
	return requestErr
}

type groupAdapter struct{ app *App }

func (t groupAdapter) Do(ctx context.Context, request groupops.Request) error {
	_, client, err := t.app.authenticatedClient()
	if err != nil {
		return err
	}
	_, requestErr := client.DoJSON(ctx, api.Request{Method: request.Method, Path: request.Path, Query: request.Query, Body: request.Body, IdempotencyKey: request.IdempotencyKey}, request.Result)
	return requestErr
}

type readAdapter struct{ app *App }

func (t readAdapter) Do(ctx context.Context, request readops.Request) error {
	_, client, err := t.app.authenticatedClient()
	if err != nil {
		return err
	}
	_, requestErr := client.DoJSON(ctx, api.Request{Method: request.Method, Path: request.Path, Query: request.Query}, request.Result)
	return requestErr
}

func (a *App) authenticatedClient() (config.Resolved, *api.Client, error) {
	r, err := a.resolve()
	if err != nil {
		return r, nil, cliError(ExitInvalidInput, "INVALID_CONFIG", err.Error())
	}
	if r.Server == "" {
		return r, nil, cliError(ExitInvalidInput, "SERVER_REQUIRED", "service URL required. Set PULSECTL_URL or --server")
	}
	credential, err := a.resolveCredential(r)
	if err != nil {
		return r, nil, cliError(ExitAuthentication, "AUTHENTICATION_REQUIRED", authRequired)
	}
	return r, a.newClient(r, credential.Token), nil
}

func (a *App) resolveCredential(r config.Resolved) (auth.ResolvedCredential, error) {
	if r.Token != "" {
		return auth.ResolvedCredential{Token: r.Token, Source: auth.CredentialSourceEnvironment}, nil
	}
	if a.tokenStdin {
		if !a.stdinRead {
			line, err := bufio.NewReader(a.opts.In).ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return auth.ResolvedCredential{}, err
			}
			a.stdinToken, a.stdinRead = strings.TrimSpace(line), true
		}
		if a.stdinToken == "" {
			return auth.ResolvedCredential{}, auth.ErrCredentialNotFound
		}
		return auth.ResolvedCredential{Token: a.stdinToken, Source: auth.CredentialSourceStdin}, nil
	}
	path, err := a.configPath()
	if err != nil {
		return auth.ResolvedCredential{}, err
	}
	f, err := config.Load(path)
	if err != nil || f.Installation.ID == "" {
		return auth.ResolvedCredential{}, auth.ErrCredentialNotFound
	}
	return auth.ResolveCredential(r.Server, f.Installation.ID, "", a.credentials)
}

func (a *App) newClient(r config.Resolved, token string) *api.Client {
	client := api.NewClient(r.Server, token, buildinfo.UserAgent(), r.Timeout, a.opts.HTTPClient)
	if a.debug {
		client.SetDebugHook(func(event api.DebugEvent) {
			fmt.Fprintf(a.opts.Err, "%s %s status=%d attempt=%d request_id=%s elapsed=%s\n", event.Method, event.URL, event.Status, event.Attempt, event.RequestID, event.Elapsed.Round(time.Millisecond))
		})
	}
	return client
}

func (a *App) outputFor(fallback string) string {
	if a.format != "" {
		return a.format
	}
	if value := os.Getenv("PULSECTL_OUTPUT"); value != "" {
		return value
	}
	path, _ := a.configPath()
	if f, err := config.Load(path); err == nil {
		name := a.contextName
		if name == "" {
			name = os.Getenv("PULSECTL_CONTEXT")
		}
		if name == "" {
			name = f.CurrentContext
		}
		if value := f.Contexts[name].Output; value != "" {
			return value
		}
	}
	if fallback == "table" && !a.opts.StdoutTTY {
		return "json"
	}
	return fallback
}

func (a *App) outputExplicit() bool {
	if a.format != "" || os.Getenv("PULSECTL_OUTPUT") != "" {
		return true
	}
	path, _ := a.configPath()
	f, err := config.Load(path)
	if err != nil {
		return false
	}
	name := a.contextName
	if name == "" {
		name = os.Getenv("PULSECTL_CONTEXT")
	}
	if name == "" {
		name = f.CurrentContext
	}
	return f.Contexts[name].Output != ""
}

func (a *App) monitorDependencies() monitorops.Dependencies {
	return monitorops.Dependencies{Client: monitorAdapter{a}, In: a.opts.In, Out: a.opts.Out, Err: a.opts.Err, Format: func() string { return a.outputFor(defaultOutput(a.opts.StdoutTTY, "table", "json")) }, WatchFormat: func() string {
		if !a.opts.StdoutTTY && !a.outputExplicit() {
			return "jsonl"
		}
		return a.outputFor(defaultOutput(a.opts.StdoutTTY, "table", "jsonl"))
	}, StdinTTY: a.opts.StdinTTY, StdoutTTY: a.opts.StdoutTTY, NewID: randomUUID, MapError: mapAPIOrCLIError}
}

func (a *App) groupDependencies() groupops.Dependencies {
	return groupops.Dependencies{Client: groupAdapter{a}, In: a.opts.In, Out: a.opts.Out, Err: a.opts.Err, Format: func() string { return a.outputFor(defaultOutput(a.opts.StdoutTTY, "table", "json")) }, StdinTTY: a.opts.StdinTTY, NewID: randomUUID, MapError: mapAPIOrCLIError}
}

func (a *App) readDependencies() readops.Dependencies {
	return readops.Dependencies{Client: readAdapter{a}, Out: a.opts.Out, Err: a.opts.Err, Format: func() string { return a.outputFor(defaultOutput(a.opts.StdoutTTY, "table", "json")) }, MapError: mapAPIOrCLIError}
}

func (a *App) configDependencies() configops.Dependencies {
	return configops.Dependencies{Client: appTransport{a}, In: a.opts.In, Out: a.opts.Out, Err: a.opts.Err, StdinTTY: a.opts.StdinTTY, Output: a.outputFor}
}

func (a *App) adminDependencies() adminops.Dependencies {
	return adminops.Dependencies{Client: appTransport{a}, Sessions: appSessions{a}, In: a.opts.In, Out: a.opts.Out, Err: a.opts.Err, StdinTTY: a.opts.StdinTTY, Output: a.outputFor, LocalVersion: buildinfo.Version}
}

type appSessions struct{ app *App }

func (s appSessions) Current(ctx context.Context) (adminops.Session, error) {
	r, err := s.app.resolve()
	if err != nil {
		return adminops.Session{}, err
	}
	credential, err := s.app.resolveCredential(r)
	if err != nil {
		return adminops.Session{Server: r.Server}, nil
	}
	var me meEnvelope
	if err := s.app.newClient(r, credential.Token).Get(ctx, "/api/v1/me", &me); err != nil {
		return adminops.Session{}, mapAPIError(err)
	}
	identity := me.Data.PrincipalType
	if me.Data.Email != nil {
		identity = *me.Data.Email
	} else if me.Data.TokenName != nil {
		identity = *me.Data.TokenName
	}
	return adminops.Session{Authenticated: true, Source: string(credential.Source), Server: r.Server, Identity: identity, Scopes: me.Data.Scopes}, nil
}
func (s appSessions) Clear(_ context.Context) error {
	r, err := s.app.resolve()
	if err != nil {
		return err
	}
	path, err := s.app.configPath()
	if err != nil {
		return err
	}
	f, err := config.Load(path)
	if err != nil {
		return err
	}
	if f.Installation.ID == "" {
		return nil
	}
	return s.app.credentials.Delete(r.Server, f.Installation.ID)
}

func defaultOutput(tty bool, terminal, redirected string) string {
	if tty {
		return terminal
	}
	return redirected
}
func cliError(exit int, code, message string) *commandError {
	return &commandError{Exit: exit, Code: code, Message: message}
}
func isAuthenticationError(err error) bool {
	var ce *commandError
	return errors.As(err, &ce) && ce.Exit == ExitAuthentication
}
func mapAPIOrCLIError(err error) error {
	var ce *commandError
	if errors.As(err, &ce) {
		return ce
	}
	return mapAPIError(err)
}

func randomUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(b[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}
