package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/productos-ai/pulse-uptime/cli/internal/command"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	stdinTTY := isTerminal(os.Stdin)
	stdoutTTY := isTerminal(os.Stdout)
	app := command.New(command.Options{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, StdinTTY: stdinTTY, StdoutTTY: stdoutTTY})
	os.Exit(app.ExecuteContext(ctx, os.Args[1:]))
}

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
