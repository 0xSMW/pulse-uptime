package interactive

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"testing"

	"github.com/0xSMW/pulse-uptime/cli/internal/command"
	"github.com/spf13/cobra"
)

type execCall struct {
	args []string
	tty  bool
}

type fakeExec struct {
	calls    []execCall
	listJSON string
}

func (f *fakeExec) fn() Executor {
	return func(_ context.Context, args []string, out, _ io.Writer, tty bool) int {
		f.calls = append(f.calls, execCall{args: append([]string{}, args...), tty: tty})
		if !tty {
			_, _ = io.WriteString(out, f.listJSON)
		}
		return 0
	}
}

func (f *fakeExec) ttyCalls() []execCall {
	var result []execCall
	for _, call := range f.calls {
		if call.tty {
			result = append(result, call)
		}
	}
	return result
}

const sampleListJSON = `{"apiVersion":"v1","kind":"List","data":[` +
	`{"id":"itm_1","name":"First","title":"First","monitorName":"First","url":"https://one.example.com"},` +
	`{"id":"itm_2","name":"Second","title":"Second","monitorName":"Second","url":"https://two.example.com"}]}`

func newFakeExec() *fakeExec { return &fakeExec{listJSON: sampleListJSON} }

// autoUI answers every prompt mechanically so whole-tree sweeps need no per
// action scripting. Selects take the last option with a nonempty value,
// inputs take the first canned candidate the validator accepts, multi
// selects take everything. fillOptional controls whether prompts without a
// validator get text or stay empty, the empty mode mirrors a user skipping
// every optional field.
type autoUI struct {
	confirmDefault bool
	fillOptional   bool
	confirmTitles  []string
}

func (u *autoUI) Select(_, _ string, options []Option) (string, error) {
	for i := len(options) - 1; i >= 0; i-- {
		if options[i].Value != "" {
			return options[i].Value, nil
		}
	}
	return "", fmt.Errorf("no options offered")
}

func (u *autoUI) MultiSelect(_, _ string, options []Option) ([]string, error) {
	values := make([]string, 0, len(options))
	for _, option := range options {
		values = append(values, option.Value)
	}
	return values, nil
}

