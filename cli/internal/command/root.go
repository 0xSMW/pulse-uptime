package command

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/0xSMW/pulse-uptime/cli/internal/api"
	"github.com/0xSMW/pulse-uptime/cli/internal/auth"
	"github.com/0xSMW/pulse-uptime/cli/internal/buildinfo"
	"github.com/0xSMW/pulse-uptime/cli/internal/command/adminops"
	"github.com/0xSMW/pulse-uptime/cli/internal/command/configops"
	"github.com/0xSMW/pulse-uptime/cli/internal/command/groupops"
	"github.com/0xSMW/pulse-uptime/cli/internal/command/monitorops"
	"github.com/0xSMW/pulse-uptime/cli/internal/command/readops"
	"github.com/0xSMW/pulse-uptime/cli/internal/command/reportops"
	"github.com/0xSMW/pulse-uptime/cli/internal/command/statuspageops"
	"github.com/0xSMW/pulse-uptime/cli/internal/config"
	"github.com/0xSMW/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"gopkg.in/yaml.v3"
)

const authRequired = "authentication required. Set PULSECTL_TOKEN to a scoped token"

// stdinPayloadFlags names every flag that reads the shared stdin when set to
// "-". Any command that reads a payload from stdin must carry the
// supportsStdin annotation and take the payload through one of these flags so
// the root --token-stdin conflict guard covers it.
var stdinPayloadFlags = []string{"file", "message-file"}

type Options struct {
	In          io.Reader
	Out         io.Writer
	Err         io.Writer
	StdoutTTY   bool
	StdinTTY    bool
	ConfigPath  string
	HTTPClient  *http.Client
	Credentials auth.CredentialStore
	OpenBrowser func(context.Context, string) error
	PollWait    func(context.Context, time.Duration) error
}

type App struct {
	opts Options
	root *cobra.Command

	contextName string
	server      string
	format      string
	timeout     time.Duration
	timeoutSet  bool
	noColor     bool
	debug       bool
	tokenStdin  bool
	stdinToken  string
	stdinRead   bool
	credentials auth.CredentialStore
	openBrowser func(context.Context, string) error
	pollWait    func(context.Context, time.Duration) error
}

type commandError struct {
	Exit      int
	Code      string
	Message   string
	Details   any
	RequestID string
}

func (e *commandError) Error() string { return e.Message }

func New(opts Options) *App {
	if opts.In == nil {
		opts.In = os.Stdin
	}
	if opts.Out == nil {
		opts.Out = os.Stdout
	}
	if opts.Err == nil {
		opts.Err = os.Stderr
	}
	if opts.Credentials == nil {
		opts.Credentials = auth.KeyringStore{}
	}
	if opts.OpenBrowser == nil {
		opts.OpenBrowser = auth.OpenBrowser
	}
	if opts.HTTPClient == nil {
		// Share one transport across every request (including paginated list
		// loops and device polling) instead of churning a new one per call.
		opts.HTTPClient = api.NewHTTPClient()
	}
	a := &App{opts: opts, credentials: opts.Credentials, openBrowser: opts.OpenBrowser, pollWait: opts.PollWait}
	a.root = a.newRoot()
	return a
}

func (a *App) Root() *cobra.Command { return a.root }

func (a *App) Execute(args []string) int {
	return a.ExecuteContext(context.Background(), args)
}

func (a *App) ExecuteContext(ctx context.Context, args []string) int {
	a.root.SetArgs(args)
	err := a.root.ExecuteContext(ctx)
	if err == nil {
		return ExitSuccess
	}
	var ce *commandError
	if !errors.As(err, &ce) {
		var external interface {
			ExitCode() int
			ErrorCode() string
			ErrorDetails() any
		}
		if errors.As(err, &external) {
			ce = &commandError{Exit: external.ExitCode(), Code: external.ErrorCode(), Message: err.Error(), Details: external.ErrorDetails()}
		} else {
			ce = &commandError{Exit: ExitInvalidInput, Code: "INVALID_ARGUMENT", Message: err.Error()}
		}
	}
	format := a.effectiveFormat()
	if format == "json" || format == "jsonl" || format == "yaml" || format == "tsv" {
		doc := output.ErrorDocument{APIVersion: "v1", Kind: "Error", Error: output.ErrorObject{Code: ce.Code, Message: ce.Message, Details: ce.Details, RequestID: ce.RequestID}}
		if format == "yaml" {
			_ = yaml.NewEncoder(a.opts.Err).Encode(doc)
		} else if format == "jsonl" {
			_ = json.NewEncoder(a.opts.Err).Encode(doc)
		} else {
			_ = output.JSON(a.opts.Err, doc)
		}
	} else {
		output.HumanError(a.opts.Err, ce.Message)
		if ce.RequestID != "" {
			fmt.Fprintf(a.opts.Err, "Request ID: %s\n", ce.RequestID)
		}
	}
	return ce.Exit
}

