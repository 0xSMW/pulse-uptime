package auth

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/productos-ai/pulse-uptime/cli/internal/config"
	keyring "github.com/zalando/go-keyring"
)

const KeyringService = "pulsectl"

var ErrCredentialNotFound = errors.New("credential not found")

// CredentialStore isolates secure operating-system credential storage for
// command integration and tests.
type CredentialStore interface {
	Get(server, installationID string) (string, error)
	Set(server, installationID, token string) error
	Delete(server, installationID string) error
}

type KeyringStore struct{}

func (KeyringStore) Get(server, installationID string) (string, error) {
	account, err := CredentialAccount(server, installationID)
	if err != nil {
		return "", err
	}
	token, err := keyring.Get(KeyringService, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrCredentialNotFound
	}
	if err != nil {
		return "", fmt.Errorf("read credential from operating-system keyring: %w", err)
	}
	return token, nil
}

func (KeyringStore) Set(server, installationID, token string) error {
	if strings.TrimSpace(token) == "" {
		return errors.New("credential token is required")
	}
	account, err := CredentialAccount(server, installationID)
	if err != nil {
		return err
	}
	if err := keyring.Set(KeyringService, account, token); err != nil {
		return fmt.Errorf("store credential in operating-system keyring: %w", err)
	}
	return nil
}

func (KeyringStore) Delete(server, installationID string) error {
	account, err := CredentialAccount(server, installationID)
	if err != nil {
		return err
	}
	if err := keyring.Delete(KeyringService, account); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return fmt.Errorf("delete credential from operating-system keyring: %w", err)
	}
	return nil
}

func CredentialAccount(server, installationID string) (string, error) {
	server, err := config.NormalizeServer(server)
	if err != nil {
		return "", err
	}
	installationID = strings.TrimSpace(installationID)
	if installationID == "" {
		return "", errors.New("installation ID is required")
	}
	return server + "|" + installationID, nil
}

type CredentialSource string

const (
	CredentialSourceEnvironment CredentialSource = "environment"
	CredentialSourceStdin       CredentialSource = "stdin"
	CredentialSourceKeyring     CredentialSource = "keyring"
)

type ResolvedCredential struct {
	Token  string
	Source CredentialSource
}

// ResolveCredential applies the authentication precedence defined by the CLI
// contract. The environment token is returned only in memory and is never
// passed to the store.
func ResolveCredential(server, installationID, stdinToken string, store CredentialStore) (ResolvedCredential, error) {
	if token := strings.TrimSpace(os.Getenv("PULSECTL_TOKEN")); token != "" {
		return ResolvedCredential{Token: token, Source: CredentialSourceEnvironment}, nil
	}
	if token := strings.TrimSpace(stdinToken); token != "" {
		return ResolvedCredential{Token: token, Source: CredentialSourceStdin}, nil
	}
	if store == nil {
		return ResolvedCredential{}, ErrCredentialNotFound
	}
	token, err := store.Get(server, installationID)
	if err != nil {
		return ResolvedCredential{}, err
	}
	return ResolvedCredential{Token: token, Source: CredentialSourceKeyring}, nil
}
