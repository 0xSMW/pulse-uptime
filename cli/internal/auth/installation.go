package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"unicode"

	"github.com/productos-ai/pulse-uptime/cli/internal/config"
)

// EnsureInstallation loads or creates the stable, non-secret installation
// identity stored in the local configuration file.
func EnsureInstallation(configPath, requestedName string) (config.Installation, error) {
	f, err := config.Load(configPath)
	if err != nil {
		return config.Installation{}, err
	}
	changed := false
	if f.Installation.ID == "" {
		f.Installation.ID, err = newInstallationID()
		if err != nil {
			return config.Installation{}, err
		}
		changed = true
	}
	if f.Installation.Name == "" {
		f.Installation.Name = strings.TrimSpace(requestedName)
		if f.Installation.Name == "" {
			f.Installation.Name = DefaultInstallationName()
		}
		changed = true
	}
	if changed {
		if err := config.Save(configPath, f); err != nil {
			return config.Installation{}, err
		}
	}
	return f.Installation, nil
}

func newInstallationID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("generate installation ID: %w", err)
	}
	return "ins_local_" + hex.EncodeToString(random[:]), nil
}

func DefaultInstallationName() string {
	hostname, err := os.Hostname()
	if err == nil {
		name := strings.TrimSuffix(strings.TrimSpace(hostname), ".local")
		name = strings.Map(func(r rune) rune {
			if r == '-' || r == '_' {
				return ' '
			}
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, name)
		name = strings.Join(strings.Fields(name), " ")
		if name != "" {
			return name
		}
	}
	return "Pulse CLI on " + runtime.GOOS
}

func ValidateInstallation(installation config.Installation) error {
	if !strings.HasPrefix(installation.ID, "ins_local_") || len(installation.ID) <= len("ins_local_") {
		return errors.New("invalid installation ID")
	}
	if strings.TrimSpace(installation.Name) == "" {
		return errors.New("installation name is required")
	}
	return nil
}
