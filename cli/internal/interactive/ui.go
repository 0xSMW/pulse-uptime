// Package interactive drives the menu session that runs when pulsectl is
// invoked with no arguments on a terminal. The menu tree and action dispatch
// are pure data so they stay testable without a terminal, and every action
// executes through the same argv path as a scripted invocation.
package interactive

import (
	"context"
	"errors"
	"io"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// ErrBack reports that the user backed out of the current prompt with esc.
var ErrBack = errors.New("back")

// ErrQuit reports that the user ended the whole session with ctrl+c.
var ErrQuit = errors.New("quit")

// Option is one selectable row in a menu or picker.
type Option struct {
	Label string
	Value string
}

// UI is the prompt surface an action gathers its inputs through. The huh
// implementation renders to the terminal, tests substitute a scripted fake.
type UI interface {
	Select(title, description string, options []Option) (string, error)
	MultiSelect(title, description string, options []Option) ([]string, error)
	Input(title, placeholder, initial string, validate func(string) error) (string, error)
	Confirm(title, description string) (bool, error)
}

type huhUI struct {
	ctx context.Context
	in  io.Reader
	out io.Writer
	th  *huh.Theme
}

// NewHuhUI returns a UI rendering huh forms on out, which must be the
// interactive terminal. Prompts render on stderr so command output written to
// stdout between prompts stays clean.
func NewHuhUI(ctx context.Context, in io.Reader, out io.Writer, color bool) UI {
	th := huh.ThemeCharm()
	if !color {
		th = huh.ThemeBase()
	}
	return &huhUI{ctx: ctx, in: in, out: out, th: th}
}

// keyMap binds esc alongside ctrl+c to the form-level quit binding and
// disables select filtering so esc always means back, never clear-filter.
// The filter slot stays enabled purely as the footer hint for esc, the form
// level quit binding intercepts esc before any field can see it.
func (u *huhUI) keyMap() *huh.KeyMap {
	km := huh.NewDefaultKeyMap()
	km.Quit = key.NewBinding(key.WithKeys("ctrl+c", "esc"), key.WithHelp("esc", "back"))
	escHint := key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "back"))
	disabled := key.NewBinding(key.WithDisabled())
	km.Select.Filter = escHint
	km.Select.SetFilter = disabled
	km.Select.ClearFilter = disabled
	km.MultiSelect.Filter = escHint
	km.MultiSelect.SetFilter = disabled
	km.MultiSelect.ClearFilter = disabled
	return km
}

// run executes a single-field form and translates huh aborts. Esc maps to
// ErrBack, ctrl+c maps to ErrQuit, distinguished by a program-level filter
// because huh reports both as ErrUserAborted.
func (u *huhUI) run(field huh.Field) error {
	interrupt := false
	form := huh.NewForm(huh.NewGroup(field)).
		WithTheme(u.th).
		WithKeyMap(u.keyMap()).
		WithProgramOptions(
			tea.WithInput(u.in),
			tea.WithOutput(u.out),
			tea.WithFilter(func(_ tea.Model, msg tea.Msg) tea.Msg {
				if k, ok := msg.(tea.KeyMsg); ok && k.String() == "ctrl+c" {
					interrupt = true
				}
				return msg
			}),
		)
	err := form.RunWithContext(u.ctx)
	if errors.Is(err, huh.ErrUserAborted) {
		if interrupt {
			return ErrQuit
		}
		return ErrBack
	}
	if err != nil && u.ctx.Err() != nil {
		return ErrQuit
	}
	return err
}

func (u *huhUI) Select(title, description string, options []Option) (string, error) {
	opts := make([]huh.Option[string], 0, len(options))
	for _, o := range options {
		opts = append(opts, huh.NewOption(o.Label, o.Value))
	}
	var value string
	field := huh.NewSelect[string]().Title(title).Description(description).Options(opts...).Value(&value)
	if err := u.run(field); err != nil {
		return "", err
	}
	return value, nil
}

func (u *huhUI) MultiSelect(title, description string, options []Option) ([]string, error) {
	opts := make([]huh.Option[string], 0, len(options))
	for _, o := range options {
		opts = append(opts, huh.NewOption(o.Label, o.Value))
	}
	var values []string
	field := huh.NewMultiSelect[string]().Title(title).Description(description).Options(opts...).Value(&values)
	if err := u.run(field); err != nil {
		return nil, err
	}
	return values, nil
}

func (u *huhUI) Input(title, placeholder, initial string, validate func(string) error) (string, error) {
	value := initial
	field := huh.NewInput().Title(title).Placeholder(placeholder).Value(&value)
	if validate != nil {
		field = field.Validate(validate)
	}
	if err := u.run(field); err != nil {
		return "", err
	}
	return value, nil
}

func (u *huhUI) Confirm(title, description string) (bool, error) {
	var value bool
	field := huh.NewConfirm().Title(title).Description(description).Affirmative("Yes").Negative("No").Value(&value)
	if err := u.run(field); err != nil {
		return false, err
	}
	return value, nil
}
