package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxResponseBytes = 10 << 20
const maxRetryDelay = 30 * time.Second
const maxAttempts = 3

// Envelope is the service's versioned object response.
type Envelope[T any] struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Data       T      `json:"data"`
	Meta       Meta   `json:"meta"`
}

type Meta struct {
	RequestID  string `json:"requestId,omitempty"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// Request describes one logical API request. Body is JSON-encoded once, so
// retries always send identical bytes.
type Request struct {
	Method         string
	Path           string
	Query          url.Values
	Body           any
	IdempotencyKey string
	IfMatch        string
}

// RequestOptions controls request headers and query parameters for the
// convenience methods.
type RequestOptions struct {
	Query          url.Values
	IdempotencyKey string
	IfMatch        string
}

// Response exposes the unmodified successful JSON document and response
// metadata. Header is cloned before it is returned.
type Response struct {
	StatusCode int
	Header     http.Header
	RequestID  string
	Body       json.RawMessage
}

// DebugEvent contains only allow-listed request metadata. URLs never contain
// user info, queries, or fragments, and headers and bodies are never exposed.
type DebugEvent struct {
	RequestID string
	Method    string
	URL       string
	Status    int
	Attempt   int
	Elapsed   time.Duration
	UserAgent string
	Error     bool
}

type DebugHook func(DebugEvent)

type Client struct {
	baseURL string
	token   string
	agent   string
	timeout time.Duration
	http    *http.Client

	debugMu   sync.RWMutex
	debugHook DebugHook
}

type Error struct {
	Status     int
	Code       string
	Message    string
	Details    any
	RequestID  string
	RetryAfter time.Duration
	Cause      error
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
		hc = &http.Client{Transport: &http.Transport{
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
	clientCopy := *hc
	clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	hc = &clientCopy
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), token: token, agent: userAgent, timeout: timeout, http: hc}
}

// SetDebugHook installs an optional secret-safe request observer. Passing nil
// disables observation.
func (c *Client) SetDebugHook(hook DebugHook) {
	c.debugMu.Lock()
	c.debugHook = hook
	c.debugMu.Unlock()
}

func (c *Client) Get(ctx context.Context, path string, out any) error {
	_, err := c.DoJSON(ctx, Request{Method: http.MethodGet, Path: path}, out)
	return err
}

func (c *Client) GetWithOptions(ctx context.Context, path string, out any, opts RequestOptions) error {
	_, err := c.DoJSON(ctx, requestFromOptions(http.MethodGet, path, nil, opts), out)
	return err
}

func (c *Client) Post(ctx context.Context, path string, body, out any) error {
	_, err := c.DoJSON(ctx, Request{Method: http.MethodPost, Path: path, Body: body}, out)
	return err
}

func (c *Client) PostWithOptions(ctx context.Context, path string, body, out any, opts RequestOptions) error {
	_, err := c.DoJSON(ctx, requestFromOptions(http.MethodPost, path, body, opts), out)
	return err
}

func (c *Client) Patch(ctx context.Context, path string, body, out any) error {
	_, err := c.DoJSON(ctx, Request{Method: http.MethodPatch, Path: path, Body: body}, out)
	return err
}

func (c *Client) PatchWithOptions(ctx context.Context, path string, body, out any, opts RequestOptions) error {
	_, err := c.DoJSON(ctx, requestFromOptions(http.MethodPatch, path, body, opts), out)
	return err
}

func (c *Client) Delete(ctx context.Context, path string, out any) error {
	_, err := c.DoJSON(ctx, Request{Method: http.MethodDelete, Path: path}, out)
	return err
}

func (c *Client) DeleteWithOptions(ctx context.Context, path string, out any, opts RequestOptions) error {
	_, err := c.DoJSON(ctx, requestFromOptions(http.MethodDelete, path, nil, opts), out)
	return err
}

func requestFromOptions(method, path string, body any, opts RequestOptions) Request {
	return Request{Method: method, Path: path, Query: opts.Query, Body: body, IdempotencyKey: opts.IdempotencyKey, IfMatch: opts.IfMatch}
}

// DoJSON executes a request and decodes its successful JSON response into out.
// Passing nil for out permits empty or intentionally ignored response bodies.
func (c *Client) DoJSON(ctx context.Context, req Request, out any) (*Response, error) {
	resp, err := c.DoRaw(ctx, req)
	if err != nil {
		return nil, err
	}
	if out == nil || len(resp.Body) == 0 {
		return resp, nil
	}
	if err := json.Unmarshal(resp.Body, out); err != nil {
		return nil, &Error{Status: resp.StatusCode, Code: "INVALID_RESPONSE", Message: "service returned invalid JSON", Cause: err, RequestID: resp.RequestID}
	}
	return resp, nil
}

// DoRaw executes a request and returns the successful response document without
// interpreting its envelope.
func (c *Client) DoRaw(ctx context.Context, request Request) (*Response, error) {
	method := strings.ToUpper(strings.TrimSpace(request.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodPatch && method != http.MethodDelete {
		return nil, &Error{Code: "INVALID_REQUEST", Message: "unsupported request method"}
	}

	requestURL, safeURL, err := c.buildURL(request.Path, request.Query)
	if err != nil {
		return nil, &Error{Code: "INVALID_REQUEST", Message: "could not construct request URL", Cause: err}
	}

	var body []byte
	if request.Body != nil {
		body, err = json.Marshal(request.Body)
		if err != nil {
			return nil, &Error{Code: "INVALID_REQUEST", Message: "could not encode request body", Cause: err}
		}
	}

	idempotencyKey := request.IdempotencyKey
	if isMutation(method) && idempotencyKey == "" {
		idempotencyKey, err = newUUID()
		if err != nil {
			return nil, &Error{Message: "could not generate idempotency key", Cause: err}
		}
	}

	var last error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		requestID, idErr := newUUID()
		if idErr != nil {
			return nil, &Error{Message: "could not generate request ID", Cause: idErr}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, c.timeout)
		httpReq, reqErr := http.NewRequestWithContext(attemptCtx, method, requestURL, bytes.NewReader(body))
		if reqErr != nil {
			cancel()
			return nil, &Error{Message: "could not construct request", Cause: reqErr}
		}
		if c.token != "" {
			httpReq.Header.Set("Authorization", "Bearer "+c.token)
		}
		httpReq.Header.Set("Accept", "application/json")
		httpReq.Header.Set("User-Agent", c.agent)
		httpReq.Header.Set("X-Request-ID", requestID)
		if request.Body != nil {
			httpReq.Header.Set("Content-Type", "application/json")
		}
		if idempotencyKey != "" {
			httpReq.Header.Set("Idempotency-Key", idempotencyKey)
		}
		if request.IfMatch != "" {
			httpReq.Header.Set("If-Match", request.IfMatch)
		}

		started := time.Now()
		httpResp, doErr := c.http.Do(httpReq)
		elapsed := time.Since(started)
		if doErr != nil {
			cancel()
			last = &Error{Status: 0, Code: "NETWORK_ERROR", Message: networkMessage(ctx, doErr), Cause: doErr, RequestID: requestID}
			c.debug(DebugEvent{RequestID: requestID, Method: method, URL: safeURL, Attempt: attempt, Elapsed: elapsed, UserAgent: c.agent, Error: true})
			if attempt < maxAttempts && canRetry(method, idempotencyKey, 0) && ctx.Err() == nil {
				if err := wait(ctx, backoff(attempt-1)); err == nil {
					continue
				}
			}
			return nil, last
		}

		responseBody, readErr := io.ReadAll(io.LimitReader(httpResp.Body, maxResponseBytes+1))
		httpResp.Body.Close()
		cancel()
		responseID := httpResp.Header.Get("X-Request-ID")
		if responseID == "" {
			responseID = requestID
		}
		c.debug(DebugEvent{RequestID: responseID, Method: method, URL: safeURL, Status: httpResp.StatusCode, Attempt: attempt, Elapsed: elapsed, UserAgent: c.agent, Error: readErr != nil || httpResp.StatusCode >= 400})

		if readErr != nil {
			return nil, &Error{Status: httpResp.StatusCode, Code: "RESPONSE_ERROR", Message: "could not read service response", Cause: readErr, RequestID: responseID}
		}
		if len(responseBody) > maxResponseBytes {
			return nil, &Error{Status: httpResp.StatusCode, Code: "RESPONSE_TOO_LARGE", Message: "service response exceeded 10 MiB", RequestID: responseID}
		}
		if httpResp.StatusCode >= 200 && httpResp.StatusCode < 300 {
			return &Response{StatusCode: httpResp.StatusCode, Header: httpResp.Header.Clone(), RequestID: responseID, Body: json.RawMessage(responseBody)}, nil
		}

		retryAfter := parseRetryAfter(httpResp.Header.Get("Retry-After"), time.Now())
		apiErr := decodeError(httpResp.StatusCode, responseBody, responseID)
		apiErr.RetryAfter = retryAfter
		last = apiErr
		if attempt < maxAttempts && canRetry(method, idempotencyKey, httpResp.StatusCode) {
			delay := backoff(attempt - 1)
			if httpResp.Header.Get("Retry-After") != "" {
				delay = retryAfter
			}
			if delay <= maxRetryDelay {
				if err := wait(ctx, delay); err == nil {
					continue
				}
			}
		}
		return nil, apiErr
	}
	return nil, last
}

func (c *Client) buildURL(path string, query url.Values) (string, string, error) {
	base, err := url.Parse(c.baseURL)
	if err != nil {
		return "", "", err
	}
	rel, err := url.Parse(path)
	if err != nil {
		return "", "", err
	}
	if rel.IsAbs() || rel.Host != "" || rel.User != nil {
		return "", "", errors.New("request path must be relative")
	}
	merged := rel.Query()
	for key, values := range query {
		for _, value := range values {
			merged.Add(key, value)
		}
	}
	rel.RawQuery = merged.Encode()
	full := base.ResolveReference(rel)
	if full.Scheme != base.Scheme || full.Host != base.Host {
		return "", "", errors.New("request path changed service origin")
	}
	safe := *full
	safe.User = nil
	safe.RawQuery = ""
	safe.Fragment = ""
	return full.String(), safe.String(), nil
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
	code := envelope.Error.Code
	if code == "" {
		code = "HTTP_ERROR"
	}
	return &Error{Status: status, Code: code, Message: message, Details: envelope.Error.Details, RequestID: id}
}

func canRetry(method, idempotencyKey string, status int) bool {
	if method != http.MethodGet && idempotencyKey == "" {
		return false
	}
	return status == 0 || status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func isMutation(method string) bool {
	return method == http.MethodPost || method == http.MethodPatch || method == http.MethodDelete
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil {
		delay := when.Sub(now)
		if delay > 0 {
			return delay
		}
	}
	return 0
}

func wait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func networkMessage(ctx context.Context, err error) string {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "request canceled"
	}
	return "could not reach the service"
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

func (c *Client) debug(event DebugEvent) {
	c.debugMu.RLock()
	hook := c.debugHook
	c.debugMu.RUnlock()
	if hook != nil {
		hook(event)
	}
}

func AsError(err error) (*Error, bool) {
	var target *Error
	ok := errors.As(err, &target)
	return target, ok
}

func IsCode(err error, code string) bool {
	target, ok := AsError(err)
	return ok && target.Code == code
}
