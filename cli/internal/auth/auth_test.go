package auth

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type memoryStore struct {
	token string
	gets  int
}

func (s *memoryStore) Get(_, _ string) (string, error) { s.gets++; return s.token, nil }
func (*memoryStore) Set(_, _, _ string) error          { return nil }
func (*memoryStore) Delete(_, _ string) error          { return nil }

func TestResolveCredentialPrecedence(t *testing.T) {
	store := &memoryStore{token: "keyring"}
	t.Setenv("PULSECTL_TOKEN", "environment")
	got, err := ResolveCredential("https://pulse.example.com", "ins_local_x", "stdin", store)
	if err != nil || got.Token != "environment" || got.Source != CredentialSourceEnvironment || store.gets != 0 {
		t.Fatalf("environment precedence: got=%#v gets=%d err=%v", got, store.gets, err)
	}
	t.Setenv("PULSECTL_TOKEN", "")
	got, err = ResolveCredential("https://pulse.example.com", "ins_local_x", "stdin", store)
	if err != nil || got.Token != "stdin" || got.Source != CredentialSourceStdin || store.gets != 0 {
		t.Fatalf("stdin precedence: got=%#v gets=%d err=%v", got, store.gets, err)
	}
	got, err = ResolveCredential("https://pulse.example.com", "ins_local_x", "", store)
	if err != nil || got.Token != "keyring" || got.Source != CredentialSourceKeyring || store.gets != 1 {
		t.Fatalf("keyring fallback: got=%#v gets=%d err=%v", got, store.gets, err)
	}
}

func TestEnsureInstallationIsStable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	first, err := EnsureInstallation(path, "Test Mac")
	if err != nil {
		t.Fatal(err)
	}
	second, err := EnsureInstallation(path, "Different Name")
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.Name != "Test Mac" {
		t.Fatalf("installation changed: first=%#v second=%#v", first, second)
	}
}

func TestPollerHonorsPendingAndSlowDown(t *testing.T) {
	now := time.Unix(0, 0)
	var waits []time.Duration
	poller := Poller{
		Now: func() time.Time { return now },
		Wait: func(_ context.Context, d time.Duration) error {
			waits = append(waits, d)
			now = now.Add(d)
			return nil
		},
	}
	attempt := 0
	session, err := poller.Poll(context.Background(), DeviceAuthorization{DeviceCode: "secret", UserCode: "CODE", ExpiresIn: 60, Interval: 2}, func(context.Context, DeviceTokenRequest) (DeviceSession, error) {
		attempt++
		switch attempt {
		case 1:
			return DeviceSession{}, &DeviceFlowError{Code: AuthorizationPending}
		case 2:
			return DeviceSession{}, &DeviceFlowError{Code: SlowDown}
		default:
			return DeviceSession{Token: "session"}, nil
		}
	})
	if err != nil || session.Token != "session" {
		t.Fatalf("poll result: %#v, %v", session, err)
	}
	if want := []time.Duration{2 * time.Second, 2 * time.Second, 7 * time.Second}; !reflect.DeepEqual(waits, want) {
		t.Fatalf("waits = %v, want %v", waits, want)
	}
}

func TestClampIntervalBoundsHostileValues(t *testing.T) {
	// SEC-08: interval:10000000000 seconds overflows time.Duration to a negative
	// value in the naive form; clamping keeps the cadence bounded.
	cases := []struct {
		in   int
		want time.Duration
	}{
		{10000000000, MaxPollInterval},
		{0, MinPollInterval},
		{-5, MinPollInterval},
		{1, MinPollInterval},
		{5, 5 * time.Second},
		{1000, MaxPollInterval},
	}
	for _, c := range cases {
		if got := clampInterval(c.in); got != c.want {
			t.Fatalf("clampInterval(%d) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestPollBoundsOverflowingInterval(t *testing.T) {
	now := time.Unix(0, 0)
	var waits []time.Duration
	poller := Poller{
		Now: func() time.Time { return now },
		Wait: func(_ context.Context, d time.Duration) error {
			waits = append(waits, d)
			now = now.Add(d)
			if len(waits) >= 3 {
				return context.Canceled
			}
			return nil
		},
	}
	authorization := DeviceAuthorization{DeviceCode: "d", UserCode: "u", ExpiresIn: 600, Interval: 10000000000}
	_, err := poller.Poll(context.Background(), authorization, func(context.Context, DeviceTokenRequest) (DeviceSession, error) {
		return DeviceSession{}, &DeviceFlowError{Code: AuthorizationPending}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("poll error = %v, want context.Canceled", err)
	}
	if len(waits) == 0 {
		t.Fatal("expected at least one bounded poll")
	}
	for _, w := range waits {
		if w < MinPollInterval || w > MaxPollInterval {
			t.Fatalf("poll interval %v is not within [%v, %v]", w, MinPollInterval, MaxPollInterval)
		}
	}
}

func TestValidateVerificationOriginRejectsOffOrigin(t *testing.T) {
	server := "https://pulse.example.com"
	// SEC-08 reproduction: verification URLs on an unrelated origin.
	offOrigin := DeviceAuthorization{
		DeviceCode:              "d",
		UserCode:                "u",
		VerificationURI:         "https://attacker.example/authorize",
		VerificationURIComplete: "https://attacker.example/authorize?user_code=u",
	}
	if err := offOrigin.ValidateVerificationOrigin(server); err == nil {
		t.Fatal("expected off-origin verification URL to be rejected")
	}
	badPath := DeviceAuthorization{
		DeviceCode:              "d",
		UserCode:                "u",
		VerificationURI:         "https://pulse.example.com/evil",
		VerificationURIComplete: "https://pulse.example.com/evil?user_code=u",
	}
	if err := badPath.ValidateVerificationOrigin(server); err == nil {
		t.Fatal("expected an unexpected verification path to be rejected")
	}
	valid := DeviceAuthorization{
		DeviceCode:              "d",
		UserCode:                "u",
		VerificationURI:         "https://pulse.example.com/cli/authorize",
		VerificationURIComplete: "https://pulse.example.com/cli/authorize?user_code=u",
	}
	if err := valid.ValidateVerificationOrigin(server); err != nil {
		t.Fatalf("expected a same-origin verification URL to pass: %v", err)
	}
}

func TestOpenBrowserUsesDirectPlatformCommand(t *testing.T) {
	var name string
	var args []string
	err := openBrowser(context.Background(), "darwin", "https://pulse.example.com/cli/authorize", func(_ context.Context, gotName string, gotArgs ...string) error {
		name, args = gotName, gotArgs
		return nil
	})
	if err != nil || name != "open" || !reflect.DeepEqual(args, []string{"https://pulse.example.com/cli/authorize"}) {
		t.Fatalf("command: %q %v err=%v", name, args, err)
	}
	if err := openBrowser(context.Background(), "darwin", "javascript:alert(1)", func(context.Context, string, ...string) error { return errors.New("must not run") }); err == nil {
		t.Fatal("expected unsafe URL to fail")
	}
}
