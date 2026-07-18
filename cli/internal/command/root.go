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

	"github.com/productos-ai/pulse-uptime/cli/internal/api"
	"github.com/productos-ai/pulse-uptime/cli/internal/buildinfo"
	"github.com/productos-ai/pulse-uptime/cli/internal/config"
	"github.com/productos-ai/pulse-uptime/cli/internal/output"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"gopkg.in/yaml.v3"
)

const authRequired = "authentication required. Set PULSECTL_TOKEN to a scoped token"

type Options struct {
	In         io.Reader
	Out        io.Writer
	Err        io.Writer
	StdoutTTY  bool
	StdinTTY   bool
	ConfigPath string
	HTTPClient *http.Client
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
	a := &App{opts: opts}
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
		ce = &commandError{Exit: ExitInvalidInput, Code: "INVALID_ARGUMENT", Message: err.Error()}
	}
	format := a.effectiveFormat()
	if format == "json" || format == "jsonl" || format == "yaml" {
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

	root.AddCommand(a.meCommand())
	root.AddCommand(a.group("auth", "Manage authentication", []leaf{{"login", "Link this installation", nil}, {"logout", "Remove a linked session", nil}, {"status", "Show authentication status", nil}}))
	root.AddCommand(a.group("context", "Manage service contexts", []leaf{{"add", "Add a context", contextAddFlags}, {"list", "List contexts", nil}, {"show", "Show a context", idArg}, {"use", "Select the active context", idArg}, {"remove", "Remove a context", idArg}}))
	root.AddCommand(a.group("token", "Manage scoped API tokens", []leaf{{"create", "Create a scoped token", tokenCreateFlags}, {"list", "List scoped tokens", nil}, {"revoke", "Revoke a scoped token", idArg}}))
	root.AddCommand(a.group("monitor", "Manage endpoint monitors", []leaf{{"list", "List monitors", listFlags}, {"get", "Get a monitor", idArg}, {"create", "Create a monitor", monitorCreateFlags}, {"update", "Update a monitor", monitorUpdateFlags}, {"pause", "Pause a monitor", idArg}, {"resume", "Resume a monitor", idArg}, {"delete", "Delete a monitor", deleteFlags}, {"test", "Test a monitor target", idArg}, {"watch", "Watch monitor state", watchFlags}}))
	root.AddCommand(a.group("incident", "Inspect incidents", []leaf{{"list", "List incidents", listFlags}, {"get", "Get an incident", idArg}}))
	root.AddCommand(a.group("config", "Manage declarative configuration", []leaf{{"export", "Export accepted configuration", fileOutputFlags}, {"validate", "Validate configuration", fileInputFlags}, {"plan", "Plan configuration changes", fileInputFlags}, {"apply", "Apply a configuration plan", applyFlags}, {"schema", "Print the configuration schema", nil}}))
	root.AddCommand(a.group("notification", "Manage notifications", []leaf{{"test", "Send a test notification", recipientFlags}}))
	root.AddCommand(a.unavailableLeaf("status", "Show public service status", nil))
	root.AddCommand(a.unavailableLeaf("doctor", "Diagnose local and service health", nil))
	root.AddCommand(a.completionCommand())
	root.AddCommand(a.versionCommand())
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

type leaf struct {
	name    string
	summary string
	flags   func(*cobra.Command)
}

func (a *App) group(name, summary string, leaves []leaf) *cobra.Command {
	group := &cobra.Command{Use: name, Short: summary, Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error { return cmd.Help() }}
	for _, definition := range leaves {
		cmd := a.unavailableLeaf(definition.name, definition.summary, definition.flags)
		cmd.Example = "pulsectl " + name + " " + definition.name + " --help"
		group.AddCommand(cmd)
	}
	return group
}

func (a *App) unavailableLeaf(name, summary string, flags func(*cobra.Command)) *cobra.Command {
	cmd := &cobra.Command{
		Use:         name,
		Short:       summary,
		Args:        cobra.ArbitraryArgs,
		Annotations: map[string]string{"supportsOutput": "table,json,jsonl,yaml,tsv"},
		Example:     "pulsectl " + name + " --help",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return &commandError{Exit: ExitUnexpected, Code: "DEVELOPMENT_UNAVAILABLE", Message: fmt.Sprintf("%s is unavailable in this development build", cmd.CommandPath())}
		},
	}
	if flags != nil {
		flags(cmd)
	}
	return cmd
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
			return a.runMe(cmd.Context())
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

func (a *App) runMe(ctx context.Context) error {
	r, err := a.resolve()
	if err != nil {
		return &commandError{Exit: ExitInvalidInput, Code: "INVALID_CONFIG", Message: err.Error()}
	}
	if r.Server == "" {
		return &commandError{Exit: ExitInvalidInput, Code: "SERVER_REQUIRED", Message: "service URL required. Set PULSECTL_URL or --server"}
	}
	if r.Token == "" {
		return &commandError{Exit: ExitAuthentication, Code: "AUTHENTICATION_REQUIRED", Message: authRequired}
	}
	c := api.NewClient(r.Server, r.Token, buildinfo.UserAgent(), r.Timeout, a.opts.HTTPClient)
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
		_, err := fmt.Fprintf(a.opts.Out, "%s\t%s\t%s\n", identity, envelope.Data.Server, strings.Join(envelope.Data.Scopes, ","))
		return err
	default:
		if envelope.Data.Email != nil {
			fmt.Fprintln(a.opts.Out, *envelope.Data.Email)
		} else if envelope.Data.TokenName != nil {
			fmt.Fprintf(a.opts.Out, "Token         %s\n", *envelope.Data.TokenName)
		} else {
			fmt.Fprintf(a.opts.Out, "Principal     %s\n", envelope.Data.PrincipalType)
		}
		if envelope.Data.Installation != nil {
			fmt.Fprintf(a.opts.Out, "Installation  %s\n", envelope.Data.Installation.Name)
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
	want := []string{"config:read", "config:write", "incidents:read", "monitors:read", "monitors:write", "notifications:test", "status:read", "tokens:manage"}
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
	return &commandError{Exit: exit, Code: code, Message: ae.Message, Details: ae.Details, RequestID: ae.RequestID}
}

func (a *App) resolve() (config.Resolved, error) {
	timeoutSet := a.root.PersistentFlags().Lookup("timeout").Changed
	return config.Resolve(config.Overrides{ConfigPath: a.opts.ConfigPath, Context: a.contextName, Server: a.server, Output: a.format, Timeout: a.timeout, TimeoutSet: timeoutSet}, a.opts.StdoutTTY)
}

func (a *App) effectiveFormat() string {
	if a.format != "" {
		return a.format
	}
	if env := os.Getenv("PULSECTL_OUTPUT"); env != "" {
		return env
	}
	if a.opts.StdoutTTY {
		return "table"
	}
	return "json"
}

func (a *App) versionCommand() *cobra.Command {
	return &cobra.Command{Use: "version", Short: "Show CLI version", Args: cobra.NoArgs, Annotations: map[string]string{"supportsOutput": "table,json,yaml"}, RunE: func(_ *cobra.Command, _ []string) error {
		value := struct {
			APIVersion string `json:"apiVersion" yaml:"apiVersion"`
			Kind       string `json:"kind" yaml:"kind"`
			Data       struct {
				Version string `json:"version" yaml:"version"`
				Commit  string `json:"commit" yaml:"commit"`
				Date    string `json:"date" yaml:"date"`
			} `json:"data" yaml:"data"`
		}{APIVersion: "v1", Kind: "Version"}
		value.Data.Version, value.Data.Commit, value.Data.Date = buildinfo.Version, buildinfo.Commit, buildinfo.Date
		switch a.effectiveFormat() {
		case "json", "jsonl":
			return output.JSON(a.opts.Out, value)
		case "yaml":
			return yaml.NewEncoder(a.opts.Out).Encode(value)
		default:
			_, err := fmt.Fprintf(a.opts.Out, "pulsectl %s\n", buildinfo.Version)
			return err
		}
	}}
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
}

type manifestFlag struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

func buildManifest(root, target *cobra.Command) manifest {
	commands := leafCommands(target)
	if target != root && !target.HasAvailableSubCommands() {
		commands = []*cobra.Command{target}
	}
	result := manifest{SchemaVersion: 1, Binary: "pulsectl", Version: buildinfo.Version, Commands: make([]manifestCommand, 0, len(commands))}
	for _, cmd := range commands {
		path := strings.Fields(strings.TrimPrefix(cmd.CommandPath(), "pulsectl "))
		item := manifestCommand{Path: path, Summary: cmd.Short, Arguments: parseArguments(cmd.Use), SupportsOutput: strings.Split(cmd.Annotations["supportsOutput"], ",")}
		if len(item.SupportsOutput) == 1 && item.SupportsOutput[0] == "" {
			item.SupportsOutput = []string{}
		}
		item.SupportsStdin = cmd.Annotations["supportsStdin"] == "true"
		if cmd.Example != "" {
			item.Examples = strings.Split(cmd.Example, "\n")
		} else {
			item.Examples = []string{}
		}
		seen := map[string]bool{}
		addFlags := func(set *pflag.FlagSet) {
			set.VisitAll(func(flag *pflag.Flag) {
				if !seen[flag.Name] {
					item.Flags = append(item.Flags, manifestFlag{Name: flag.Name, Type: flag.Value.Type(), Required: flag.Annotations[cobra.BashCompOneRequiredFlag] != nil})
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

func idArg(cmd *cobra.Command) { cmd.Use += " <id>" }
func listFlags(cmd *cobra.Command) {
	cmd.Flags().Int("limit", 0, "Maximum records")
	cmd.Flags().String("cursor", "", "Start cursor")
	cmd.Flags().Bool("all", false, "Retrieve all records")
}
func contextAddFlags(cmd *cobra.Command) {
	cmd.Use += " <name>"
	cmd.Flags().String("url", "", "Service URL")
}
func tokenCreateFlags(cmd *cobra.Command) {
	cmd.Flags().String("name", "", "Token name")
	cmd.Flags().StringSlice("scope", nil, "Granted scope (repeatable)")
	cmd.Flags().Duration("expires-in", 90*24*time.Hour, "Token lifetime")
}
func monitorCreateFlags(cmd *cobra.Command) {
	cmd.Flags().String("id", "", "Stable monitor ID")
	cmd.Flags().String("name", "", "Display name")
	cmd.Flags().String("url", "", "Target URL")
	cmd.Flags().String("method", "GET", "HTTP method")
	cmd.Flags().Duration("check-timeout", 8*time.Second, "Target request timeout")
	cmd.Flags().StringSlice("recipient", nil, "Notification recipient")
}
func monitorUpdateFlags(cmd *cobra.Command) {
	idArg(cmd)
	cmd.Flags().String("name", "", "Display name")
	cmd.Flags().String("url", "", "Target URL")
	cmd.Flags().Duration("check-timeout", 0, "Target request timeout")
}
func deleteFlags(cmd *cobra.Command) { idArg(cmd); cmd.Flags().Bool("yes", false, "Confirm deletion") }
func watchFlags(cmd *cobra.Command) {
	cmd.Flags().Duration("interval", 5*time.Second, "Polling interval")
}
func fileInputFlags(cmd *cobra.Command) {
	cmd.Flags().StringP("file", "f", "-", "Configuration file or - for stdin")
	cmd.Annotations["supportsStdin"] = "true"
}
func fileOutputFlags(cmd *cobra.Command) { cmd.Flags().StringP("file", "f", "", "Write to a file") }
func applyFlags(cmd *cobra.Command) {
	fileInputFlags(cmd)
	cmd.Flags().Bool("yes", false, "Confirm apply")
	cmd.Flags().Bool("allow-destructive", false, "Allow destructive changes")
	cmd.Flags().Bool("wait", false, "Wait for acceptance")
	cmd.Flags().Duration("wait-timeout", 2*time.Minute, "Complete wait deadline")
}
func recipientFlags(cmd *cobra.Command) {
	cmd.Flags().StringSlice("recipient", nil, "Recipient (repeatable)")
}