func (u *autoUI) Input(title, _, initial string, validate func(string) error) (string, error) {
	if validate == nil {
		if u.fillOptional {
			return "sample text", nil
		}
		return "", nil
	}
	if validate("") == nil {
		return "", nil
	}
	candidates := []string{"https://example.com", "2026-01-02T15:04:05Z", "90d", "30s", "200-399", "2", "name-1", "oncall@example.com", "monitors.yaml"}
	for _, candidate := range candidates {
		if validate(candidate) == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no candidate satisfies validator for %q", title)
}

func (u *autoUI) Confirm(title, _ string) (bool, error) {
	u.confirmTitles = append(u.confirmTitles, title)
	return u.confirmDefault, nil
}

// scriptedUI replays queued answers and fails the test on exhaustion. Input
// answers must satisfy the prompt's validator, mirroring what huh enforces.
type scriptedUI struct {
	t        *testing.T
	selects  []string
	inputs   []string
	confirms []bool
}

func (u *scriptedUI) Select(title, _ string, _ []Option) (string, error) {
	if len(u.selects) == 0 {
		u.t.Fatalf("unexpected select %q", title)
	}
	value := u.selects[0]
	u.selects = u.selects[1:]
	return value, nil
}

func (u *scriptedUI) MultiSelect(title, _ string, _ []Option) ([]string, error) {
	u.t.Fatalf("unexpected multiselect %q", title)
	return nil, nil
}

func (u *scriptedUI) Input(title, _, _ string, validate func(string) error) (string, error) {
	if len(u.inputs) == 0 {
		u.t.Fatalf("unexpected input %q", title)
	}
	value := u.inputs[0]
	u.inputs = u.inputs[1:]
	if validate != nil && value != "" {
		if err := validate(value); err != nil {
			u.t.Fatalf("scripted input %q rejected by validator for %q: %v", value, title, err)
		}
	}
	return value, nil
}

func (u *scriptedUI) Confirm(title, _ string) (bool, error) {
	if len(u.confirms) == 0 {
		u.t.Fatalf("unexpected confirm %q", title)
	}
	value := u.confirms[0]
	u.confirms = u.confirms[1:]
	return value, nil
}

func statAnyFile(t *testing.T) {
	t.Helper()
	restore := statFile
	statFile = func(string) (fs.FileInfo, error) { return fakeFileInfo{}, nil }
	t.Cleanup(func() { statFile = restore })
}

func findAction(t *testing.T, sectionTitle, actionTitle string) Action {
	t.Helper()
	for _, section := range Tree() {
		if section.Title != sectionTitle {
			continue
		}
		for _, action := range section.Actions {
			if action.Title == actionTitle {
				return action
			}
		}
	}
	t.Fatalf("action %s / %s not found", sectionTitle, actionTitle)
	return Action{}
}

// TestEveryActionBuildsRunnableArgv proves every menu entry is wired to a
// real command in two sweeps, one with every optional input filled and one
// with every optional input left empty: the built argv resolves to a leaf,
// all flags parse, and the positional arity is valid. Destructive entries
// must carry confirm text and skip the server side prompt.
func TestEveryActionBuildsRunnableArgv(t *testing.T) {
	statAnyFile(t)
	root := command.New(command.Options{}).Root()
	for _, fillOptional := range []bool{true, false} {
		covered := map[string]bool{}
		sectionTitles := map[string]bool{}
		for _, section := range Tree() {
			if sectionTitles[section.Title] {
				t.Fatalf("duplicate section title %q", section.Title)
			}
			sectionTitles[section.Title] = true
			actionTitles := map[string]bool{}
			for _, action := range section.Actions {
				name := fmt.Sprintf("%s / %s fillOptional=%t", section.Title, action.Title, fillOptional)
				if actionTitles[action.Title] {
					t.Fatalf("duplicate action title %q", name)
				}
				actionTitles[action.Title] = true
				if action.Build == nil {
					t.Fatalf("%s has no builder", name)
				}
				if len(action.Command) == 0 {
					t.Fatalf("%s has no command path", name)
				}
				ui := &autoUI{confirmDefault: true, fillOptional: fillOptional}
				exec := newFakeExec()
				env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: io.Discard}
				invocation, err := action.Build(context.Background(), env)
				if !fillOptional && errors.Is(err, errNoChanges) {
					continue
				}
				if err != nil {
					t.Fatalf("%s build failed: %v", name, err)
				}
				if invocation == nil {
					t.Fatalf("%s built nothing", name)
				}
				if len(invocation.Args) < len(action.Command) || !equalPrefix(invocation.Args, action.Command) {
					t.Fatalf("%s argv %v does not extend command path %v", name, invocation.Args, action.Command)
				}
				target, remaining, findErr := root.Find(invocation.Args)
				if findErr != nil {
					t.Fatalf("%s argv %v does not resolve: %v", name, invocation.Args, findErr)
				}
				if target.HasAvailableSubCommands() {
					t.Fatalf("%s argv %v resolves to a command group, not a runnable leaf", name, invocation.Args)
				}
				if parseErr := target.ParseFlags(remaining); parseErr != nil {
					t.Fatalf("%s argv %v has invalid flags: %v", name, invocation.Args, parseErr)
				}
				if argsErr := target.ValidateArgs(target.Flags().Args()); argsErr != nil {
					t.Fatalf("%s argv %v has invalid arity: %v", name, invocation.Args, argsErr)
				}
				if action.Destructive {
					if invocation.Confirm == "" {
						t.Fatalf("%s is destructive without confirm text", name)
					}
					if target.Flags().Lookup("yes") != nil && !contains(invocation.Args, "--yes") {
						t.Fatalf("%s argv %v would trigger a nested prompt, missing --yes", name, invocation.Args)
					}
				}
				covered[target.CommandPath()] = true
			}
		}
		if fillOptional {
			assertLeafCoverage(t, root, covered)
		}
	}
}

