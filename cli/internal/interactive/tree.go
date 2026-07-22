package interactive

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/0xSMW/pulse-uptime/cli/internal/command/adminops"
)

// Section is one top level menu entry holding related actions. A non nil
// Arrange reorders the actions on every section entry from live state and
// must fall back to the given order on any failure, never an error.
type Section struct {
	Title       string
	Description string
	Actions     []Action
	Arrange     func(ctx context.Context, env *Env, actions []Action) []Action
}

// Action is one runnable menu entry. Command is the cobra command path the
// action is anchored to for wiring checks, Build gathers inputs and returns
// the full argv, which may resolve to a different command for composite
// flows such as browse then install. Destructive actions must return an
// Invocation carrying confirm text, the session loop refuses to run them
// otherwise.
type Action struct {
	Title       string
	Command     []string
	Destructive bool
	Build       func(ctx context.Context, env *Env) (*Invocation, error)
}

// Invocation is a fully resolved command run. A nonempty Confirm prompts
// before execution, declining returns to the menu without running.
type Invocation struct {
	Args          []string
	Confirm       string
	ConfirmDetail string
}

var errNoChanges = errors.New("no changes provided, action cancelled")

func simple(title string, command ...string) Action {
	return Action{Title: title, Command: command, Build: func(context.Context, *Env) (*Invocation, error) {
		return &Invocation{Args: command}, nil
	}}
}

var (
	monitorPicker    = PickerSpec{Title: "Select a monitor", List: []string{"monitor", "list", "--all"}, ID: "id", Labels: []string{"name", "url"}}
	groupPicker      = PickerSpec{Title: "Select a group", List: []string{"group", "list", "--all"}, ID: "id", Labels: []string{"name"}}
	dependencyPicker = PickerSpec{Title: "Select a dependency", List: []string{"dependency", "list", "--all"}, ID: "id", Labels: []string{"name"}}
	incidentPicker   = PickerSpec{Title: "Select an incident", List: []string{"incident", "list", "--all"}, ID: "id", Labels: []string{"monitorName", "name"}}
	reportPicker     = PickerSpec{Title: "Select a report", List: []string{"report", "list", "--all"}, ID: "id", Labels: []string{"title", "name"}}
	tokenPicker      = PickerSpec{Title: "Select a token", List: []string{"token", "list", "--all"}, ID: "id", Labels: []string{"name"}}
	contextPicker    = PickerSpec{Title: "Select a context", List: []string{"context", "list"}, ID: "name", Labels: []string{"name"}}
)

// Tree returns the full menu. Every leaf command a user can run by hand is
// represented except completion, help, and monitor watch.
func Tree() []Section {
	return []Section{
		monitorsSection(),
		groupsSection(),
		dependenciesSection(),
		incidentsSection(),
		reportsSection(),
		statusPageSection(),
		configSection(),
		notificationsSection(),
		tokensSection(),
		usersSection(),
		authSection(),
		contextsSection(),
		diagnosticsSection(),
	}
}

func monitorsSection() Section {
	return Section{
		Title:       "Monitors",
		Description: "Create, inspect, and control endpoint monitors",
		Actions: []Action{
			simple("List monitors", "monitor", "list", "--all"),
			{Title: "Show a monitor", Command: []string{"monitor", "get"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, monitorPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"monitor", "get", id}}, nil
			}},
			{Title: "Create a monitor", Command: []string{"monitor", "create"}, Build: buildMonitorCreate},
			{Title: "Update a monitor", Command: []string{"monitor", "update"}, Build: buildMonitorUpdate},
			{Title: "Pause a monitor", Command: []string{"monitor", "pause"}, Build: monitorAction("pause")},
			{Title: "Resume a monitor", Command: []string{"monitor", "resume"}, Build: monitorAction("resume")},
			{Title: "Test a monitor now", Command: []string{"monitor", "test"}, Build: monitorAction("test")},
			{Title: "Archive a monitor", Command: []string{"monitor", "archive"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, label, err := pickEntity(ctx, env, monitorPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"monitor", "archive", id, "--yes"},
					Confirm:       "Archive this monitor?",
					ConfirmDetail: fmt.Sprintf("%s stops being checked and leaves the status page.", label),
				}, nil
			}},
		},
	}
}

