package main

import (
	"context"
	"io"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"

	"github.com/0xSMW/pulse-uptime/cli/internal/command"
	"github.com/0xSMW/pulse-uptime/cli/internal/interactive"
	"golang.org/x/term"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	var signalExit atomic.Int32
	go func() {
		sig := <-signals
		if sig == syscall.SIGTERM {
			signalExit.Store(143)
		} else {
			signalExit.Store(130)
		}
		cancel()
	}()
	stdinTTY := isTerminal(os.Stdin)
	stdoutTTY := isTerminal(os.Stdout)
	stderrTTY := isTerminal(os.Stderr)
	var code int
	if interactive.ShouldLaunch(os.Args[1:], stdinTTY, stdoutTTY, stderrTTY, os.Getenv) {
		// Each menu action executes through a fresh App so interactive runs
		// share the exact argv code path with scripted invocations.
		exec := func(ctx context.Context, args []string, out, errOut io.Writer, tty bool) int {
			app := command.New(command.Options{In: os.Stdin, Out: out, Err: errOut, StdinTTY: tty && stdinTTY, StdoutTTY: tty && stdoutTTY, StderrTTY: tty && stderrTTY})
			return app.ExecuteContext(ctx, args)
		}
		code = interactive.Run(ctx, interactive.Options{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, Exec: exec, Color: os.Getenv("NO_COLOR") == ""})
	} else {
		app := command.New(command.Options{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, StdinTTY: stdinTTY, StdoutTTY: stdoutTTY, StderrTTY: stderrTTY})
		code = app.ExecuteContext(ctx, os.Args[1:])
	}
	if interrupted := signalExit.Load(); interrupted != 0 {
		code = int(interrupted)
	}
	os.Exit(code)
}

func isTerminal(file *os.File) bool {
	return file != nil && term.IsTerminal(int(file.Fd()))
}
