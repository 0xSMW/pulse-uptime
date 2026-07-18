package auth

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"

	"github.com/productos-ai/pulse-uptime/cli/internal/config"
)

const (
	ScopeProfileAdministrator = "administrator"
	DeviceClientName          = "pulsectl"
	SlowDownIncrement         = 5 * time.Second
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
	expiresAt := now().Add(time.Duration(authorization.ExpiresIn) * time.Second)
	interval := time.Duration(authorization.Interval) * time.Second
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