func monitorAction(verb string) func(ctx context.Context, env *Env) (*Invocation, error) {
	return func(ctx context.Context, env *Env) (*Invocation, error) {
		id, _, err := pickEntity(ctx, env, monitorPicker)
		if err != nil {
			return nil, err
		}
		return &Invocation{Args: []string{"monitor", verb, id}}, nil
	}
}

func buildMonitorCreate(ctx context.Context, env *Env) (*Invocation, error) {
	id, err := env.UI.Input("Monitor ID", "checkout-api", "", ValidateRequired("monitor ID"))
	if err != nil {
		return nil, err
	}
	name, err := env.UI.Input("Monitor name", "Checkout API", "", ValidateRequired("monitor name"))
	if err != nil {
		return nil, err
	}
	url, err := env.UI.Input("URL to check", "https://example.com/health", "", ValidateURL)
	if err != nil {
		return nil, err
	}
	method, err := env.UI.Select("HTTP method", "", []Option{{Label: "GET", Value: "GET"}, {Label: "HEAD", Value: "HEAD"}})
	if err != nil {
		return nil, err
	}
	interval, err := env.UI.Select("Check interval", "", []Option{
		{Label: "Every minute", Value: "1m"},
		{Label: "Every 5 minutes", Value: "5m"},
		{Label: "Every 10 minutes", Value: "10m"},
		{Label: "Every 15 minutes", Value: "15m"},
	})
	if err != nil {
		return nil, err
	}
	expect, err := env.UI.Input("Expected status range (empty for default)", "200-399", "", ValidateOptionalStatusRange)
	if err != nil {
		return nil, err
	}
	args := []string{"monitor", "create", "--id", id, "--name", name, "--url", url, "--method", method, "--interval", interval}
	if expect != "" {
		args = append(args, "--expect", expect)
	}
	return &Invocation{Args: args}, nil
}

func buildMonitorUpdate(ctx context.Context, env *Env) (*Invocation, error) {
	id, _, err := pickEntity(ctx, env, monitorPicker)
	if err != nil {
		return nil, err
	}
	name, err := env.UI.Input("New name (empty keeps current)", "", "", nil)
	if err != nil {
		return nil, err
	}
	url, err := env.UI.Input("New URL (empty keeps current)", "", "", ValidateOptionalURL)
	if err != nil {
		return nil, err
	}
	interval, err := env.UI.Select("Check interval", "", []Option{
		{Label: "Keep current", Value: ""},
		{Label: "Every minute", Value: "1m"},
		{Label: "Every 5 minutes", Value: "5m"},
		{Label: "Every 10 minutes", Value: "10m"},
		{Label: "Every 15 minutes", Value: "15m"},
	})
	if err != nil {
		return nil, err
	}
	args := []string{"monitor", "update", id}
	if name != "" {
		args = append(args, "--name", name)
	}
	if url != "" {
		args = append(args, "--url", url)
	}
	if interval != "" {
		args = append(args, "--interval", interval)
	}
	if len(args) == 3 {
		return nil, errNoChanges
	}
	return &Invocation{Args: args}, nil
}

func groupsSection() Section {
	return Section{
		Title:       "Groups",
		Description: "Organize monitors into named groups",
		Actions: []Action{
			simple("List groups", "group", "list", "--all"),
			{Title: "Create a group", Command: []string{"group", "create"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, err := env.UI.Input("Group ID", "core-services", "", ValidateRequired("group ID"))
				if err != nil {
					return nil, err
				}
				name, err := env.UI.Input("Group name", "Core services", "", ValidateRequired("group name"))
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"group", "create", "--id", id, "--name", name}}, nil
			}},
			{Title: "Rename a group", Command: []string{"group", "rename"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, groupPicker)
				if err != nil {
					return nil, err
				}
				name, err := env.UI.Input("New name", "", "", ValidateRequired("group name"))
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"group", "rename", id, "--name", name}}, nil
			}},
			{Title: "Delete a group", Command: []string{"group", "delete"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, label, err := pickEntity(ctx, env, groupPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"group", "delete", id, "--yes"},
					Confirm:       "Delete this group?",
					ConfirmDetail: fmt.Sprintf("%s is removed. Only empty groups can be deleted.", label),
				}, nil
			}},
		},
	}
}

