package interactive

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
)

// Executor runs one pulsectl invocation exactly as a scripted call would.
// The tty flag controls whether the invocation sees the real terminal so
// captured picker fetches default to machine output with no spinner.
type Executor func(ctx context.Context, args []string, out, errOut io.Writer, tty bool) int

// Env carries the prompt surface and execution seam through the session.
type Env struct {
	UI   UI
	Exec Executor
	Out  io.Writer
	Err  io.Writer
}

// runCommand executes argv against the live terminal streams.
func runCommand(ctx context.Context, env *Env, args []string) int {
	return env.Exec(ctx, args, env.Out, env.Err, true)
}

// fetchJSON executes argv with --output json into capture buffers and returns
// the raw stdout. A nonzero exit surfaces the command's own stderr text so
// menu-level error display matches what a scripted run would have printed.
func fetchJSON(ctx context.Context, env *Env, args []string) ([]byte, error) {
	full := append(append([]string{}, args...), "--output", "json")
	var out, errOut bytes.Buffer
	code := env.Exec(ctx, full, &out, &errOut, false)
	if code != 0 {
		message := strings.TrimSpace(errOut.String())
		if message == "" {
			message = fmt.Sprintf("command exited with status %d", code)
		}
		return nil, fmt.Errorf("%s", message)
	}
	return out.Bytes(), nil
}
