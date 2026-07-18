package main

import (
	"os"
	"testing"
)

func TestNonTerminalCharacterDeviceIsNotTTY(t *testing.T) {
	if isTerminal(os.Stdin) && os.Getenv("CI") != "" {
		t.Fatal("CI stdin detected as a terminal")
	}

	devNull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()
	if isTerminal(devNull) {
		t.Fatal("noninteractive character device detected as a terminal")
	}
}