func (a *App) newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "pulsectl",
		Short:         "Manage Pulse uptime monitoring",
		SilenceErrors: true,
		SilenceUsage:  true,
		Args:          cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.rootHelp(cmd.OutOrStdout())
		},
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			if !a.tokenStdin || cmd.Annotations["supportsStdin"] != "true" {
				return nil
			}
			// The token and the payload share one stdin reader, so a single
			// invocation cannot read both from it.
			for _, name := range stdinPayloadFlags {
				if flag := cmd.Flags().Lookup(name); flag != nil && flag.Value.String() == "-" {
					return cliError(ExitInvalidInput, "STDIN_CONFLICT", fmt.Sprintf("--token-stdin cannot be combined with --%s -", name))
				}
			}
			return nil
		},
	}
	root.SetIn(a.opts.In)
	root.SetOut(a.opts.Out)
	root.SetErr(a.opts.Err)
	root.CompletionOptions.DisableDefaultCmd = true
	root.PersistentFlags().StringVar(&a.contextName, "context", "", "Use a named context")
	root.PersistentFlags().StringVar(&a.server, "server", "", "Use a service URL")
	root.PersistentFlags().StringVarP(&a.format, "output", "o", "", "Output format: table, json, jsonl, yaml, or tsv")
	root.PersistentFlags().DurationVar(&a.timeout, "timeout", config.DefaultTimeout, "Per-request timeout")
	root.PersistentFlags().BoolVar(&a.noColor, "no-color", false, "Disable color output")
	root.PersistentFlags().BoolVar(&a.debug, "debug", false, "Print sanitized request diagnostics")
	root.PersistentFlags().BoolVar(&a.tokenStdin, "token-stdin", false, "Read a bearer token from stdin")

	root.AddCommand(a.meCommand())
	root.AddCommand(a.authGroup())
	root.AddCommand(a.contextGroup())
	root.AddCommand(adminops.NewTokenCommand(a.adminDependencies()))
	root.AddCommand(monitorops.NewGroup(a.monitorDependencies()))
	root.AddCommand(groupops.NewGroup(a.groupDependencies()))
	incidents := readops.NewIncidentGroup(a.readDependencies())
	incidents.AddCommand(reportops.NewPromoteCommand(a.reportDependencies()))
	root.AddCommand(incidents)
	root.AddCommand(reportops.NewGroup(a.reportDependencies()))
	root.AddCommand(statuspageops.NewGroup(a.statusPageDependencies()))
	root.AddCommand(configops.NewCommand(a.configDependencies()))
	root.AddCommand(adminops.NewNotificationCommand(a.adminDependencies()))
	root.AddCommand(readops.NewStatusCommand(a.readDependencies()))
	root.AddCommand(a.doctorCommand())
	root.AddCommand(a.completionCommand())
	root.AddCommand(adminops.NewVersionCommand(a.adminDependencies()))
	root.SetHelpCommand(a.helpCommand())
	root.SetHelpFunc(func(cmd *cobra.Command, _ []string) {
		if cmd == root {
			_ = a.rootHelp(cmd.OutOrStdout())
			return
		}
		_ = a.commandHelp(cmd, cmd.OutOrStdout())
	})
	return root
}

func (a *App) meCommand() *cobra.Command {
	var noBrowser bool
	cmd := &cobra.Command{
		Use:         "me",
		Short:       "Show the current principal",
		Args:        cobra.NoArgs,
		Annotations: map[string]string{"supportsOutput": "table,json,yaml,tsv", "requiredScope": "authenticated"},
		Example:     "pulsectl me --server https://pulse.example.com",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runMe(cmd.Context(), noBrowser)
		},
	}
	cmd.Flags().BoolVar(&noBrowser, "no-browser", false, "Print authorization instructions without opening a browser")
	return cmd
}

type meEnvelope struct {
	APIVersion string `json:"apiVersion" yaml:"apiVersion"`
	Kind       string `json:"kind" yaml:"kind"`
	Data       meData `json:"data" yaml:"data"`
}

type meData struct {
	PrincipalType string        `json:"principalType" yaml:"principalType"`
	Type          string        `json:"type,omitempty" yaml:"-"`
	Email         *string       `json:"email" yaml:"email"`
	TokenID       *string       `json:"tokenId,omitempty" yaml:"tokenId,omitempty"`
	TokenName     *string       `json:"tokenName" yaml:"tokenName"`
	Server        string        `json:"server" yaml:"server"`
	Scopes        []string      `json:"scopes" yaml:"scopes"`
	Installation  *installation `json:"installation" yaml:"installation"`
}

