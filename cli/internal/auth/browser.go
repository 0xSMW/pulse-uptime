package auth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
)

// OpenBrowser starts the platform URL handler directly, without invoking a
// shell or placing credentials in a command string.
func OpenBrowser(ctx context.Context, rawURL string) error {
	return openBrowser(ctx, runtime.GOOS, rawURL, func(ctx context.Context, name string, args ...string) error {
		return exec.CommandContext(ctx, name, args...).Start()
	})
}

type commandStarter func(context.Context, string, ...string) error

func openBrowser(ctx context.Context, goos, rawURL string, start commandStarter) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return errors.New("browser URL must be an absolute HTTP(S) URL")
	}
	var name string
	var args []string
	switch goos {
	case "darwin":
		name, args = "open", []string{rawURL}
	case "windows":
		name, args = "rundll32", []string{"url.dll,FileProtocolHandler", rawURL}
	case "linux", "freebsd", "openbsd", "netbsd":
		name, args = "xdg-open", []string{rawURL}
	default:
		return fmt.Errorf("opening a browser is unsupported on %s", goos)
	}
	if err := start(ctx, name, args...); err != nil {
		return fmt.Errorf("open browser: %w", err)
	}
	return nil
}
