package newseventsingest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
)

// Model-service client limits mirrored from ModelServiceClient.
const (
	// modelServiceRetryBaseDelayMs is the computeRetryDelayMs base.
	modelServiceRetryBaseDelayMs = 200
	// modelServiceRetryMaxDelayMs is the computeRetryDelayMs ceiling.
	modelServiceRetryMaxDelayMs = 5_000
	// modelServiceRetryJitterMs is the exclusive upper bound of the jitter.
	modelServiceRetryJitterMs = 150
	// modelServiceMaxRetryLimit caps the configured retry count at 5.
	modelServiceMaxRetryLimit = 5
	// modelServiceBackoffCeilingMs caps the process-local disable window.
	modelServiceBackoffCeilingMs = 60_000
	// modelServiceBackoffBaseMs is the first process-local disable window.
	modelServiceBackoffBaseMs = 1_000
	// modelServiceMaxConsecutiveFailures caps the backoff exponent.
	modelServiceMaxConsecutiveFailures = 10
	// modelServiceResponseLimit caps one response body read.
	modelServiceResponseLimit = 1 << 20
)

// Model-service client error messages. The first four are the exact NestJS
// strings; the remaining two are formatError prefixes.
const (
	errModelServiceDisabled          = "Model service is disabled"
	errModelServiceBaseURLMissing    = "Model service baseUrl is not configured"
	errModelServiceTokenMissing      = "Model service internal token is not configured"
	errModelServiceTemporarilyDown   = "Model service is temporarily unavailable"
	errModelServiceUnauthorized      = "Model service request unauthorized"
	errModelServiceRequestFailedBase = "Model service request failed"
)

// ModelConfig is the effective model-service connection.
type ModelConfig struct {
	Enabled       bool
	BaseURL       string
	InternalToken string
	Timeout       time.Duration
	MaxRetries    int
}

// ModelConfigReader resolves the effective model-service configuration exactly
// like ModelServiceSettingsService.getEffectiveConfig.
type ModelConfigReader interface {
	AssistantModelServiceConfig(ctx context.Context) (modelaccesssettings.AssistantModelServiceConfig, error)
}

// TopicClusteringDocument is one /v1/topic-model/bertopic/cluster document.
type TopicClusteringDocument struct {
	ID        string    `json:"id"`
	Text      string    `json:"text"`
	Embedding []float64 `json:"embedding"`
}

// topicClusteringRequest is the POST body. The Python service reads
// min_topic_size and request_id, so the snake_case names are part of the
// contract.
type topicClusteringRequest struct {
	Documents    []TopicClusteringDocument `json:"documents"`
	MinTopicSize int                       `json:"min_topic_size"`
	RequestID    string                    `json:"request_id"`
}

// TopicCluster is one cluster of the model-service response.
type TopicCluster struct {
	TopicID          int      `json:"topicId"`
	ItemIDs          []string `json:"itemIds"`
	RepresentativeID string   `json:"representativeId"`
	Keywords         []string `json:"keywords"`
}

// TopicClusteringResponse is the model-service response.
type TopicClusteringResponse struct {
	Clusters    []TopicCluster  `json:"clusters"`
	OutlierIDs  []string        `json:"outlierIds"`
	Diagnostics json.RawMessage `json:"diagnostics"`
}

// ModelServiceClient is the clustering port.
type ModelServiceClient interface {
	ClusterTopicsOrThrow(ctx context.Context, request topicClusteringRequest) (TopicClusteringResponse, error)
}

// modelConfigFromSettings projects the shared effective config onto ModelConfig.
func modelConfigFromSettings(config modelaccesssettings.AssistantModelServiceConfig) ModelConfig {
	return ModelConfig{
		Enabled:       config.Enabled,
		BaseURL:       config.BaseURL,
		InternalToken: config.InternalToken,
		Timeout:       config.Timeout,
		MaxRetries:    config.MaxRetries,
	}
}

// modelClient ports ModelServiceClient.clusterTopicsOrThrow.
//
// The temporary-unavailability state is process-local in both implementations
// but the two processes do not share it: Nest tracks it in the NestJS process,
// this client tracks it in the Go process. Each side therefore recovers on its
// own schedule, which is the same behaviour a single-process deployment already
// has across restarts.
type modelClient struct {
	config ModelConfigReader
	http   *http.Client
	now    func() time.Time

	mu                    sync.Mutex
	consecutiveFailures   int
	unavailableUntil      time.Time
	lastIncompleteWarnAt  time.Time
	configFingerprint     string
	fingerprintConfigured bool
}

// NewModelClient builds the clustering client. A nil reader resolves an empty
// configuration, which fails every call with the disabled message.
func NewModelClient(reader ModelConfigReader) ModelServiceClient {
	return &modelClient{
		config: reader,
		http:   &http.Client{Timeout: 30 * time.Second},
		now:    time.Now,
	}
}

