package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxResponseBytes = 10 << 20
const maxRetryDelay = 30 * time.Second

type Client struct {
	baseURL string
	token   string
	agent   string
	timeout time.Duration
	http    *http.Client
}

type Error struct {
	Status    int
	Code      string
	Message   string
	Details   any
	RequestID string
	Cause     error
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Cause != nil {
		return "request failed: " + e.Cause.Error()
	}
	return fmt.Sprintf("request failed with status %d", e.Status)
}

func (e *Error) Unwrap() error { return e.Cause }

func NewClient(baseURL, token, userAgent string, timeout time.Duration, hc *http.Client) *Client {
	if hc == nil {
		dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
		hc = &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          20,
			MaxIdleConnsPerHost:   10,
			IdleConnTimeout:       60 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
		}}
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), token: token, agent: userAgent, timeout: timeout, http: hc}
}

func (c *Client) Get(ctx context.Context, path string, out any) error {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		requestID, err := newUUID()
		if err != nil {
			return &Error{Message: "could not generate request ID", Cause: err}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, c.timeout)
		req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, c.baseURL+path, nil)
		if err != nil {
			cancel()
			return &Error{Message: "could not construct request", Cause: err}
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.agent)
		req.Header.Set("X-Request-ID", requestID)

		resp, err := c.http.Do(req)
		if err != nil {
			cancel()
			last = &Error{Status: 0, Code: "NETWORK_ERROR", Message: "could not reach the service", Cause: err, RequestID: requestID}
			if attempt < 2 && ctx.Err() == nil {
				time.Sleep(backoff(attempt))
				continue
			}
			return last
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
		resp.Body.Close()
		cancel()
		if readErr != nil {
			return &Error{Status: resp.StatusCode, Code: "RESPONSE_ERROR", Message: "could not read service response", Cause: readErr, RequestID: requestID}
		}
		if len(body) > maxResponseBytes {
			return &Error{Status: resp.StatusCode, Code: "RESPONSE_TOO_LARGE", Message: "service response exceeded 10 MiB", RequestID: requestID}
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if err := json.Unmarshal(body, out); err != nil {
				return &Error{Status: resp.StatusCode, Code: "INVALID_RESPONSE", Message: "service returned invalid JSON", Cause: err, RequestID: requestID}
			}
			return nil
		}

		apiErr := decodeError(resp.StatusCode, body, requestID)
		last = apiErr
		if attempt < 2 && retryable(resp.StatusCode) {
			delay := backoff(attempt)
			if value := resp.Header.Get("Retry-After"); value != "" {
				if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
					delay = time.Duration(seconds) * time.Second
				} else if when, err := http.ParseTime(value); err == nil {
					delay = time.Until(when)
					if delay < 0 {
						delay = 0
					}
				}
			}
			if delay > maxRetryDelay {
				return apiErr
			}
			select {
			case <-ctx.Done():
				return &Error{Status: 0, Code: "NETWORK_ERROR", Message: "request canceled", Cause: ctx.Err(), RequestID: requestID}
			case <-time.After(delay):
			}
			continue
		}
		return apiErr
	}
	return last
}

func decodeError(status int, body []byte, fallbackID string) *Error {
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Details   any    `json:"details"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	message := envelope.Error.Message
	if message == "" {
		message = http.StatusText(status)
	}
	id := envelope.Error.RequestID
	if id == "" {
		id = fallbackID
	}
	return &Error{Status: status, Code: envelope.Error.Code, Message: message, Details: envelope.Error.Details, RequestID: id}
}

func retryable(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func backoff(attempt int) time.Duration {
	base := time.Duration(100*(1<<attempt)) * time.Millisecond
	var value [1]byte
	if _, err := rand.Read(value[:]); err != nil {
		return base
	}
	return base + time.Duration(int64(base)*int64(value[0])/512)
}

func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	buf := make([]byte, 36)
	hex.Encode(buf[0:8], b[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], b[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], b[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], b[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], b[10:16])
	return string(buf), nil
}

func AsError(err error) (*Error, bool) {
	var target *Error
	ok := errors.As(err, &target)
	return target, ok
}