type installation struct {
	ID            string `json:"id" yaml:"id"`
	Name          string `json:"name" yaml:"name"`
	Platform      string `json:"platform" yaml:"platform"`
	Arch          string `json:"arch" yaml:"arch"`
	ClientVersion string `json:"clientVersion,omitempty" yaml:"clientVersion,omitempty"`
	LinkedAt      string `json:"linkedAt" yaml:"linkedAt"`
}

func (a *App) renderMe(format string, envelope meEnvelope) error {
	switch format {
	case "json":
		return output.JSON(a.opts.Out, envelope)
	case "jsonl":
		return json.NewEncoder(a.opts.Out).Encode(envelope)
	case "yaml":
		return yaml.NewEncoder(a.opts.Out).Encode(envelope)
	case "tsv":
		identity := envelope.Data.PrincipalType
		if envelope.Data.Email != nil {
			identity = *envelope.Data.Email
		} else if envelope.Data.TokenName != nil {
			identity = *envelope.Data.TokenName
		}
		_, err := fmt.Fprintf(a.opts.Out, "%s\t%s\t%s\n", output.EscapeTSVField(identity), output.EscapeTSVField(envelope.Data.Server), output.EscapeTSVField(strings.Join(envelope.Data.Scopes, ",")))
		return err
	default:
		if envelope.Data.Email != nil {
			fmt.Fprintln(a.opts.Out, output.SanitizeDisplay(*envelope.Data.Email))
		} else if envelope.Data.TokenName != nil {
			fmt.Fprintf(a.opts.Out, "Token         %s\n", output.SanitizeDisplay(*envelope.Data.TokenName))
		} else {
			fmt.Fprintf(a.opts.Out, "Principal     %s\n", output.SanitizeDisplay(envelope.Data.PrincipalType))
		}
		if envelope.Data.Installation != nil {
			fmt.Fprintf(a.opts.Out, "Installation  %s\n", output.SanitizeDisplay(envelope.Data.Installation.Name))
		}
		fmt.Fprintf(a.opts.Out, "Server        %s\n", envelope.Data.Server)
		access := fmt.Sprintf("%d scopes", len(envelope.Data.Scopes))
		if fullAccess(envelope.Data.Scopes) {
			access = "Full access"
		}
		_, err := fmt.Fprintf(a.opts.Out, "Access        %s\n", access)
		return err
	}
}

func fullAccess(scopes []string) bool {
	want := []string{"config:read", "config:write", "incidents:read", "monitors:read", "monitors:write", "notifications:test", "reports:read", "reports:write", "status:read", "tokens:manage"}
	return len(scopes) == len(want) && strings.Join(scopes, "\x00") == strings.Join(want, "\x00")
}

func mapAPIError(err error) error {
	if errors.Is(err, context.Canceled) {
		return &commandError{Exit: ExitInterrupted, Code: "INTERRUPTED", Message: "interrupted"}
	}
	ae, ok := api.AsError(err)
	if !ok {
		return &commandError{Exit: ExitUnexpected, Code: "CLI_ERROR", Message: err.Error()}
	}
	exit := ExitUnexpected
	switch {
	case ae.Status == 0 || ae.Status >= 500:
		exit = ExitUnavailable
	case ae.Status == 400 || ae.Status == 422:
		exit = ExitInvalidInput
	case ae.Status == 401:
		exit = ExitAuthentication
	case ae.Status == 403:
		exit = ExitPermission
	case ae.Status == 404:
		exit = ExitNotFound
	case ae.Status == 408 || ae.Status == 429:
		exit = ExitRateLimited
	case ae.Status == 409 || ae.Status == 412:
		exit = ExitConflict
	}
	code := ae.Code
	if code == "" {
		code = "HTTP_ERROR"
	}
	details := ae.Details
	if ae.Status == http.StatusTooManyRequests && ae.RetryAfter > 0 {
		values := map[string]any{}
		if existing, ok := ae.Details.(map[string]any); ok {
			for key, value := range existing {
				values[key] = value
			}
		}
		values["retryAfterSeconds"] = int64((ae.RetryAfter + time.Second - 1) / time.Second)
		details = values
	}
	return &commandError{Exit: exit, Code: code, Message: ae.Message, Details: details, RequestID: ae.RequestID}
}

