package vectorclient

// This file implements the process-wide vector-service circuit state shared by
// the search client (SearchClient) and the upsert client (Client). It ports
// VectorClientService's process-local "temporarily unavailable" window:
//
//   - consecutiveFailures is capped at 10 and drives the backoff
//     min(60s, 1s*2^(max(0,n-1)));
//   - a VectorUnauthorizedError keeps at least five minutes and a
//     VectorBadResponseError at least one minute, whichever is larger;
//   - lastOperation/lastFailureAt/lastErrorName/lastErrorMessage are recorded
//     on every final failure;
//   - markAvailable clears only the failure streak and the window, never the
//     last-* fields (NestJS markAvailable does the same);
//   - a changed client fingerprint (base URL, timeout, retry count or token)
//     resets the streak and the window, exactly like the client rebuild in
//     VectorClientService.resolveClient, which calls markAvailable.
//
// One Health value must be shared by every vector client of a process. The
// NestJS VectorClientService is a singleton injected into every consumer, so a
// single outage must not be multiplied by the number of Go clients: one failed
// request opens the window for all of them, and the next successful request
// closes it again.
//
// The type is a plain mutex-protected state machine. Time is always passed in
// by the caller (now arguments) so the window can be tested deterministically
// and the clock stays owned by the client that owns the request.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Operation identifies the vector-go call recorded as the last failure. The
// values are the NestJS VectorServiceRuntimeDiagnostics literals ("search" /
// "upsert"); the zero value means "no operation recorded yet" and renders as
// JSON null in the diagnostics response.
type Operation string

const (
	// OperationSearch is VectorClientService.searchBestEffort.
	OperationSearch Operation = "search"
	// OperationUpsert is VectorClientService.upsertBestEffort/upsertOrThrow.
	OperationUpsert Operation = "upsert"
)

// Circuit thresholds mirror VectorClientService.markUnavailable.
const (
	// healthMaxConsecutiveFailures is the cap on the failure streak
	// (Math.min(consecutiveFailures + 1, 10)).
	healthMaxConsecutiveFailures = 10
	// healthBaseBackoff is the first-failure backoff.
	healthBaseBackoff = time.Second
	// healthMaxBackoff caps the exponential backoff.
	healthMaxBackoff = 60 * time.Second
	// healthUnauthorizedBackoff is the minimum window after VectorUnauthorizedError.
	healthUnauthorizedBackoff = 5 * time.Minute
	// healthBadResponseBackoff is the minimum window after VectorBadResponseError.
	healthBadResponseBackoff = 60 * time.Second
)

// Health is the process-wide vector-service circuit state. The zero value is
// ready to use and reports "available"; every method is safe for concurrent
// use and safe on a nil receiver (a nil Health behaves like an always-closed
// circuit and is only possible when a caller forgot the wiring).
type Health struct {
	mu sync.Mutex

	consecutiveFailures int
	unavailableUntil    time.Time
	lastOperation       Operation
	lastFailureAt       time.Time
	lastErrorName       string
	lastErrorMessage    string
	fingerprint         string
	fingerprintSet      bool
}

// HealthSnapshot is one consistent read of Health. Times are zero when the
// corresponding event never happened; the diagnostics handler maps them to
// JSON null. Now is the instant the snapshot was taken (the now argument the
// caller passed to Snapshot).
type HealthSnapshot struct {
	Now                    time.Time
	TemporarilyUnavailable bool
	UnavailableUntil       time.Time
	ConsecutiveFailures    int
	LastOperation          Operation
	LastFailureAt          time.Time
	LastErrorName          string
	LastErrorMessage       string
}

// NewHealth returns an empty circuit state. It is equivalent to &Health{} and
// exists so wiring reads as an explicit construction; the zero value is
// equally usable.
func NewHealth() *Health { return &Health{} }

// Available reports whether a vector request may run at now. The window is
// closed while now < unavailableUntil, exactly like
// VectorClientService.isTemporarilyUnavailable.
func (h *Health) Available(now time.Time) bool {
	if h == nil {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return !now.Before(h.unavailableUntil)
}

// MarkAvailable clears the failure streak and the window. The last-* fields
// are deliberately kept: NestJS markAvailable only resets
// consecutiveFailures/unavailableUntilMs, so the diagnostics response keeps
// reporting the most recent failure after a recovery.
func (h *Health) MarkAvailable() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.consecutiveFailures = 0
	h.unavailableUntil = time.Time{}
}