// clock returns the current time.
func (c *modelClient) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// ClusterTopicsOrThrow implements ModelServiceClient.
func (c *modelClient) ClusterTopicsOrThrow(ctx context.Context, request topicClusteringRequest) (TopicClusteringResponse, error) {
	config, err := c.resolveConfig(ctx)
	if err != nil {
		return TopicClusteringResponse{}, err
	}
	c.refreshFingerprint(config)
	if !config.Enabled {
		return TopicClusteringResponse{}, errors.New(errModelServiceDisabled)
	}
	if config.BaseURL == "" {
		c.warnIncompleteOnce()
		return TopicClusteringResponse{}, errors.New(errModelServiceBaseURLMissing)
	}
	if config.InternalToken == "" {
		c.warnIncompleteOnce()
		return TopicClusteringResponse{}, errors.New(errModelServiceTokenMissing)
	}
	if c.isTemporarilyUnavailable() {
		return TopicClusteringResponse{}, errors.New(errModelServiceTemporarilyDown)
	}

	endpoint := normalizeModelBaseURL(config.BaseURL) + "/v1/topic-model/bertopic/cluster"
	payload, err := json.Marshal(request)
	if err != nil {
		return TopicClusteringResponse{}, err
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	maxRetries := int(math.Trunc(float64(config.MaxRetries)))
	if maxRetries < 0 {
		maxRetries = 0
	}
	if maxRetries > modelServiceMaxRetryLimit {
		maxRetries = modelServiceMaxRetryLimit
	}
	attempts := maxRetries + 1

	for attempt := 0; attempt < attempts; attempt++ {
		response, attemptErr := c.post(ctx, endpoint, payload, config.InternalToken, timeout)
		if attemptErr == nil {
			c.markAvailable()
			return response, nil
		}
		switch classifyModelServiceError(attemptErr) {
		case modelErrorUnauthorized:
			c.markUnavailable(attemptErr)
			return TopicClusteringResponse{}, errors.New(errModelServiceUnauthorized)
		case modelErrorNonRetryable:
			return TopicClusteringResponse{}, errors.New(formatModelServiceError(errModelServiceRequestFailedBase, attemptErr))
		}
		if attempt >= attempts-1 {
			c.markUnavailable(attemptErr)
			return TopicClusteringResponse{}, errors.New(formatModelServiceError(errModelServiceRequestFailedBase, attemptErr))
		}
		if waitErr := sleepContext(ctx, computeRetryDelayMs(attempt)); waitErr != nil {
			return TopicClusteringResponse{}, waitErr
		}
	}
	return TopicClusteringResponse{}, errors.New(errModelServiceRequestFailedBase)
}

// resolveConfig reads the effective configuration.
func (c *modelClient) resolveConfig(ctx context.Context) (ModelConfig, error) {
	if c.config == nil {
		return ModelConfig{}, nil
	}
	config, err := c.config.AssistantModelServiceConfig(ctx)
	if err != nil {
		return ModelConfig{}, err
	}
	return modelConfigFromSettings(config), nil
}

// modelServiceErrorKind is the classifyError decision.
type modelServiceErrorKind int

const (
	modelErrorRetryable modelServiceErrorKind = iota
	modelErrorNonRetryable
	modelErrorUnauthorized
)

// modelServiceError is one classified request failure.
type modelServiceError struct {
	Status  *int
	Body    []byte
	Message string
}

// Error implements error using the transport message.
func (e *modelServiceError) Error() string { return e.Message }

// post performs one HTTP attempt.
func (c *modelClient) post(ctx context.Context, endpoint string, payload []byte, token string, timeout time.Duration) (TopicClusteringResponse, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return TopicClusteringResponse{}, &modelServiceError{Message: err.Error()}
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-internal-token", token)
	response, err := c.http.Do(request)
	if err != nil {
		return TopicClusteringResponse{}, &modelServiceError{Message: err.Error()}
	}
	defer func() { _ = response.Body.Close() }()
	body, readErr := io.ReadAll(io.LimitReader(response.Body, modelServiceResponseLimit))
	if readErr != nil {
		return TopicClusteringResponse{}, &modelServiceError{Message: readErr.Error()}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		status := response.StatusCode
		return TopicClusteringResponse{}, &modelServiceError{
			Status:  &status,
			Body:    body,
			Message: fmt.Sprintf("HTTP %d", status),
		}
	}
	var decoded TopicClusteringResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return TopicClusteringResponse{}, &modelServiceError{Message: err.Error()}
	}
	return decoded, nil
}

