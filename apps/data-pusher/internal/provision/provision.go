// Package provision registers the device with the Azure IoT Hub Device
// Provisioning Service (DPS) over HTTPS, authenticating with the device's own
// X.509 certificate (mutual TLS), and caches the hub DPS assigns it.
//
// The flow is DPS's REST device API:
//
//	PUT https://<endpoint>/<idScope>/registrations/<id>/register?api-version=2021-06-01
//	GET https://<endpoint>/<idScope>/registrations/<id>/operations/<operationId>?api-version=2021-06-01
//
// polled until the operation's status is assigned, failed or disabled. Every
// wait goes through an injected clock.Clock.
package provision

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/stevebargelt/meatgeekv2/apps/data-pusher/internal/clock"
)

const (
	// APIVersion is the DPS device API version.
	APIVersion = "2021-06-01"
	// DefaultEndpoint is the global DPS device endpoint.
	DefaultEndpoint = "global.azure-devices-provisioning.net"

	defaultRetryAfter     = 2 * time.Second
	defaultMaxAttempts    = 30
	defaultRequestTimeout = 30 * time.Second
	maxBody               = 64 << 10
)

// ErrEnrollmentRefused is returned (wrapped) when DPS will not register the
// device: the enrollment is disabled, or DPS answers 401 or 403 (no
// enrollment for this certificate, or the wrong one). Retrying will not help
// until an operator enrols or re-enables the device. Every other error from
// Register is worth retrying.
var ErrEnrollmentRefused = errors.New("provision: DPS refused the enrollment")

// Assignment is the hub DPS assigned the device to.
type Assignment struct {
	AssignedHub  string    `json:"assignedHub"`
	DeviceID     string    `json:"deviceId"`
	RegisteredAt time.Time `json:"registeredAt"`
}

// Client is a DPS device client.
type Client struct {
	http              *http.Client
	clock             clock.Clock
	maxAttempts       int
	defaultRetryAfter time.Duration
	requestTimeout    time.Duration
	rootCAs           *x509.CertPool
}

// Option configures a Client.
type Option func(*Client)

// WithClock replaces the clock behind every wait (Retry-After and the
// per-request timeout). Tests pass a clocktest.Fake.
func WithClock(clk clock.Clock) Option {
	return func(c *Client) {
		if clk != nil {
			c.clock = clk
		}
	}
}

// WithMaxAttempts bounds how many times Register asks for the operation's
// status (default 30).
func WithMaxAttempts(n int) Option {
	return func(c *Client) {
		if n > 0 {
			c.maxAttempts = n
		}
	}
}

// WithDefaultRetryAfter is the wait between status requests when DPS sends no
// usable Retry-After (default 2s).
func WithDefaultRetryAfter(d time.Duration) Option {
	return func(c *Client) {
		if d > 0 {
			c.defaultRetryAfter = d
		}
	}
}

// WithRootCAs replaces the system roots used to verify DPS's server
// certificate. Tests pass the httptest server's; production never sets it.
func WithRootCAs(pool *x509.CertPool) Option {
	return func(c *Client) { c.rootCAs = pool }
}

// New returns a client that presents cert to DPS.
func New(cert tls.Certificate, opts ...Option) *Client {
	c := &Client{
		clock:             clock.Real(),
		maxAttempts:       defaultMaxAttempts,
		defaultRetryAfter: defaultRetryAfter,
		requestTimeout:    defaultRequestTimeout,
	}
	for _, opt := range opts {
		opt(c)
	}
	c.http = &http.Client{Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			RootCAs:      c.rootCAs,
			MinVersion:   tls.VersionTLS12,
		},
		ForceAttemptHTTP2: true,
	}}
	return c
}

// CloseIdleConnections closes the client's idle connections to DPS.
func (c *Client) CloseIdleConnections() { c.http.CloseIdleConnections() }

// operation is DPS's RegistrationOperationStatus, the fields used here.
type operation struct {
	OperationID       string `json:"operationId"`
	Status            string `json:"status"`
	RegistrationState *struct {
		AssignedHub string `json:"assignedHub"`
		DeviceID    string `json:"deviceId"`
		Status      string `json:"status"`
		ErrorCode   int    `json:"errorCode"`
	} `json:"registrationState"`
}