func (a *App) resolve() (config.Resolved, error) {
	timeoutSet := a.root.PersistentFlags().Lookup("timeout").Changed
	return config.Resolve(config.Overrides{ConfigPath: a.opts.ConfigPath, Context: a.contextName, Server: a.server, Output: a.format, Timeout: a.timeout, TimeoutSet: timeoutSet}, a.opts.StdoutTTY)
}

func (a *App) effectiveFormat() string {
	return a.outputFor(defaultOutput(a.opts.StdoutTTY, "table", "json"))
}

func (a *App) completionCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "completion [bash|zsh|fish|powershell]", Short: "Generate shell completion", Args: cobra.ExactArgs(1), ValidArgs: []string{"bash", "zsh", "fish", "powershell"}}
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		switch args[0] {
		case "bash":
			return a.root.GenBashCompletion(a.opts.Out)
		case "zsh":
			return a.root.GenZshCompletion(a.opts.Out)
		case "fish":
			return a.root.GenFishCompletion(a.opts.Out, true)
		case "powershell":
			return a.root.GenPowerShellCompletion(a.opts.Out)
		default:
			return fmt.Errorf("unsupported shell %q", args[0])
		}
	}
	return cmd
}

func (a *App) helpCommand() *cobra.Command {
	return &cobra.Command{Use: "help [command]", Short: "Show command help", Args: cobra.ArbitraryArgs, RunE: func(cmd *cobra.Command, args []string) error {
		target, _, err := a.root.Find(args)
		if err != nil {
			return err
		}
		if a.effectiveFormat() == "json" {
			return output.JSON(cmd.OutOrStdout(), buildManifest(a.root, target))
		}
		if len(args) == 0 {
			return a.rootHelp(cmd.OutOrStdout())
		}
		return a.commandHelp(target, cmd.OutOrStdout())
	}}
}

func (a *App) rootHelp(w io.Writer) error {
	leaves := leafCommands(a.root)
	fmt.Fprintln(w, "Manage Pulse uptime monitoring")
	fmt.Fprintln(w, "\nUsage:\n  pulsectl <command> [flags]")
	fmt.Fprintln(w, "\nCommands:")
	for _, cmd := range leaves {
		fmt.Fprintf(w, "  %-24s %s\n", strings.TrimPrefix(cmd.CommandPath(), "pulsectl "), cmd.Short)
	}
	fmt.Fprintln(w, "  help                     Show command help")
	fmt.Fprintln(w, "\nGlobal flags:")
	a.root.PersistentFlags().VisitAll(func(flag *pflag.Flag) { fmt.Fprintf(w, "  --%-12s %s\n", flag.Name, flag.Usage) })
	fmt.Fprintln(w, "\nEnvironment:")
	fmt.Fprintln(w, "  PULSECTL_CONTEXT  Active context")
	fmt.Fprintln(w, "  PULSECTL_URL      Service URL")
	fmt.Fprintln(w, "  PULSECTL_TOKEN    Scoped bearer token")
	fmt.Fprintln(w, "  PULSECTL_OUTPUT   Output format")
	fmt.Fprintln(w, "  PULSECTL_TIMEOUT  Per-request timeout")
	fmt.Fprintln(w, "  NO_COLOR          Disable color")
	fmt.Fprintln(w, "\nExamples:")
	fmt.Fprintln(w, "  pulsectl me --server https://pulse.example.com")
	fmt.Fprintln(w, "  pulsectl monitor list --output json")
	fmt.Fprintln(w, "  pulsectl monitor create --help")
	fmt.Fprintln(w, "  pulsectl config plan --file monitors.yaml")
	fmt.Fprintln(w, "  pulsectl status --output json")
	return nil
}

func (a *App) commandHelp(cmd *cobra.Command, w io.Writer) error {
	fmt.Fprintf(w, "%s\n\nUsage:\n  %s\n", cmd.Short, cmd.UseLine())
	if cmd.Example != "" {
		fmt.Fprintf(w, "\nExamples:\n%s\n", indent(cmd.Example))
	}
	if cmd.HasAvailableSubCommands() {
		fmt.Fprintln(w, "\nCommands:")
		for _, child := range cmd.Commands() {
			if child.IsAvailableCommand() {
				fmt.Fprintf(w, "  %-14s %s\n", child.Name(), child.Short)
			}
		}
	}
	if cmd.HasAvailableLocalFlags() {
		fmt.Fprintf(w, "\nFlags:\n%s", cmd.LocalFlags().FlagUsages())
	}
	if cmd.HasAvailableInheritedFlags() {
		fmt.Fprintf(w, "\nGlobal flags:\n%s", cmd.InheritedFlags().FlagUsages())
	}
	return nil
}