// classifyModelServiceError mirrors classifyError.
func classifyModelServiceError(err error) modelServiceErrorKind {
	var serviceErr *modelServiceError
	if !errors.As(err, &serviceErr) || serviceErr.Status == nil {
		return modelErrorRetryable
	}
	status := *serviceErr.Status
	switch {
	case status == http.StatusUnauthorized:
		return modelErrorUnauthorized
	case status == http.StatusRequestTimeout || status == http.StatusTooManyRequests:
		return modelErrorRetryable
	case status >= 400 && status < 500:
		return modelErrorNonRetryable
	case status >= 500 && status <= 599:
		return modelErrorRetryable
	}
	return modelErrorNonRetryable
}

// formatModelServiceError mirrors formatError.
func formatModelServiceError(prefix string, err error) string {
	var serviceErr *modelServiceError
	if !errors.As(err, &serviceErr) {
		return prefix + ": " + err.Error()
	}
	base := prefix
	if serviceErr.Status != nil {
		base = prefix + " (status=" + strconv.Itoa(*serviceErr.Status) + ")"
	}
	if detail := responseDetail(serviceErr.Body); detail != "" {
		return base + ": " + detail
	}
	return base + ": " + serviceErr.Message
}

// responseDetail mirrors the axios responseData extraction: a JSON string body
// is used verbatim, an object body contributes its detail member or its
// serialized form, and a non-JSON body is used trimmed.
func responseDetail(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err == nil {
		return jsTrim(text)
	}
	var object struct {
		Detail json.RawMessage `json:"detail"`
	}
	if err := json.Unmarshal(trimmed, &object); err == nil && trimmed[0] == '{' {
		if detail, ok := jsonString(object.Detail); ok {
			if normalized := jsTrim(detail); normalized != "" {
				return normalized
			}
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, trimmed); err == nil {
			return compact.String()
		}
		return ""
	}
	return string(trimmed)
}

// computeRetryDelayMs mirrors computeRetryDelayMs.
func computeRetryDelayMs(attempt int) time.Duration {
	exponent := attempt
	if exponent < 0 {
		exponent = 0
	}
	base := math.Min(modelServiceRetryMaxDelayMs, modelServiceRetryBaseDelayMs*math.Pow(2, float64(exponent)))
	jitter := math.Floor(rand.Float64() * modelServiceRetryJitterMs)
	return time.Duration(base+jitter) * time.Millisecond
}

// normalizeModelBaseURL mirrors normalizeBaseUrl: trim and drop trailing
// slashes.
func normalizeModelBaseURL(baseURL string) string {
	return strings.TrimRight(jsTrim(baseURL), "/")
}

// isTemporarilyUnavailable reports the process-local disable window.
func (c *modelClient) isTemporarilyUnavailable() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.clock().Before(c.unavailableUntil)
}

// markAvailable clears the failure streak.
func (c *modelClient) markAvailable() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consecutiveFailures = 0
	c.unavailableUntil = time.Time{}
}

// markUnavailable extends the process-local disable window.
func (c *modelClient) markUnavailable(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock()
	c.consecutiveFailures++
	if c.consecutiveFailures > modelServiceMaxConsecutiveFailures {
		c.consecutiveFailures = modelServiceMaxConsecutiveFailures
	}
	exponent := c.consecutiveFailures - 1
	if exponent < 0 {
		exponent = 0
	}
	backoff := math.Min(modelServiceBackoffCeilingMs, modelServiceBackoffBaseMs*math.Pow(2, float64(exponent)))
	c.unavailableUntil = now.Add(time.Duration(backoff) * time.Millisecond)
	log.Printf("newseventsingest: model service request failed; temporarily disabling for %dms: %v", int(backoff), err)
}

// warnIncompleteOnce logs at most once a minute, like warnIncompleteOnce. The
// logger is the standard one because this package has no structured logger.
func (c *modelClient) warnIncompleteOnce() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.clock()
	if now.Sub(c.lastIncompleteWarnAt) < time.Minute {
		return
	}
	c.lastIncompleteWarnAt = now
	log.Printf("newseventsingest: model service enabled but configuration is incomplete")
}

// refreshFingerprint resets the disable window when the configuration changes.
func (c *modelClient) refreshFingerprint(config ModelConfig) {
	tokenHash := "none"
	if config.InternalToken != "" {
		sum := sha256.Sum256([]byte(config.InternalToken))
		tokenHash = hex.EncodeToString(sum[:])[:16]
	}
	fingerprint := fmt.Sprintf("%d|%s|%d|%d|%s",
		boolToInt(config.Enabled), config.BaseURL, config.Timeout.Milliseconds(), config.MaxRetries, tokenHash)

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fingerprintConfigured && c.configFingerprint == fingerprint {
		return
	}
	c.configFingerprint = fingerprint
	c.fingerprintConfigured = true
	c.consecutiveFailures = 0
	c.unavailableUntil = time.Time{}
}

// boolToInt renders a boolean the way the NestJS fingerprint does.
func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