func dependenciesSection() Section {
	return Section{
		Title:       "Dependencies",
		Description: "Track third party services your stack depends on",
		Arrange:     arrangeDependencyActions,
		Actions: []Action{
			{Title: "Browse the catalog", Command: []string{"dependency", "catalog"}, Build: buildCatalogBrowse},
			simple("List dependencies", "dependency", "list", "--all"),
			{Title: "Show a dependency", Command: []string{"dependency", "get"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, dependencyPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"dependency", "get", id}}, nil
			}},
			{Title: "Add a dependency", Command: []string{"dependency", "add"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				preset, err := pickCatalogPreset(ctx, env)
				if err != nil {
					return nil, err
				}
				return buildDependencyInstall(ctx, env, preset)
			}},
			{Title: "Backfill dependency history", Command: []string{"dependency", "backfill"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, dependencyPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"dependency", "backfill", id}}, nil
			}},
			{Title: "Remove a dependency", Command: []string{"dependency", "remove"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, label, err := pickEntity(ctx, env, dependencyPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"dependency", "remove", id, "--yes"},
					Confirm:       "Remove this dependency?",
					ConfirmDetail: fmt.Sprintf("%s and its incident history disappear from the status page.", label),
				}, nil
			}},
		},
	}
}

// arrangeDependencyActions puts List dependencies first when at least one
// dependency is installed and keeps Browse the catalog first otherwise. Any
// fetch or parse failure keeps the static order, the menu never blocks on
// this probe.
func arrangeDependencyActions(ctx context.Context, env *Env, actions []Action) []Action {
	raw, err := fetchJSON(ctx, env, []string{"dependency", "list", "--all"})
	if err != nil {
		return actions
	}
	if len(CollectOptions(raw, "id", []string{"name"})) == 0 {
		return actions
	}
	return moveActionFirst(actions, "List dependencies")
}

// moveActionFirst returns the actions with the named one first and the rest
// in their original order. An unknown title returns the input unchanged.
func moveActionFirst(actions []Action, title string) []Action {
	for i, action := range actions {
		if action.Title != title {
			continue
		}
		result := make([]Action, 0, len(actions))
		result = append(result, actions[i])
		result = append(result, actions[:i]...)
		result = append(result, actions[i+1:]...)
		return result
	}
	return actions
}

// buildCatalogBrowse prints the full catalog table, then offers the
// installable presets and flows into the shared install path. Backing out of
// the picker leaves the printed table behind and returns to the section.
func buildCatalogBrowse(ctx context.Context, env *Env) (*Invocation, error) {
	if code := runCommand(ctx, env, []string{"dependency", "catalog"}); code != 0 {
		return nil, fmt.Errorf("catalog listing exited with status %d", code)
	}
	preset, err := pickCatalogPreset(ctx, env)
	if err != nil {
		return nil, err
	}
	return buildDependencyInstall(ctx, env, preset)
}

func incidentsSection() Section {
	return Section{
		Title:       "Incidents",
		Description: "Inspect detected outages",
		Actions: []Action{
			simple("List incidents", "incident", "list", "--all"),
			{Title: "Show an incident", Command: []string{"incident", "get"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, incidentPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"incident", "get", id}}, nil
			}},
			{Title: "Promote an incident to a report", Command: []string{"incident", "promote"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, incidentPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"incident", "promote", id}}, nil
			}},
		},
	}
}

var incidentStatusOptions = []Option{
	{Label: "Investigating", Value: "investigating"},
	{Label: "Identified", Value: "identified"},
	{Label: "Monitoring", Value: "monitoring"},
	{Label: "Resolved", Value: "resolved"},
}

var maintenanceStatusOptions = []Option{
	{Label: "Scheduled", Value: "scheduled"},
	{Label: "In progress", Value: "in_progress"},
	{Label: "Completed", Value: "completed"},
}

