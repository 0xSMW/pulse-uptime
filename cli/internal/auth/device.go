package auth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"runtime"
	"strings"
	"time"

	"github.com/0xSMW/pulse-uptime/cli/internal/config"
)

const (
	ScopeProfileAdministrator = "administrator"
	DeviceClientName          = "pulsectl"
	SlowDownIncrement         = 5 * time.Second

	// DeviceVerificationPath is the only browser path the CLI will print or open
	// for device authorization. It must live on the configured server's origin.
	DeviceVerificationPath = "/cli/authorize"

	// Polling bounds defend against a hostile server that reports an interval or
	// expiry large enough to overflow time.Duration (going negative and causing a
	// tight poll loop) or small enough to hammer the token endpoint.
	MinPollInterval  = 1 * time.Second
	MaxPollInterval  = 60 * time.Second
	MaxExpiresWindow = 30 * time.Minute
)

type DeviceRequest struct {
	ClientName       string `json:"clientName"`
	InstallationKey  string `json:"installationKey"`
	InstallationName string `json:"installationName"`
	ClientVersion    string `json:"clientVersion"`
	Platform         string `json:"platform"`
	Architecture     string `json:"architecture"`
	ScopeProfile     string `json:"scopeProfile"`
}

func NewDeviceRequest(installation config.Installation, version string) (DeviceRequest, error) {
	if err := ValidateInstallation(installation); err != nil {
		return DeviceRequest{}, err
	}
	if version == "" {
		return DeviceRequest{}, errors.New("client version is required")
	}
	return DeviceRequest{
		ClientName: DeviceClientName, InstallationKey: installation.ID,
		InstallationName: installation.Name, ClientVersion: version,
		Platform: runtime.GOOS, Architecture: runtime.GOARCH,
		ScopeProfile: ScopeProfileAdministrator,
	}, nil
}

type DeviceAuthorization struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	ExpiresIn               int    `json:"expiresIn"`
	Interval                int    `json:"interval"`
}

func (d DeviceAuthorization) Validate() error {
	if d.DeviceCode == "" || d.UserCode == "" {
		return errors.New("device authorization is missing a code")
	}
	if d.ExpiresIn <= 0 || d.Interval <= 0 {
		return errors.New("device authorization has an invalid polling lifetime")
	}
	return nil
}

// ValidateVerificationOrigin rejects a browser verification URL that does not
// share the configured server's origin and expected authorization path, so a
// hostile server cannot redirect the operator to an unrelated site. Both
// verificationUri and verificationUriComplete are checked.
func (d DeviceAuthorization) ValidateVerificationOrigin(server string) error {
	base, err := url.Parse(server)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return errors.New("configured server URL is invalid")
	}
	for _, raw := range []string{d.VerificationURI, d.VerificationURIComplete} {
		if raw == "" {
			return errors.New("device authorization is missing a verification URL")
		}
		u, err := url.Parse(raw)
		if err != nil {
			return fmt.Errorf("device authorization verification URL is invalid")
		}
		if !strings.EqualFold(u.Scheme, base.Scheme) || !strings.EqualFold(u.Host, base.Host) {
			return fmt.Errorf("device authorization verification URL is not on the configured server origin")
		}
		if u.Path != DeviceVerificationPath {
			return fmt.Errorf("device authorization verification URL has an unexpected path")
		}
	}
	return nil
}

// clampInterval bounds the server-provided polling interval to a sane cadence
// and avoids the time.Duration overflow that a huge seconds value would cause.
func clampInterval(seconds int) time.Duration {
	if seconds <= int(MinPollInterval/time.Second) {
		return MinPollInterval
	}
	if seconds >= int(MaxPollInterval/time.Second) {
		return MaxPollInterval
	}
	return time.Duration(seconds) * time.Second
}

// clampExpiry bounds the authorization lifetime, again avoiding time.Duration
// overflow from a hostile expiresIn value.
func clampExpiry(seconds int) time.Duration {
	if seconds <= 0 {
		return 0
	}
	if seconds >= int(MaxExpiresWindow/time.Second) {
		return MaxExpiresWindow
	}
	return time.Duration(seconds) * time.Second
}

type DeviceTokenRequest struct {
	DeviceCode string `json:"deviceCode"`
}

type DeviceSession struct {
	Token     string    `json:"token"`
	TokenType string    `json:"tokenType,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
	Email     string    `json:"email,omitempty"`
	Scopes    []string  `json:"scopes,omitempty"`
}

type DeviceErrorCode string

const (
	AuthorizationPending DeviceErrorCode = "authorization_pending"
	SlowDown             DeviceErrorCode = "slow_down"
	AccessDenied         DeviceErrorCode = "access_denied"
	ExpiredToken         DeviceErrorCode = "expired_token"
)

type DeviceFlowError struct {
	Code        DeviceErrorCode `json:"error"`
	Description string          `json:"errorDescription,omitempty"`
}

func (e *DeviceFlowError) Error() string {
	if e.Description != "" {
		return string(e.Code) + ": " + e.Description
	}
	return string(e.Code)
}

type ExchangeFunc func(context.Context, DeviceTokenRequest) (DeviceSession, error)

type Poller struct {
	Now  func() time.Time
	Wait func(context.Context, time.Duration) error
}

// Poll honors the issued interval, increases it by five seconds on slow_down,
// and stops at the device-code expiration time.
func (p Poller) Poll(ctx context.Context, authorization DeviceAuthorization, exchange ExchangeFunc) (DeviceSession, error) {
	if err := authorization.Validate(); err != nil {
		return DeviceSession{}, err
	}
	if exchange == nil {
		return DeviceSession{}, errors.New("device token exchange is required")
	}
	now := p.Now
	if now == nil {
		now = time.Now
	}
	wait := p.Wait
	if wait == nil {
		wait = waitFor
	}
	expiresAt := now().Add(clampExpiry(authorization.ExpiresIn))
	interval := clampInterval(authorization.Interval)
	for {
		remaining := expiresAt.Sub(now())
		if remaining <= 0 || interval > remaining {
			return DeviceSession{}, &DeviceFlowError{Code: ExpiredToken}
		}
		if err := wait(ctx, interval); err != nil {
			return DeviceSession{}, err
		}
		session, err := exchange(ctx, DeviceTokenRequest{DeviceCode: authorization.DeviceCode})
		if err == nil {
			if session.Token == "" {
				return DeviceSession{}, errors.New("device token response is missing an access token")
			}
			return session, nil
		}
		var flowErr *DeviceFlowError
		if !errors.As(err, &flowErr) {
			return DeviceSession{}, err
		}
		switch flowErr.Code {
		case AuthorizationPending:
			continue
		case SlowDown:
			interval += SlowDownIncrement
			if interval > MaxPollInterval {
				interval = MaxPollInterval
			}
			continue
		case AccessDenied, ExpiredToken:
			return DeviceSession{}, flowErr
		default:
			return DeviceSession{}, fmt.Errorf("unknown device authorization error %q", flowErr.Code)
		}
	}
}

func waitFor(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
