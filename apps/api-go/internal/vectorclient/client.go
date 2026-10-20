// Package vectorclient is the write-side client for vector-go. It ports the
// upsert subset of @modular/vector-client: path, internal-auth header, request
// body, timeout/retry policy and response validation. The NestJS process-local
// circuit breaker is intentionally not copied; every outbox delivery reads the
// effective configuration and makes its own attempt, so a recovered vector
// service is usable on the next record.
package vectorclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// defaultTimeoutMs matches VectorClient's constructor default.
	defaultTimeoutMs = 5000
	// retryBaseDelay is the VectorClient retry backoff base.
	retryBaseDelay = 200 * time.Millisecond
	// maxResponseBytes caps one response body read.
	maxResponseBytes = 1 << 20
)

// Config is the effective vector-service configuration resolved from the
// SystemSetting row and the VECTOR_SERVICE_* environment defaults.
type Config struct {
	Enabled    bool
	BaseURL    string
	Token      string
	TimeoutMs  int
	MaxRetries int
}

// Point is one vector upsert point.
type Point struct {
	ProcessedItemID string    `json:"processedItemId"`
	ItemMetaID      string    `json:"itemMetaId"`
	CreatedAtMs     int64     `json:"createdAtMs"`
	Vector          []float64 `json:"vector"`
}

// UpsertRequest is the POST /v1/upsert body.
type UpsertRequest struct {
	OrgID          string  `json:"orgId"`
	EmbeddingModel string  `json:"embeddingModel"`
	Points         []Point `json:"points"`
}

// Error is a classified vector-go failure. Name preserves the NestJS error
// class names so the outbox dead-letter compensation records the same
// processeditems.error.name value.
type Error struct {
	Kind    string
	Message string
	Cause   error
}

// Error implements error.
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// Unwrap exposes the transport cause.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// Name returns the NestJS-compatible error class name.
func (e *Error) Name() string {
	if e == nil {
		return ""
	}
	return e.Kind
}

// ErrorName returns the NestJS error name recorded by dead compensation.
func ErrorName(err error) string {
	var named interface{ Name() string }
	if errors.As(err, &named) {
		if name := named.Name(); name != "" {
			return name
		}
	}
	return "OutboxDeliveryError"
}

// Client performs vector-go upserts. The zero value is ready to use.
type Client struct {
	// HTTPClient is the transport. A nil value uses http.DefaultTransport with
	// no global timeout; each attempt applies Config.TimeoutMs.
	HTTPClient *http.Client
	// Sleep is injectable for tests. A nil value uses a context-aware timer.
	Sleep func(context.Context, time.Duration) error
	// Rand is the jitter source. A nil value uses math/rand.
	Rand func() float64
}

// Upsert ports VectorClientService.upsertOrThrow. Disabled or an empty point
// set is a successful no-op; an enabled but incomplete configuration is a
// VectorServiceUnavailableError, exactly like the NestJS client.
func (c *Client) Upsert(ctx context.Context, cfg Config, request UpsertRequest) error {
	if !cfg.Enabled || len(request.Points) == 0 {
		return nil
	}
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	token := cfg.Token
	if baseURL == "" || token == "" {
		return &Error{Kind: "VectorServiceUnavailableError", Message: "Vector service enabled but configuration is incomplete"}
	}
	body, err := json.Marshal(request)
	if err != nil {
		return &Error{Kind: "VectorBadResponseError", Message: "Vector upsert request could not be encoded", Cause: err}
	}
	timeoutMs := cfg.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultTimeoutMs
	}
	maxRetries := cfg.MaxRetries
	if maxRetries < 0 {
		maxRetries = 0
	}
	attempts := maxRetries + 1
	var last error
	for attempt := 1; attempt <= attempts; attempt++ {
		retryable, attemptErr := c.upsertOnce(ctx, baseURL+"/v1/upsert", token, body, time.Duration(timeoutMs)*time.Millisecond)
		if attemptErr == nil {
			return nil
		}
		last = attemptErr
		if !retryable || attempt >= attempts {
			return attemptErr
		}
		if err := c.sleep(ctx, c.backoff(attempt)); err != nil {
			return &Error{Kind: "VectorServiceUnavailableError", Message: "Vector request failed", Cause: err}
		}
	}
	if last != nil {
		return last
	}
	return &Error{Kind: "VectorServiceUnavailableError", Message: "Vector request failed"}
}

// upsertOnce performs one attempt. retryable mirrors VectorClient: transport
// failures and 5xx are retried; 401/403, other non-2xx responses and malformed
// success payloads are terminal.
func (c *Client) upsertOnce(ctx context.Context, endpoint, token string, body []byte, timeout time.Duration) (bool, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return false, &Error{Kind: "VectorServiceUnavailableError", Message: "Vector request failed", Cause: err}
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-internal-token", token)

	client := c.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	response, err := client.Do(req)
	if err != nil {
		return true, &Error{Kind: "VectorServiceUnavailableError", Message: "Vector request failed", Cause: err}
	}
	defer response.Body.Close()

	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return false, &Error{Kind: "VectorUnauthorizedError", Message: "Vector service authentication failed"}
	case response.StatusCode >= 500:
		return true, &Error{Kind: "VectorServiceUnavailableError", Message: fmt.Sprintf("Vector service returned %d", response.StatusCode)}
	case response.StatusCode < 200 || response.StatusCode >= 300:
		text, _ := io.ReadAll(io.LimitReader(response.Body, 300))
		return false, &Error{
			Kind:    "VectorBadResponseError",
			Message: fmt.Sprintf("Vector service returned %d: %s", response.StatusCode, string(text)),
		}
	}

	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return false, &Error{Kind: "VectorBadResponseError", Message: "Vector upsert returned invalid payload", Cause: err}
	}
	if err := validateUpsertResponse(raw); err != nil {
		return false, &Error{Kind: "VectorBadResponseError", Message: "Vector upsert returned invalid payload", Cause: err}
	}
	return false, nil
}

// validateUpsertResponse mirrors the Zod response schema: upserted is a
// non-negative integer and collection is a non-empty string.
func validateUpsertResponse(raw []byte) error {
	var payload struct {
		Upserted   json.RawMessage `json:"upserted"`
		Collection *string         `json:"collection"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	if len(bytes.TrimSpace(payload.Upserted)) == 0 || payload.Collection == nil || strings.TrimSpace(*payload.Collection) == "" {
		return errors.New("missing upserted or collection")
	}
	number := bytes.TrimSpace(payload.Upserted)
	if number[0] != '-' && (number[0] < '0' || number[0] > '9') {
		return errors.New("upserted is not a non-negative integer")
	}
	var value float64
	if err := json.Unmarshal(number, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value {
		return errors.New("upserted is not a non-negative integer")
	}
	return nil
}

// backoff ports VectorClient's retry delay: round(200 * 2^(attempt-1) *
// (0.5 + random)).
func (c *Client) backoff(attempt int) time.Duration {
	random := rand.Float64
	if c != nil && c.Rand != nil {
		random = c.Rand
	}
	exponential := float64(retryBaseDelay) * math.Pow(2, float64(attempt-1))
	return time.Duration(math.Round(exponential * (0.5 + random())))
}

// sleep waits unless a test injected a no-op.
func (c *Client) sleep(ctx context.Context, delay time.Duration) error {
	if c != nil && c.Sleep != nil {
		return c.Sleep(ctx, delay)
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// String is a debugging aid that never leaks the token.
func (c Config) String() string {
	return "vectorclient.Config{enabled=" + strconv.FormatBool(c.Enabled) + ",timeoutMs=" + strconv.Itoa(c.TimeoutMs) + "}"
}