func reportsSection() Section {
	return Section{
		Title:       "Reports",
		Description: "Publish incident and maintenance reports",
		Actions: []Action{
			simple("List reports", "report", "list", "--all"),
			{Title: "Show a report", Command: []string{"report", "get"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, reportPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"report", "get", id}}, nil
			}},
			{Title: "Create a report", Command: []string{"report", "create"}, Build: buildReportCreate},
			{Title: "Edit report details", Command: []string{"report", "update"}, Build: buildReportUpdate},
			{Title: "Post a status update", Command: []string{"report", "post"}, Build: buildReportPost},
			{Title: "Edit a posted update", Command: []string{"report", "edit-update"}, Build: buildReportEditUpdate},
			{Title: "Resolve a report", Command: []string{"report", "resolve"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, _, err := pickEntity(ctx, env, reportPicker)
				if err != nil {
					return nil, err
				}
				message, err := env.UI.Input("Closing message (optional)", "", "", nil)
				if err != nil {
					return nil, err
				}
				args := []string{"report", "resolve", id}
				if message != "" {
					args = append(args, "--message", message)
				}
				return &Invocation{Args: args}, nil
			}},
			{Title: "Publish a draft report", Command: []string{"report", "publish"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, label, err := pickEntity(ctx, env, reportPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"report", "publish", id},
					Confirm:       "Publish this report?",
					ConfirmDetail: fmt.Sprintf("%s becomes publicly visible. Publishing cannot be reverted to draft.", label),
				}, nil
			}},
			{Title: "Delete a report", Command: []string{"report", "delete"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, label, err := pickEntity(ctx, env, reportPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"report", "delete", id, "--yes"},
					Confirm:       "Delete this report?",
					ConfirmDetail: fmt.Sprintf("%s and all of its updates are removed.", label),
				}, nil
			}},
		},
	}
}

func buildReportCreate(ctx context.Context, env *Env) (*Invocation, error) {
	kind, err := env.UI.Select("Report type", "", []Option{
		{Label: "Incident", Value: "incident"},
		{Label: "Maintenance", Value: "maintenance"},
	})
	if err != nil {
		return nil, err
	}
	title, err := env.UI.Input("Title", "Elevated error rates", "", ValidateRequired("title"))
	if err != nil {
		return nil, err
	}
	statuses := incidentStatusOptions
	if kind == "maintenance" {
		statuses = maintenanceStatusOptions
	}
	status, err := env.UI.Select("Initial status", "", statuses)
	if err != nil {
		return nil, err
	}
	// The command rejects a missing message, so the prompt requires one.
	message, err := env.UI.Input("First update message", "We are investigating elevated error rates.", "", ValidateRequired("message"))
	if err != nil {
		return nil, err
	}
	publish, err := env.UI.Confirm("Publish immediately?", "No keeps it as a draft.")
	if err != nil {
		return nil, err
	}
	args := []string{"report", "create", "--type", kind, "--title", title, "--status", status, "--message", message}
	if !publish {
		args = append(args, "--draft")
	}
	return &Invocation{Args: args}, nil
}

func buildReportUpdate(ctx context.Context, env *Env) (*Invocation, error) {
	id, _, err := pickEntity(ctx, env, reportPicker)
	if err != nil {
		return nil, err
	}
	title, err := env.UI.Input("New title (empty keeps current)", "", "", nil)
	if err != nil {
		return nil, err
	}
	startsAt, err := env.UI.Input("Starts at, RFC 3339 (empty keeps current)", "2026-01-02T15:04:05Z", "", ValidateOptionalRFC3339)
	if err != nil {
		return nil, err
	}
	endsAt, err := env.UI.Input("Ends at, RFC 3339 (empty keeps current)", "2026-01-02T16:04:05Z", "", ValidateOptionalRFC3339)
	if err != nil {
		return nil, err
	}
	args := []string{"report", "update", id}
	if title != "" {
		args = append(args, "--title", title)
	}
	if startsAt != "" {
		args = append(args, "--starts-at", startsAt)
	}
	if endsAt != "" {
		args = append(args, "--ends-at", endsAt)
	}
	if len(args) == 3 {
		return nil, errNoChanges
	}
	return &Invocation{Args: args}, nil
}

func buildReportPost(ctx context.Context, env *Env) (*Invocation, error) {
	id, _, err := pickEntity(ctx, env, reportPicker)
	if err != nil {
		return nil, err
	}
	status, err := env.UI.Select("New status", "Incident statuses first, maintenance statuses last.", append(append([]Option{}, incidentStatusOptions...), maintenanceStatusOptions...))
	if err != nil {
		return nil, err
	}
	// The command rejects a missing message, so the prompt requires one.
	message, err := env.UI.Input("Update message", "A fix is rolling out.", "", ValidateRequired("message"))
	if err != nil {
		return nil, err
	}
	return &Invocation{Args: []string{"report", "post", id, "--status", status, "--message", message}}, nil
}

