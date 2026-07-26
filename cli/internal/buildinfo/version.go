package buildinfo

import "runtime"

var Version = "0.3.2"

func UserAgent() string {
	return "pulsectl/" + Version + " (" + runtime.GOOS + "; " + runtime.GOARCH + ")"
}
