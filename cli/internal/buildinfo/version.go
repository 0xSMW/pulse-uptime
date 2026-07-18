package buildinfo

import "runtime"

var (
	Version = "0.1.0-dev"
	Commit  = "unknown"
	Date    = "unknown"
)

func UserAgent() string {
	return "pulsectl/" + Version + " (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
}