func buildReportEditUpdate(ctx context.Context, env *Env) (*Invocation, error) {
	id, _, err := pickEntity(ctx, env, reportPicker)
	if err != nil {
		return nil, err
	}
	updateID, err := env.UI.Input("Update ID", "", "", ValidateRequired("update ID"))
	if err != nil {
		return nil, err
	}
	status, err := env.UI.Select("New status", "", append(append([]Option{{Label: "Keep current", Value: ""}}, incidentStatusOptions...), maintenanceStatusOptions...))
	if err != nil {
		return nil, err
	}
	message, err := env.UI.Input("New message (empty keeps current)", "", "", nil)
	if err != nil {
		return nil, err
	}
	args := []string{"report", "edit-update", id, updateID}
	if status != "" {
		args = append(args, "--status", status)
	}
	if message != "" {
		args = append(args, "--message", message)
	}
	if len(args) == 4 {
		return nil, errNoChanges
	}
	return &Invocation{Args: args}, nil
}

// statusPageField describes one settable status page configuration field.
type statusPageField struct {
	Name     string
	Title    string
	Kind     string
	Enum     []Option
	Validate func(string) error
}

func statusPageFields() []statusPageField {
	return []statusPageField{
		{Name: "name", Title: "Status page name", Kind: "text", Validate: ValidateRequired("name")},
		{Name: "layout", Title: "Layout", Kind: "enum", Enum: []Option{{Label: "Vertical", Value: "vertical"}, {Label: "Horizontal", Value: "horizontal"}}},
		{Name: "theme", Title: "Theme", Kind: "enum", Enum: []Option{{Label: "System", Value: "system"}, {Label: "Light", Value: "light"}, {Label: "Dark", Value: "dark"}}},
		{Name: "historyDays", Title: "History window", Kind: "enum", Enum: []Option{{Label: "30 days", Value: "30"}, {Label: "60 days", Value: "60"}, {Label: "90 days", Value: "90"}}},
		{Name: "uptimeDecimals", Title: "Uptime decimals", Kind: "text", Validate: ValidateIntRange(0, 3)},
		{Name: "minIncidentSeconds", Title: "Minimum incident seconds", Kind: "text", Validate: ValidateIntRange(0, 604800)},
		{Name: "announcementEnabled", Title: "Show the announcement banner", Kind: "bool"},
		{Name: "announcementMarkdown", Title: "Announcement markdown", Kind: "text"},
		{Name: "unknownAsOperational", Title: "Treat unknown as operational", Kind: "bool"},
		{Name: "homepageUrl", Title: "Homepage URL", Kind: "text", Validate: ValidateOptionalURL},
		{Name: "contactUrl", Title: "Contact URL", Kind: "text", Validate: ValidateOptionalURL},
		{Name: "timezone", Title: "Timezone", Kind: "text"},
	}
}

func statusPageSection() Section {
	return Section{
		Title:       "Status page",
		Description: "Configure the public status page",
		Actions: []Action{
			simple("Show configuration", "status-page", "get"),
			{Title: "Change a setting", Command: []string{"status-page", "set"}, Build: buildStatusPageSet},
			{Title: "Export configuration", Command: []string{"status-page", "export"}, Build: buildOptionalFileExport("status-page", "export")},
			{Title: "Apply configuration from file", Command: []string{"status-page", "apply"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				path, err := env.UI.Input("Configuration file", "status-page.json", "", ValidateExistingFile)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"status-page", "apply", "--file", path},
					Confirm:       "Apply this status page configuration?",
					ConfirmDetail: fmt.Sprintf("The live configuration is replaced with %s.", path),
				}, nil
			}},
		},
	}
}

func buildStatusPageSet(ctx context.Context, env *Env) (*Invocation, error) {
	fields := statusPageFields()
	options := make([]Option, 0, len(fields))
	byName := map[string]statusPageField{}
	for _, field := range fields {
		options = append(options, Option{Label: field.Title, Value: field.Name})
		byName[field.Name] = field
	}
	name, err := env.UI.Select("Which setting?", "", options)
	if err != nil {
		return nil, err
	}
	field := byName[name]
	var value string
	switch field.Kind {
	case "enum":
		value, err = env.UI.Select(field.Title, "", field.Enum)
	case "bool":
		var enabled bool
		enabled, err = env.UI.Confirm(field.Title, "")
		value = fmt.Sprintf("%t", enabled)
	default:
		value, err = env.UI.Input(field.Title, "", "", field.Validate)
	}
	if err != nil {
		return nil, err
	}
	return &Invocation{Args: []string{"status-page", "set", fmt.Sprintf("%s=%s", name, value)}}, nil
}