// TestReportMessagesRequired pins the message prompts on report create and
// post to a required validator because both commands reject an empty
// message, while report resolve keeps its message genuinely optional.
func TestReportMessagesRequired(t *testing.T) {
	for _, title := range []string{"Create a report", "Post a status update"} {
		action := findAction(t, "Reports", title)
		ui := &autoUI{confirmDefault: true, fillOptional: false}
		exec := newFakeExec()
		env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: io.Discard}
		invocation, err := action.Build(context.Background(), env)
		if err != nil {
			t.Fatalf("%s build failed: %v", title, err)
		}
		if !contains(invocation.Args, "--message") {
			t.Fatalf("%s argv %v is missing the required --message", title, invocation.Args)
		}
	}
	resolve := findAction(t, "Reports", "Resolve a report")
	ui := &scriptedUI{t: t, selects: []string{"itm_1"}, inputs: []string{""}}
	exec := newFakeExec()
	env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: io.Discard}
	invocation, err := resolve.Build(context.Background(), env)
	if err != nil {
		t.Fatalf("resolve build failed: %v", err)
	}
	if contains(invocation.Args, "--message") {
		t.Fatalf("resolve argv %v added --message for an empty input", invocation.Args)
	}
}

// TestConfirmDetailSanitizesHostileNames proves a hostile entity name cannot
// smuggle control bytes into destructive confirm text.
func TestConfirmDetailSanitizesHostileNames(t *testing.T) {
	action := findAction(t, "Monitors", "Archive a monitor")
	hostile := &fakeExec{listJSON: `{"data":[{"id":"mon_1","name":"Evil\u001b[2J\r\nname"}]}`}
	ui := &scriptedUI{t: t, selects: []string{"mon_1"}}
	env := &Env{UI: ui, Exec: hostile.fn(), Out: io.Discard, Err: io.Discard}
	invocation, err := action.Build(context.Background(), env)
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	for _, forbidden := range []string{"\x1b", "\r", "\n"} {
		if strings.Contains(invocation.ConfirmDetail, forbidden) {
			t.Fatalf("confirm detail %q contains raw control byte %q", invocation.ConfirmDetail, forbidden)
		}
	}
	if !strings.Contains(invocation.ConfirmDetail, `\x1b`) {
		t.Fatalf("confirm detail %q lost the escaped marker", invocation.ConfirmDetail)
	}
}

// assertLeafCoverage fails when a runnable leaf command has no menu entry.
// Completion and help are scripting concerns, watch is a full screen loop.
func assertLeafCoverage(t *testing.T, root *cobra.Command, covered map[string]bool) {
	t.Helper()
	excluded := map[string]bool{
		"pulsectl completion":    true,
		"pulsectl help":          true,
		"pulsectl monitor watch": true,
	}
	var visit func(cmd *cobra.Command)
	visit = func(cmd *cobra.Command) {
		for _, child := range cmd.Commands() {
			if !child.IsAvailableCommand() || child.Name() == "help" {
				continue
			}
			if child.HasAvailableSubCommands() {
				visit(child)
				continue
			}
			path := child.CommandPath()
			if excluded[path] {
				continue
			}
			if !covered[path] {
				t.Errorf("leaf command %q has no interactive menu entry", path)
			}
		}
	}
	visit(root)
}

func equalPrefix(args, prefix []string) bool {
	for i, token := range prefix {
		if args[i] != token {
			return false
		}
	}
	return true
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// TestDestructiveDeclineRunsNothing sweeps every destructive action with the
// confirm answered no and asserts nothing executes against the terminal.
func TestDestructiveDeclineRunsNothing(t *testing.T) {
	statAnyFile(t)
	for _, section := range Tree() {
		for _, action := range section.Actions {
			if !action.Destructive {
				continue
			}
			name := section.Title + " / " + action.Title
			ui := &autoUI{confirmDefault: false}
			exec := newFakeExec()
			var errBuf bytes.Buffer
			env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: &errBuf}
			if quit := runAction(context.Background(), env, action); quit {
				t.Fatalf("%s ended the session", name)
			}
			if len(ui.confirmTitles) == 0 {
				t.Fatalf("%s never asked for confirmation", name)
			}
			if calls := exec.ttyCalls(); len(calls) != 0 {
				t.Fatalf("%s executed %v despite declined confirm", name, calls[0].args)
			}
		}
	}
}