func indent(s string) string { return "  " + strings.ReplaceAll(s, "\n", "\n  ") }

type manifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	Binary        string            `json:"binary"`
	Version       string            `json:"version"`
	Commands      []manifestCommand `json:"commands"`
}

type manifestCommand struct {
	Path           []string       `json:"path"`
	Summary        string         `json:"summary"`
	Arguments      []string       `json:"arguments"`
	Flags          []manifestFlag `json:"flags"`
	SupportsStdin  bool           `json:"supportsStdin"`
	SupportsOutput []string       `json:"supportsOutput"`
	Examples       []string       `json:"examples"`
	RequiredScope  string         `json:"requiredScope,omitempty"`
	ExitCodes      []int          `json:"exitCodes"`
	Idempotent     bool           `json:"idempotent"`
}

type manifestFlag struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Required    bool   `json:"required"`
	Description string `json:"description"`
	Default     string `json:"default,omitempty"`
}

func buildManifest(root, target *cobra.Command) manifest {
	commands := leafCommands(target)
	if target != root && !target.HasAvailableSubCommands() {
		commands = []*cobra.Command{target}
	}
	result := manifest{SchemaVersion: 1, Binary: "pulsectl", Version: buildinfo.Version, Commands: make([]manifestCommand, 0, len(commands))}
	for _, cmd := range commands {
		path := strings.Fields(strings.TrimPrefix(cmd.CommandPath(), "pulsectl "))
		item := manifestCommand{Path: path, Summary: cmd.Short, Arguments: parseArguments(cmd.Use), SupportsOutput: strings.Split(cmd.Annotations["supportsOutput"], ","), RequiredScope: cmd.Annotations["requiredScope"], ExitCodes: []int{0, 1, 2, 3, 5, 6, 7, 8, 9, 130}, Idempotent: commandIsMutation(path)}
		if strings.Join(path, " ") == "monitor test" {
			item.ExitCodes = append(item.ExitCodes, 4)
			sort.Ints(item.ExitCodes)
		}
		if len(item.SupportsOutput) == 1 && item.SupportsOutput[0] == "" {
			if cmd.Name() == "completion" {
				item.SupportsOutput = []string{}
			} else {
				item.SupportsOutput = []string{"table", "json", "yaml", "tsv"}
			}
		}
		item.SupportsStdin = cmd.Annotations["supportsStdin"] == "true"
		if cmd.Example != "" {
			item.Examples = strings.Split(cmd.Example, "\n")
		} else {
			item.Examples = []string{cmd.CommandPath() + " --help"}
		}
		seen := map[string]bool{}
		addFlags := func(set *pflag.FlagSet) {
			set.VisitAll(func(flag *pflag.Flag) {
				if !seen[flag.Name] {
					item.Flags = append(item.Flags, manifestFlag{Name: flag.Name, Type: flag.Value.Type(), Required: flag.Annotations[cobra.BashCompOneRequiredFlag] != nil, Description: flag.Usage, Default: flag.DefValue})
					seen[flag.Name] = true
				}
			})
		}
		addFlags(cmd.LocalFlags())
		addFlags(cmd.InheritedFlags())
		sort.Slice(item.Flags, func(i, j int) bool { return item.Flags[i].Name < item.Flags[j].Name })
		result.Commands = append(result.Commands, item)
	}
	return result
}

func commandIsMutation(path []string) bool {
	joined := strings.Join(path, " ")
	for _, prefix := range []string{"monitor create", "monitor update", "monitor pause", "monitor resume", "monitor delete", "monitor test", "group create", "group rename", "group delete", "config validate", "config plan", "config apply", "notification test", "token create", "token revoke", "auth logout", "auth login", "report create", "report update", "report post", "report edit-update", "report delete", "report resolve", "report publish", "incident promote", "status-page set", "status-page apply"} {
		if joined == prefix {
			return true
		}
	}
	return false
}

func leafCommands(root *cobra.Command) []*cobra.Command {
	var result []*cobra.Command
	var visit func(*cobra.Command)
	visit = func(cmd *cobra.Command) {
		for _, child := range cmd.Commands() {
			if child.Name() == "help" || !child.IsAvailableCommand() {
				continue
			}
			if child.HasAvailableSubCommands() {
				visit(child)
			} else {
				result = append(result, child)
			}
		}
	}
	visit(root)
	sort.Slice(result, func(i, j int) bool { return result[i].CommandPath() < result[j].CommandPath() })
	return result
}

func parseArguments(use string) []string {
	fields := strings.Fields(use)
	if len(fields) < 2 {
		return []string{}
	}
	return fields[1:]
}