func buildOptionalFileExport(command ...string) func(ctx context.Context, env *Env) (*Invocation, error) {
	return func(ctx context.Context, env *Env) (*Invocation, error) {
		path, err := env.UI.Input("Write to file (empty prints to the terminal)", "", "", nil)
		if err != nil {
			return nil, err
		}
		args := append([]string{}, command...)
		if path != "" {
			args = append(args, "--file", path)
		}
		return &Invocation{Args: args}, nil
	}
}

func configSection() Section {
	return Section{
		Title:       "Declarative config",
		Description: "Export, validate, plan, and apply monitors as code",
		Actions: []Action{
			simple("Show config schema", "config", "schema"),
			{Title: "Export configuration", Command: []string{"config", "export"}, Build: buildOptionalFileExport("config", "export")},
			{Title: "Validate a config file", Command: []string{"config", "validate"}, Build: configFileAction("validate")},
			{Title: "Plan changes from a file", Command: []string{"config", "plan"}, Build: configFileAction("plan")},
			{Title: "Apply a config file", Command: []string{"config", "apply"}, Build: configFileAction("apply")},
		},
	}
}

// configFileAction leaves --yes off so config apply runs its own interactive
// destructive change review on the terminal.
func configFileAction(verb string) func(ctx context.Context, env *Env) (*Invocation, error) {
	return func(ctx context.Context, env *Env) (*Invocation, error) {
		path, err := env.UI.Input("Configuration file", "monitors.yaml", "", ValidateExistingFile)
		if err != nil {
			return nil, err
		}
		return &Invocation{Args: []string{"config", verb, "--file", path}}, nil
	}
}

func notificationsSection() Section {
	return Section{
		Title:       "Notifications",
		Description: "Verify alert delivery",
		Actions: []Action{
			{Title: "Send a test notification", Command: []string{"notification", "test"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				recipient, err := env.UI.Input("Recipient email (empty uses the default)", "oncall@example.com", "", ValidateOptionalEmail)
				if err != nil {
					return nil, err
				}
				args := []string{"notification", "test"}
				if recipient != "" {
					args = append(args, "--recipient", recipient)
				}
				return &Invocation{Args: args}, nil
			}},
		},
	}
}

func tokensSection() Section {
	return Section{
		Title:       "Tokens",
		Description: "Manage scoped API tokens",
		Actions: []Action{
			simple("List tokens", "token", "list", "--all"),
			{Title: "Create a token", Command: []string{"token", "create"}, Build: buildTokenCreate},
			{Title: "Revoke a token", Command: []string{"token", "revoke"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, label, err := pickEntity(ctx, env, tokenPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"token", "revoke", id, "--yes"},
					Confirm:       "Revoke this token?",
					ConfirmDetail: fmt.Sprintf("%s stops working immediately.", label),
				}, nil
			}},
		},
	}
}

func usersSection() Section {
	roleOptions := []Option{{Label: "Viewer (read only)", Value: "viewer"}, {Label: "Admin", Value: "admin"}}
	return Section{
		Title:       "Users",
		Description: "Invite teammates and manage roles",
		Actions: []Action{
			simple("List users and invites", "users", "list"),
			{Title: "Create an invite link", Command: []string{"users", "invite"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				role, err := env.UI.Select("Role for the invited user", "", roleOptions)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"users", "invite", "--role", role}}, nil
			}},
			{Title: "Revoke a pending invite", Command: []string{"users", "revoke-invite"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, err := env.UI.Input("Invite ID (from users list)", "", "", ValidateRequired("invite ID"))
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"users", "revoke-invite", id}}, nil
			}},
			{Title: "Change a user's role", Command: []string{"users", "role"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, err := env.UI.Input("User ID (from users list)", "", "", ValidateRequired("user ID"))
				if err != nil {
					return nil, err
				}
				role, err := env.UI.Select("New role", "", roleOptions)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"users", "role", id, "--role", role}}, nil
			}},
			{Title: "Remove a user", Command: []string{"users", "remove"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				id, err := env.UI.Input("User ID (from users list)", "", "", ValidateRequired("user ID"))
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"users", "remove", id, "--yes"},
					Confirm:       "Remove this user?",
					ConfirmDetail: "Their sessions, CLI logins, and API tokens are revoked immediately.",
				}, nil
			}},
		},
	}
}

