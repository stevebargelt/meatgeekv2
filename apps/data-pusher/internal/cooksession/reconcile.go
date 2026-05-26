package cooksession

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

// ErrAPIUnreachable is returned by Reconcile when the API call itself
// fails (network error, non-2xx/404 response, malformed body). It is a
// non-fatal signal: the caller is expected to log and continue with the
// in-memory state. The error wraps the underlying cause for logging.
var ErrAPIUnreachable = errors.New("cooksession: API unreachable")

// reconcileTimeout caps the API call. Short by design: the pusher's main
// loop should not block on a slow API during boot.
const reconcileTimeout = 5 * time.Second

// activeCookEndpoint is the URL path appended to the API base for the
// per-device active-cook lookup. The shape is:
//
//	GET {apiBaseURL}/cooks?deviceId={deviceId}&status=active
//
// Returns a CookListResponse (libs/api-specs/spec/components/schemas/cook.yaml).
// We take the first cook's id as authoritative; an empty cooks array or a
// 404 means "no active cook" and clears the local state. This endpoint
// shape is NOT YET IMPLEMENTED on the API side (see ticket #5 follow-ups);
// the contract is recorded here so a future implementation can match it
// without churning the pusher.
const activeCookPath = "/cooks"

// apiCook is a minimal projection of the spec's Cook schema -- only the
// fields the pusher actually consumes for reconciliation. Other fields
// are ignored. Keeping this local avoids a cross-package dependency on
// the wire types, which are independent per the build-step plan.
type apiCook struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type apiCookListResponse struct {
	Cooks []apiCook `json:"cooks"`
}

// Reconcile asks the API for the currently-active cook for deviceId and
// updates the persisted state to match. When the API and the persisted
// file disagree, the API wins and an "override" log line is emitted.
//
// Error semantics:
//   - nil               : reconcile succeeded; in-memory + on-disk state now reflect the API
//   - ErrAPIUnreachable : the API call failed; persisted state is UNCHANGED, caller should log+continue
//
// The HTTP client uses an internal short timeout independent of ctx, so a
// caller-supplied long-lived ctx will still cap this call to ~5s.
func (s *Store) Reconcile(ctx context.Context, apiBaseURL, deviceID string) error {
	if apiBaseURL == "" {
		return fmt.Errorf("cooksession: Reconcile requires apiBaseURL")
	}
	if deviceID == "" {
		return fmt.Errorf("cooksession: Reconcile requires deviceID")
	}

	reqURL, err := buildActiveCookURL(apiBaseURL, deviceID)
	if err != nil {
		return fmt.Errorf("cooksession: build reconcile URL: %w", err)
	}

	callCtx, cancel := context.WithTimeout(ctx, reconcileTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, reqURL, nil)
	if err != nil {
		return fmt.Errorf("cooksession: new request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: reconcileTimeout}
	resp, err := client.Do(req)
	if err != nil {
		logrus.WithError(err).WithField("url", reqURL).
			Warn("cooksession: reconcile API call failed, keeping persisted state")
		return fmt.Errorf("%w: %v", ErrAPIUnreachable, err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		// No active cook: clear local state if anything was set.
		if _, err := s.setFromReconcile(nil, "api-404"); err != nil {
			return err
		}
		logrus.WithField("deviceId", deviceID).
			Debug("cooksession: API returned 404, no active cook")
		return nil

	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		var body apiCookListResponse
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			logrus.WithError(err).WithField("url", reqURL).
				Warn("cooksession: reconcile response unparseable, keeping persisted state")
			return fmt.Errorf("%w: decode body: %v", ErrAPIUnreachable, err)
		}

		next := pickActiveCookID(body.Cooks)
		if _, err := s.setFromReconcile(next, "api-list"); err != nil {
			return err
		}
		return nil

	default:
		// 5xx and other unexpected codes: treat as unreachable, keep
		// persisted state. Returning a non-fatal error lets the caller
		// log the specific status without crashing.
		logrus.WithFields(logrus.Fields{
			"url":    reqURL,
			"status": resp.StatusCode,
		}).Warn("cooksession: reconcile got unexpected status, keeping persisted state")
		return fmt.Errorf("%w: status %d", ErrAPIUnreachable, resp.StatusCode)
	}
}

// pickActiveCookID returns the first cook whose status is "active" (the
// canonical CookStatus enum value from cook.yaml). Anything else --
// completed, cancelled, paused, planning -- means "no active cook" from
// the pusher's perspective. Returns nil if none match.
func pickActiveCookID(cooks []apiCook) *string {
	for i := range cooks {
		if cooks[i].Status == "active" && cooks[i].ID != "" {
			id := cooks[i].ID
			return &id
		}
	}
	return nil
}

// buildActiveCookURL composes the active-cook lookup URL safely, tolerating
// an apiBaseURL with or without a trailing slash.
func buildActiveCookURL(apiBaseURL, deviceID string) (string, error) {
	base := strings.TrimRight(apiBaseURL, "/")
	parsed, err := url.Parse(base + activeCookPath)
	if err != nil {
		return "", err
	}
	q := parsed.Query()
	q.Set("deviceId", deviceID)
	q.Set("status", "active")
	parsed.RawQuery = q.Encode()
	return parsed.String(), nil
}