// Register registers registrationID with DPS and waits for the assignment.
// It returns an error wrapping ErrEnrollmentRefused when DPS refuses, and a
// retryable error otherwise. Error text carries HTTP status codes and DPS
// error codes, never a response body.
func (c *Client) Register(ctx context.Context, endpoint, idScope, registrationID string) (Assignment, error) {
	if endpoint == "" || idScope == "" || registrationID == "" {
		return Assignment{}, errors.New("provision: endpoint, ID scope and registration id are all required")
	}
	base := "https://" + endpoint + "/" + url.PathEscape(idScope) + "/registrations/" + url.PathEscape(registrationID)
	query := "?api-version=" + APIVersion

	body, _ := json.Marshal(map[string]string{"registrationId": registrationID})
	op, retryAfter, err := c.do(ctx, http.MethodPut, base+"/register"+query, body)
	if err != nil {
		return Assignment{}, fmt.Errorf("provision: register %s: %w", registrationID, err)
	}
	for attempt := 0; ; attempt++ {
		switch strings.ToLower(op.Status) {
		case "assigned":
			return c.assignment(op, registrationID)
		case "disabled":
			return Assignment{}, fmt.Errorf("%w: the enrollment for %s is disabled", ErrEnrollmentRefused, registrationID)
		case "failed":
			code := 0
			if op.RegistrationState != nil {
				code = op.RegistrationState.ErrorCode
			}
			return Assignment{}, fmt.Errorf("provision: registration of %s failed (DPS errorCode %d)", registrationID, code)
		case "assigning", "unassigned":
		default:
			return Assignment{}, fmt.Errorf("provision: registration of %s: unexpected status %q", registrationID, op.Status)
		}
		if attempt >= c.maxAttempts {
			return Assignment{}, fmt.Errorf("provision: registration of %s still %q after %d status checks", registrationID, op.Status, c.maxAttempts)
		}
		if op.OperationID == "" {
			return Assignment{}, fmt.Errorf("provision: registration of %s: DPS returned no operationId", registrationID)
		}
		if err := c.wait(ctx, retryAfter); err != nil {
			return Assignment{}, err
		}
		op, retryAfter, err = c.do(ctx, http.MethodGet, base+"/operations/"+url.PathEscape(op.OperationID)+query, nil)
		if err != nil {
			return Assignment{}, fmt.Errorf("provision: registration status of %s: %w", registrationID, err)
		}
	}
}

func (c *Client) assignment(op operation, registrationID string) (Assignment, error) {
	if op.RegistrationState == nil || op.RegistrationState.AssignedHub == "" || op.RegistrationState.DeviceID == "" {
		return Assignment{}, fmt.Errorf("provision: registration of %s is assigned but names no hub or device id", registrationID)
	}
	return Assignment{
		AssignedHub:  op.RegistrationState.AssignedHub,
		DeviceID:     op.RegistrationState.DeviceID,
		RegisteredAt: c.clock.Now().UTC(),
	}, nil
}

func (c *Client) wait(ctx context.Context, d time.Duration) error {
	timer := c.clock.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C():
		return nil
	}
}

// do sends one request and decodes the operation status. It returns the wait
// DPS asks for before the next request.
func (c *Client) do(ctx context.Context, method, u string, body []byte) (operation, time.Duration, error) {
	rctx, cancel := clock.WithTimeout(ctx, c.clock, c.requestTimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(rctx, method, u, rd)
	if err != nil {
		return operation{}, 0, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return operation{}, 0, ctx.Err()
		}
		if rctx.Err() != nil {
			return operation{}, 0, fmt.Errorf("%s %s: no response within %s", method, u, c.requestTimeout)
		}
		return operation{}, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return operation{}, 0, fmt.Errorf("%s %s: read response: %w", method, u, err)
	}
	retryAfter := c.retryAfter(resp.Header.Get("Retry-After"))

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		code := errorCode(raw)
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return operation{}, 0, fmt.Errorf("%w: HTTP %d (DPS errorCode %d)", ErrEnrollmentRefused, resp.StatusCode, code)
		}
		return operation{}, 0, fmt.Errorf("HTTP %d (DPS errorCode %d)", resp.StatusCode, code)
	}
	var op operation
	if err := json.Unmarshal(raw, &op); err != nil {
		return operation{}, 0, fmt.Errorf("HTTP %d: response is not a registration status", resp.StatusCode)
	}
	return op, retryAfter, nil
}

// retryAfter parses a Retry-After header in seconds; anything else is the
// default.
func (c *Client) retryAfter(h string) time.Duration {
	if secs, err := strconv.Atoi(strings.TrimSpace(h)); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return c.defaultRetryAfter
}

// errorCode is DPS's numeric errorCode from an error body, or 0.
func errorCode(raw []byte) int {
	var e struct {
		ErrorCode int `json:"errorCode"`
	}
	_ = json.Unmarshal(raw, &e)
	return e.ErrorCode
}