// MarkUnavailable records one final request failure and opens/extends the
// window. It ports VectorClientService.markUnavailable exactly:
//
//   - the failure streak is capped at 10;
//   - backoff is min(60s, 1s * 2^(max(0, failures-1)));
//   - a VectorUnauthorizedError keeps at least 5 minutes, a
//     VectorBadResponseError at least 60 seconds;
//   - lastOperation/lastFailureAt/lastErrorName/lastErrorMessage are always
//     updated (the error name is the NestJS-compatible class name carried by
//     the error's Name() method; an unrecognised error records an empty name);
//   - the warning is logged only on the available -> unavailable transition.
func (h *Health) MarkUnavailable(err error, operation Operation, now time.Time) {
	if h == nil {
		return
	}
	name := errorName(err)
	message := ""
	if err != nil {
		message = err.Error()
	}

	h.mu.Lock()
	wasAvailable := !now.Before(h.unavailableUntil)
	h.consecutiveFailures++
	if h.consecutiveFailures > healthMaxConsecutiveFailures {
		h.consecutiveFailures = healthMaxConsecutiveFailures
	}
	h.lastOperation = operation
	h.lastFailureAt = now
	h.lastErrorName = name
	h.lastErrorMessage = message

	exponent := h.consecutiveFailures - 1
	if exponent < 0 {
		exponent = 0
	}
	backoff := time.Duration(math.Min(
		float64(healthMaxBackoff),
		float64(healthBaseBackoff)*math.Pow(2, float64(exponent)),
	))
	if name == searchErrorUnauthorized && backoff < healthUnauthorizedBackoff {
		backoff = healthUnauthorizedBackoff
	}
	if name == searchErrorBadResponse && backoff < healthBadResponseBackoff {
		backoff = healthBadResponseBackoff
	}
	h.unavailableUntil = now.Add(backoff)
	failures := h.consecutiveFailures
	h.mu.Unlock()

	if !wasAvailable {
		return
	}
	log.Printf("vectorclient: vector request failed; temporarily disabling vector service for %s (operation: %s, consecutive failures: %d, error: %s)",
		backoff.String(), operation, failures, message)
}

// RefreshFingerprint records the effective client fingerprint. The first call
// and every change clear the failure streak and the window, matching the
// client rebuild in VectorClientService.resolveClient (which constructs a new
// VectorClient and calls markAvailable). An unchanged fingerprint is a no-op,
// so the window survives repeated requests with the same configuration.
func (h *Health) RefreshFingerprint(fingerprint string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fingerprintSet && h.fingerprint == fingerprint {
		return
	}
	h.fingerprint = fingerprint
	h.fingerprintSet = true
	h.consecutiveFailures = 0
	h.unavailableUntil = time.Time{}
}

// Snapshot returns one consistent view of the circuit state for the
// diagnostics route. now is the instant the caller reports the state at; it
// decides temporarilyUnavailable and is echoed back in Now.
func (h *Health) Snapshot(now time.Time) HealthSnapshot {
	if h == nil {
		return HealthSnapshot{Now: now}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return HealthSnapshot{
		Now:                    now,
		TemporarilyUnavailable: now.Before(h.unavailableUntil),
		UnavailableUntil:       h.unavailableUntil,
		ConsecutiveFailures:    h.consecutiveFailures,
		LastOperation:          h.lastOperation,
		LastFailureAt:          h.lastFailureAt,
		LastErrorName:          h.lastErrorName,
		LastErrorMessage:       h.lastErrorMessage,
	}
}

// healthFingerprint mirrors VectorClientService.resolveClient's fingerprint:
// `${baseUrl}|${timeoutMs}|${maxRetries}|${sha256(token).slice(0,16)}`. The
// base URL and token are trimmed defensively so the search and upsert clients,
// which both normalise the same effective settings, always produce the same
// value and never reset each other's window.
func healthFingerprint(baseURL string, timeoutMs, maxRetries int, token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return strings.Join([]string{
		strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		strconv.Itoa(timeoutMs),
		strconv.Itoa(maxRetries),
		hex.EncodeToString(sum[:])[:16],
	}, "|")
}

// errorName returns the NestJS-compatible error class name carried by err, or
// "" when the error does not implement Name() string (the diagnostics response
// then reports JSON null). It deliberately does not use vectorclient.ErrorName:
// that helper falls back to "OutboxDeliveryError" for the dead-letter
// compensation, which is not a vector client class name.
func errorName(err error) string {
	if err == nil {
		return ""
	}
	var named interface{ Name() string }
	if errors.As(err, &named) {
		return named.Name()
	}
	return ""
}