func TestArchiveMonitorFlow(t *testing.T) {
	action := findAction(t, "Monitors", "Archive a monitor")
	ui := &scriptedUI{t: t, selects: []string{"itm_2"}, confirms: []bool{true}}
	exec := newFakeExec()
	env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: io.Discard}
	if quit := runAction(context.Background(), env, action); quit {
		t.Fatal("session ended unexpectedly")
	}
	if len(exec.calls) != 2 {
		t.Fatalf("got %d exec calls, want fetch plus archive", len(exec.calls))
	}
	fetch := exec.calls[0]
	if fetch.tty || strings.Join(fetch.args, " ") != "monitor list --all --output json" {
		t.Fatalf("unexpected fetch call %+v", fetch)
	}
	archive := exec.calls[1]
	if !archive.tty || strings.Join(archive.args, " ") != "monitor archive itm_2 --yes" {
		t.Fatalf("unexpected archive call %+v", archive)
	}
}

func TestMonitorUpdateWithoutChangesDoesNotRun(t *testing.T) {
	action := findAction(t, "Monitors", "Update a monitor")
	ui := &scriptedUI{t: t, selects: []string{"itm_1", ""}, inputs: []string{"", ""}}
	exec := newFakeExec()
	var errBuf bytes.Buffer
	env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: &errBuf}
	if quit := runAction(context.Background(), env, action); quit {
		t.Fatal("session ended unexpectedly")
	}
	if calls := exec.ttyCalls(); len(calls) != 0 {
		t.Fatalf("update ran %v with no changes", calls[0].args)
	}
	if !strings.Contains(errBuf.String(), "no changes") {
		t.Fatalf("missing no-changes notice, got %q", errBuf.String())
	}
}

func TestRunSessionTraversal(t *testing.T) {
	ui := &scriptedUI{t: t, selects: []string{"Monitors", "List monitors", backValue, quitValue}}
	exec := newFakeExec()
	env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: io.Discard}
	code := runSession(context.Background(), env, Tree())
	if code != 0 {
		t.Fatalf("exit code %d, want 0", code)
	}
	calls := exec.ttyCalls()
	if len(calls) != 1 || strings.Join(calls[0].args, " ") != "monitor list --all" {
		t.Fatalf("unexpected executed calls %+v", calls)
	}
}

// quitUI reports ctrl+c on the first prompt.
type quitUI struct{}

func (quitUI) Select(string, string, []Option) (string, error)                  { return "", ErrQuit }
func (quitUI) MultiSelect(string, string, []Option) ([]string, error)           { return nil, ErrQuit }
func (quitUI) Input(string, string, string, func(string) error) (string, error) { return "", ErrQuit }
func (quitUI) Confirm(string, string) (bool, error)                             { return false, ErrQuit }

func TestRunSessionCtrlCExitsInterrupted(t *testing.T) {
	exec := newFakeExec()
	env := &Env{UI: quitUI{}, Exec: exec.fn(), Out: io.Discard, Err: io.Discard}
	if code := runSession(context.Background(), env, Tree()); code != 130 {
		t.Fatalf("exit code %d, want 130", code)
	}
	if len(exec.calls) != 0 {
		t.Fatalf("unexpected exec calls %+v", exec.calls)
	}
}

func TestRunSessionEscAtTopLevelQuitsCleanly(t *testing.T) {
	ui := &backUI{}
	exec := newFakeExec()
	env := &Env{UI: ui, Exec: exec.fn(), Out: io.Discard, Err: io.Discard}
	if code := runSession(context.Background(), env, Tree()); code != 0 {
		t.Fatalf("exit code %d, want 0", code)
	}
}

// backUI reports esc on the first prompt.
type backUI struct{}

func (*backUI) Select(string, string, []Option) (string, error)                  { return "", ErrBack }
func (*backUI) MultiSelect(string, string, []Option) ([]string, error)           { return nil, ErrBack }
func (*backUI) Input(string, string, string, func(string) error) (string, error) { return "", ErrBack }
func (*backUI) Confirm(string, string) (bool, error)                             { return false, ErrBack }
