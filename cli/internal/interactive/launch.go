package interactive

// ShouldLaunch reports whether a bare pulsectl invocation gets the menu
// session. Any argument, a missing terminal on stdin, stdout, or stderr,
// PULSECTL_NO_INPUT, or a dumb terminal keeps the scripted help behavior
// byte for byte. Stderr must be a terminal because the menu renders there.
func ShouldLaunch(args []string, stdinTTY, stdoutTTY, stderrTTY bool, getenv func(string) string) bool {
	if len(args) != 0 {
		return false
	}
	if !stdinTTY || !stdoutTTY || !stderrTTY {
		return false
	}
	if getenv("PULSECTL_NO_INPUT") != "" {
		return false
	}
	if getenv("TERM") == "dumb" {
		return false
	}
	return true
}
