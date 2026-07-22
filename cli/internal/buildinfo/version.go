package buildinfo

import "runtime"

var Version = "0.3.1"

func UserAgent() string {
	return "pulsectl/" + Version + " (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
}