func buildTokenCreate(ctx context.Context, env *Env) (*Invocation, error) {
	name, err := env.UI.Input("Token name", "ci-deploy", "", ValidateRequired("token name"))
	if err != nil {
		return nil, err
	}
	scopeOptions := make([]Option, 0, len(adminops.SupportedScopes))
	for _, scope := range adminops.SupportedScopes {
		scopeOptions = append(scopeOptions, Option{Label: scope, Value: scope})
	}
	scopes, err := env.UI.MultiSelect("Scopes", "Space toggles, enter confirms.", scopeOptions)
	if err != nil {
		return nil, err
	}
	if len(scopes) == 0 {
		return nil, errors.New("select at least one scope")
	}
	expiry, err := env.UI.Input("Expires in (empty uses 90d)", "90d", "", ValidateOptionalExpiry)
	if err != nil {
		return nil, err
	}
	args := []string{"token", "create", "--name", name}
	for _, scope := range scopes {
		args = append(args, "--scope", scope)
	}
	if expiry != "" {
		args = append(args, "--expires-in", expiry)
	}
	return &Invocation{Args: args}, nil
}

// ValidateOptionalExpiry accepts empty input or a token expiry the token
// create command itself would accept.
func ValidateOptionalExpiry(s string) error {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return nil
	}
	if _, err := adminops.ParseExpiry(trimmed); err != nil {
		return fmt.Errorf("use a day count such as 90d, between 1d and 365d")
	}
	return nil
}

func authSection() Section {
	return Section{
		Title:       "Auth",
		Description: "Identity and installation linking",
		Actions: []Action{
			simple("Who am I", "me"),
			simple("Log in", "auth", "login"),
			simple("Show auth status", "auth", "status"),
			{Title: "Unlink this installation", Command: []string{"auth", "unlink"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				return &Invocation{
					Args:          []string{"auth", "unlink", "--yes"},
					Confirm:       "Unlink this installation?",
					ConfirmDetail: "The stored credential is revoked and removed from the keyring.",
				}, nil
			}},
		},
	}
}

func contextsSection() Section {
	return Section{
		Title:       "Contexts",
		Description: "Switch between Pulse servers",
		Actions: []Action{
			simple("List contexts", "context", "list"),
			simple("Show current context", "context", "show"),
			{Title: "Add a context", Command: []string{"context", "add"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				name, err := env.UI.Input("Context name", "production", "", ValidateRequired("context name"))
				if err != nil {
					return nil, err
				}
				server, err := env.UI.Input("Server URL", "https://pulse.example.com", "", ValidateURL)
				if err != nil {
					return nil, err
				}
				use, err := env.UI.Confirm("Switch to it now?", "")
				if err != nil {
					return nil, err
				}
				args := []string{"context", "add", name, "--url", server}
				if use {
					args = append(args, "--use")
				}
				return &Invocation{Args: args}, nil
			}},
			{Title: "Switch context", Command: []string{"context", "use"}, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				name, _, err := pickEntity(ctx, env, contextPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{Args: []string{"context", "use", name}}, nil
			}},
			{Title: "Remove a context", Command: []string{"context", "remove"}, Destructive: true, Build: func(ctx context.Context, env *Env) (*Invocation, error) {
				name, _, err := pickEntity(ctx, env, contextPicker)
				if err != nil {
					return nil, err
				}
				return &Invocation{
					Args:          []string{"context", "remove", name},
					Confirm:       "Remove this context?",
					ConfirmDetail: fmt.Sprintf("%s is deleted from the local configuration.", name),
				}, nil
			}},
		},
	}
}

func diagnosticsSection() Section {
	return Section{
		Title:       "Diagnostics",
		Description: "Service status and environment checks",
		Actions: []Action{
			simple("Show service status", "status"),
			simple("Run doctor checks", "doctor"),
			simple("Show version", "version"),
		},
	}
}
