package interactive

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/0xSMW/pulse-uptime/cli/internal/output"
)

// Exit codes mirror internal/command/exit.go for the states the session can
// end in without duplicating that package as a dependency.
const (
	exitSuccess     = 0
	exitInterrupted = 130
)

// Options wires the interactive session to the process environment.
type Options struct {
	In    io.Reader
	Out   io.Writer
	Err   io.Writer
	Exec  Executor
	Color bool
}

const (
	backValue = "\x00back"
	quitValue = "\x00quit"
)

// Run drives the menu session until the user quits. It returns a process
// exit code, 0 for a deliberate quit and 130 for ctrl+c or a canceled
// context.
func Run(ctx context.Context, opts Options) int {
	ui := NewHuhUI(ctx, opts.In, opts.Err, opts.Color)
	env := &Env{UI: ui, Exec: opts.Exec, Out: opts.Out, Err: opts.Err}
	return runSession(ctx, env, Tree())
}

// runSession is the pure traversal loop, separated from terminal wiring so
// tests can drive it with a scripted UI.
func runSession(ctx context.Context, env *Env, tree []Section) int {
	sections := make([]Option, 0, len(tree)+1)
	byTitle := map[string]Section{}
	for _, section := range tree {
		sections = append(sections, Option{Label: section.Title, Value: section.Title})
		byTitle[section.Title] = section
	}
	sections = append(sections, Option{Label: "Quit", Value: quitValue})
	for {
		if ctx.Err() != nil {
			return exitInterrupted
		}
		choice, err := env.UI.Select("pulsectl", "Manage Pulse uptime monitoring", sections)
		if errors.Is(err, ErrBack) || errors.Is(err, ErrQuit) {
			if errors.Is(err, ErrQuit) {
				return exitInterrupted
			}
			return exitSuccess
		}
		if err != nil {
			showError(env, err)
			return exitInterrupted
		}
		if choice == quitValue {
			return exitSuccess
		}
		if code, done := runSection(ctx, env, byTitle[choice]); done {
			return code
		}
	}
}

// runSection loops inside one section until the user backs out. The second
// return reports that the whole session should end with the given code.
// Arrange runs once per section entry so the order reflects live state
// without a fetch on every loop iteration.
func runSection(ctx context.Context, env *Env, section Section) (int, bool) {
	actions := section.Actions
	if section.Arrange != nil {
		actions = section.Arrange(ctx, env, actions)
	}
	options := make([]Option, 0, len(actions)+1)
	for _, action := range actions {
		options = append(options, Option{Label: action.Title, Value: action.Title})
	}
	options = append(options, Option{Label: "Back", Value: backValue})
	byTitle := map[string]Action{}
	for _, action := range actions {
		byTitle[action.Title] = action
	}
	for {
		if ctx.Err() != nil {
			return exitInterrupted, true
		}
		choice, err := env.UI.Select(section.Title, "pulsectl / "+section.Title+" - "+section.Description, options)
		if errors.Is(err, ErrBack) {
			return 0, false
		}
		if errors.Is(err, ErrQuit) {
			return exitInterrupted, true
		}
		if err != nil {
			showError(env, err)
			return exitInterrupted, true
		}
		if choice == backValue {
			return 0, false
		}
		if quit := runAction(ctx, env, byTitle[choice]); quit {
			return exitInterrupted, true
		}
	}
}

// runAction gathers inputs, confirms when required, and executes. It returns
// true only when the session should end because the user hit ctrl+c.
func runAction(ctx context.Context, env *Env, action Action) bool {
	invocation, err := action.Build(ctx, env)
	if errors.Is(err, ErrQuit) {
		return true
	}
	if errors.Is(err, ErrBack) {
		return false
	}
	if err != nil {
		showError(env, err)
		return false
	}
	if invocation == nil {
		return false
	}
	// Destructive invocations without confirm text are a wiring bug, never
	// run them.
	if action.Destructive && invocation.Confirm == "" {
		showError(env, fmt.Errorf("refusing to run %s without confirmation", strings.Join(invocation.Args, " ")))
		return false
	}
	if invocation.Confirm != "" {
		ok, confirmErr := env.UI.Confirm(invocation.Confirm, invocation.ConfirmDetail)
		if errors.Is(confirmErr, ErrQuit) {
			return true
		}
		if confirmErr != nil || !ok {
			return false
		}
	}
	code := runCommand(ctx, env, invocation.Args)
	if code != 0 {
		fmt.Fprintf(env.Err, "\ncommand exited with status %d\n", code)
	}
	fmt.Fprintln(env.Out)
	return ctx.Err() != nil
}

func showError(env *Env, err error) {
	fmt.Fprintf(env.Err, "\n%s\n\n", output.SanitizeDisplay(err.Error()))
}
