package newseventsingest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
)

// Vector-service settings storage, mirroring VectorServiceSettingsService.
const (
	// vectorServiceSettingKey is the SystemSetting row key.
	vectorServiceSettingKey = "vector_service"
	// vectorServiceSettingsCacheKey is that row's Redis cache key.
	vectorServiceSettingsCacheKey = "vector_service:settings"
	// vectorServiceSettingsCacheTTLSeconds is the cache TTL.
	vectorServiceSettingsCacheTTLSeconds = 30
	// vectorServiceSettingsReadTimeout bounds one MySQL settings read.
	vectorServiceSettingsReadTimeout = 2 * time.Second
	// vectorServiceResponseLimit caps one response body read.
	vectorServiceResponseLimit = 1 << 20
	// vectorServiceRetryBaseDelay is the VectorClient backoff base.
	vectorServiceRetryBaseDelay = 200 * time.Millisecond
	// vectorUnavailableBackoffCeiling caps the process-local disable window.
	vectorUnavailableBackoffCeiling = 60 * time.Second
	// vectorUnauthorizedBackoff is the minimum disable window after a 401/403.
	vectorUnauthorizedBackoff = 5 * time.Minute
	// vectorBadResponseBackoff is the minimum disable window after a bad body.
	vectorBadResponseBackoff = 60 * time.Second
)

// Vector-service client sentinel failures. They only decide the backoff and
// whether the attempt is retried.
var (
	errVectorUnauthorized = errors.New("vector service authentication failed")
	errVectorUnavailable  = errors.New("vector service unavailable")
	errVectorBadResponse  = errors.New("vector service returned an invalid payload")
)

// VectorConfig is the effective vector-service configuration.
type VectorConfig struct {
	Enabled         bool
	FallbackToMongo bool
	BaseURL         string
	Token           string
	Timeout         time.Duration
	MaxRetries      int
}

// VectorSearcherOptions wires the best-effort vector client.
type VectorSearcherOptions struct {
	// DB is the MySQL pool holding the vector_service SystemSetting row.
	DB *sql.DB
	// Redis caches that row for 30 seconds.
	Redis *redis.Client
	// Enabled is VECTOR_SERVICE_ENABLED.
	Enabled bool
	// FallbackToMongo is VECTOR_SERVICE_FALLBACK_TO_MONGO.
	FallbackToMongo bool
	// BaseURL is VECTOR_SERVICE_BASE_URL (already trimmed).
	BaseURL string
	// Token is the raw VECTOR_INTERNAL_TOKEN value.
	Token string
	// TimeoutMs is VECTOR_SERVICE_TIMEOUT_MS.
	TimeoutMs int
	// MaxRetries is VECTOR_SERVICE_MAX_RETRIES.
	MaxRetries int
	// SettingsEncryptionKeyRaw is SYSTEM_SETTINGS_ENCRYPTION_KEY, used to
	// decrypt a stored token envelope.
	SettingsEncryptionKeyRaw string
	// Now is an optional clock for tests.
	Now func() time.Time
}

// vectorSearcher ports VectorClientService.searchBestEffort plus the VectorClient
// retry policy and the effective configuration resolution.
type vectorSearcher struct {
	options VectorSearcherOptions
	http    *http.Client
	now     func() time.Time

	mu                  sync.Mutex
	consecutiveFailures int
	unavailableUntil    time.Time
	lastIncompleteWarn  time.Time
	fingerprint         string
	fingerprintSet      bool
}

// vectorServiceStoredSettings is the vector_service row projection. Every member
// is raw because a stored value may be a string, a number or a boolean, and the
// NestJS coercion discriminates on the runtime type.
type vectorServiceStoredSettings struct {
	Enabled         json.RawMessage `json:"enabled"`
	FallbackToMongo json.RawMessage `json:"fallbackToMongo"`
	BaseURL         json.RawMessage `json:"baseUrl"`
	Token           json.RawMessage `json:"token"`
	TimeoutMs       json.RawMessage `json:"timeoutMs"`
	MaxRetries      json.RawMessage `json:"maxRetries"`
}

// vectorServiceCachedSettings is the cache envelope.
type vectorServiceCachedSettings struct {
	Exists bool                         `json:"exists"`
	Value  *vectorServiceStoredSettings `json:"value"`
}

// NewVectorSearcher builds the best-effort vector client.
func NewVectorSearcher(options VectorSearcherOptions) VectorSearcher {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	maxRetries := options.MaxRetries
	if maxRetries > 10 {
		// The NestJS env schema puts no ceiling on the retry count; cap it so a
		// pathological value cannot turn one assignment into a busy retry loop.
		maxRetries = 10
	}
	options.MaxRetries = maxRetries
	return &vectorSearcher{options: options, http: &http.Client{}, now: now}
}

// SearchBestEffort implements VectorSearcher: nil-and-false means the service is
// disabled, incompletely configured, temporarily disabled or unreachable. The
// caller treats that as an empty match list, like `matches ?? []`.
func (v *vectorSearcher) SearchBestEffort(ctx context.Context, request VectorSearchRequest) ([]VectorSearchMatch, bool) {
	config := v.resolveConfig(ctx)
	if !config.Enabled {
		return nil, false
	}
	if config.BaseURL == "" || config.Token == "" {
		v.warnIncompleteOnce()
		return nil, false
	}
	v.refreshFingerprint(config)
	if v.isTemporarilyUnavailable() {
		return nil, false
	}

	body, err := json.Marshal(vectorSearchRequestBody{
		OrgID:          request.OrgID,
		EmbeddingModel: request.EmbeddingModel,
		Vector:         request.Vector,
		Limit:          request.Limit,
		MinScore:       request.MinScore,
		LookbackMs:     request.LookbackMs,
	})
	if err != nil {
		return nil, false
	}

	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	maxRetries := config.MaxRetries
	if maxRetries < 0 {
		maxRetries = 0
	}
	attempts := maxRetries + 1
	for attempt := 1; attempt <= attempts; attempt++ {
		matches, attemptErr := v.searchOnce(ctx, config, body, timeout)
		if attemptErr == nil {
			v.markAvailable()
			return matches, true
		}
		if !isRetryableVectorError(attemptErr) || attempt >= attempts {
			v.markUnavailable(attemptErr)
			return nil, false
		}
		if sleepErr := sleepContext(ctx, vectorServiceRetryBaseDelay*time.Duration(1<<(attempt-1))); sleepErr != nil {
			return nil, false
		}
	}
	return nil, false
}

// vectorSearchRequestBody is the POST /v1/search body. The member order and the
// always-present optional fields match VectorClientService.searchBestEffort,
// which always sends limit, minScore and lookbackMs from the caller.
type vectorSearchRequestBody struct {
	OrgID          string    `json:"orgId"`
	EmbeddingModel string    `json:"embeddingModel"`
	Vector         []float64 `json:"vector"`
	Limit          int       `json:"limit"`
	MinScore       float64   `json:"minScore"`
	LookbackMs     int64     `json:"lookbackMs"`
}

// vectorSearchResponse is the vector-go payload. A non-empty collection marks a
// valid response; a missing matches member is a valid empty result.
type vectorSearchResponse struct {
	Collection string `json:"collection"`
	Matches    []struct {
		ProcessedItemID string  `json:"processedItemId"`
		ItemMetaID      string  `json:"itemMetaId"`
		Score           float64 `json:"score"`
		CreatedAtMs     int64   `json:"createdAtMs"`
	} `json:"matches"`
}

// searchOnce performs one HTTP attempt.
func (v *vectorSearcher) searchOnce(ctx context.Context, config VectorConfig, body []byte, timeout time.Duration) ([]VectorSearchMatch, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(config.BaseURL, "/") + "/v1/search"
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &vectorRequestError{cause: err, kind: errVectorUnavailable}
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-internal-token", config.Token)

	response, err := v.http.Do(request)
	if err != nil {
		return nil, &vectorRequestError{cause: err, kind: errVectorUnavailable}
	}
	defer func() { _ = response.Body.Close() }()

	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return nil, &vectorRequestError{kind: errVectorUnauthorized, message: errVectorUnauthorized.Error()}
	case response.StatusCode >= 500:
		return nil, &vectorRequestError{kind: errVectorUnavailable, message: errVectorUnavailable.Error()}
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return nil, &vectorRequestError{kind: errVectorBadResponse, message: errVectorBadResponse.Error()}
	}

	var decoded vectorSearchResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, &vectorRequestError{kind: errVectorBadResponse, cause: err}
	}
	if strings.TrimSpace(decoded.Collection) == "" {
		return nil, &vectorRequestError{kind: errVectorBadResponse}
	}
	matches := make([]VectorSearchMatch, 0, len(decoded.Matches))
	for _, match := range decoded.Matches {
		if strings.TrimSpace(match.ProcessedItemID) == "" {
			// The zod schema requires min(1); a blank id would make the whole
			// payload invalid, so the response counts as bad.
			return nil, &vectorRequestError{kind: errVectorBadResponse}
		}
		matches = append(matches, VectorSearchMatch{ProcessedItemID: match.ProcessedItemID, Score: match.Score})
	}
	return matches, nil
}

// vectorRequestError is one classified attempt failure.
type vectorRequestError struct {
	kind    error
	message string
	cause   error
}

// Error implements error.
func (e *vectorRequestError) Error() string {
	if e.message != "" {
		return e.message
	}
	if e.cause != nil {
		return e.cause.Error()
	}
	return e.kind.Error()
}

// Unwrap exposes the kind and the transport cause.
func (e *vectorRequestError) Unwrap() error { return e.kind }

// isRetryableVectorError mirrors VectorClient.requestWithRetry: an unauthorized
// or bad-payload failure is final, every other failure is retried.
func isRetryableVectorError(err error) bool {
	return !errors.Is(err, errVectorUnauthorized) && !errors.Is(err, errVectorBadResponse)
}

// resolveConfig reads the stored row over the environment defaults.
func (v *vectorSearcher) resolveConfig(ctx context.Context) VectorConfig {
	env := v.envDefaults()
	stored, present := v.loadStoredSettings(ctx)
	if !present || stored == nil {
		return env
	}
	config := env
	if value, ok := jsonBoolean(stored.Enabled); ok {
		config.Enabled = value
	}
	if value, ok := jsonBoolean(stored.FallbackToMongo); ok {
		config.FallbackToMongo = value
	}
	if text, ok := jsonString(stored.BaseURL); ok {
		if normalized := jsTrim(text); normalized != "" {
			config.BaseURL = normalized
		}
	}
	if value, ok := jsPositiveInt(stored.TimeoutMs); ok {
		config.Timeout = time.Duration(value) * time.Millisecond
	}
	if value, ok := jsNonNegativeInt(stored.MaxRetries); ok {
		config.MaxRetries = value
	}
	if token, ok := modelaccesssettings.DecodeStoredSettingsSecret(stored.Token, v.options.SettingsEncryptionKeyRaw); ok {
		config.Token = token
	}
	return config
}

// envDefaults projects the environment values.
func (v *vectorSearcher) envDefaults() VectorConfig {
	baseURL := strings.TrimRight(jsTrim(v.options.BaseURL), "/")
	timeoutMs := v.options.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = 5_000
	}
	maxRetries := v.options.MaxRetries
	if maxRetries < 0 {
		maxRetries = 2
	}
	token := ""
	if normalized := jsTrim(v.options.Token); normalized != "" {
		token = normalized
	}
	return VectorConfig{
		Enabled:         v.options.Enabled,
		FallbackToMongo: v.options.FallbackToMongo,
		BaseURL:         baseURL,
		Token:           token,
		Timeout:         time.Duration(timeoutMs) * time.Millisecond,
		MaxRetries:      maxRetries,
	}
}

// loadStoredSettings mirrors loadStoredSettings: the Redis envelope first, then
// MySQL with a best-effort cache fill. A read failure is logged and treated as
// "no stored row", so a settings outage degrades to the environment defaults
// instead of aborting the assignment.
func (v *vectorSearcher) loadStoredSettings(ctx context.Context) (*vectorServiceStoredSettings, bool) {
	if v.options.Redis != nil {
		raw, err := v.options.Redis.Get(ctx, vectorServiceSettingsCacheKey).Result()
		if err == nil {
			var cached vectorServiceCachedSettings
			if json.Unmarshal([]byte(raw), &cached) == nil {
				if !cached.Exists {
					return nil, false
				}
				return cached.Value, cached.Value != nil
			}
		}
	}

	stored, exists, err := v.readStoredRow(ctx)
	if err != nil {
		log.Printf("newseventsingest: vector settings read failed: %v", err)
		return nil, false
	}
	if v.options.Redis != nil {
		payload, marshalErr := json.Marshal(vectorServiceCachedSettings{Exists: exists, Value: stored})
		if marshalErr == nil {
			_ = v.options.Redis.Set(ctx, vectorServiceSettingsCacheKey, string(payload),
				vectorServiceSettingsCacheTTLSeconds*time.Second).Err()
		}
	}
	if !exists {
		return nil, false
	}
	return stored, stored != nil
}

// readStoredRow reads the vector_service SystemSetting row.
func (v *vectorSearcher) readStoredRow(ctx context.Context) (*vectorServiceStoredSettings, bool, error) {
	if v.options.DB == nil {
		return nil, false, errors.New("database is not configured")
	}
	readCtx, cancel := context.WithTimeout(ctx, vectorServiceSettingsReadTimeout)
	defer cancel()
	var raw []byte
	err := v.options.DB.QueryRowContext(readCtx,
		"SELECT `value` FROM `SystemSetting` WHERE `key` = ? LIMIT 1", vectorServiceSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var stored vectorServiceStoredSettings
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, true, nil
	}
	return &stored, true, nil
}

// warnIncompleteOnce logs at most once a minute.
func (v *vectorSearcher) warnIncompleteOnce() {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	if now.Sub(v.lastIncompleteWarn) < time.Minute {
		return
	}
	v.lastIncompleteWarn = now
	log.Printf("newseventsingest: vector service enabled but configuration is incomplete")
}

// isTemporarilyUnavailable reports the process-local disable window.
func (v *vectorSearcher) isTemporarilyUnavailable() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.now().Before(v.unavailableUntil)
}

// markAvailable clears the failure streak.
func (v *vectorSearcher) markAvailable() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.consecutiveFailures = 0
	v.unavailableUntil = time.Time{}
}

// markUnavailable extends the process-local disable window. A 401/403 doubles the
// minimum window and a bad payload keeps at least one minute, exactly like
// VectorClientService.markUnavailable.
func (v *vectorSearcher) markUnavailable(err error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	v.consecutiveFailures++
	if v.consecutiveFailures > 10 {
		v.consecutiveFailures = 10
	}
	exponent := v.consecutiveFailures - 1
	if exponent < 0 {
		exponent = 0
	}
	backoff := math.Min(float64(vectorUnavailableBackoffCeiling), float64(time.Second)*math.Pow(2, float64(exponent)))
	if errors.Is(err, errVectorUnauthorized) {
		backoff = math.Max(backoff, float64(vectorUnauthorizedBackoff))
	}
	if errors.Is(err, errVectorBadResponse) {
		backoff = math.Max(backoff, float64(vectorBadResponseBackoff))
	}
	v.unavailableUntil = now.Add(time.Duration(backoff))
}

// refreshFingerprint resets the disable window when the connection changes,
// mirroring the client rebuild of VectorClientService.resolveClient.
func (v *vectorSearcher) refreshFingerprint(config VectorConfig) {
	sum := sha256.Sum256([]byte(config.Token))
	fingerprint := strings.Join([]string{
		config.BaseURL,
		config.Timeout.String(),
		itoa(config.MaxRetries),
		hex.EncodeToString(sum[:])[:16],
	}, "|")

	v.mu.Lock()
	defer v.mu.Unlock()
	if v.fingerprintSet && v.fingerprint == fingerprint {
		return
	}
	v.fingerprint = fingerprint
	v.fingerprintSet = true
	v.consecutiveFailures = 0
	v.unavailableUntil = time.Time{}
}

// jsonBoolean reads a stored JSON boolean (`typeof value === "boolean"`).
func jsonBoolean(raw json.RawMessage) (bool, bool) {
	switch strings.TrimSpace(string(raw)) {
	case "true":
		return true, true
	case "false":
		return false, true
	}
	return false, false
}

// jsPositiveInt mirrors asPositiveInt: `Number(value)` coercion, a finite value
// above zero, floored.
func jsPositiveInt(raw json.RawMessage) (int, bool) {
	value, ok := jsNumberCoercion(raw)
	if !ok || !isFinite(value) || value <= 0 {
		return 0, false
	}
	return int(math.Floor(value)), true
}

// jsNonNegativeInt mirrors asNonNegativeInt.
func jsNonNegativeInt(raw json.RawMessage) (int, bool) {
	value, ok := jsNumberCoercion(raw)
	if !ok || !isFinite(value) || value < 0 {
		return 0, false
	}
	return int(math.Floor(value)), true
}

// jsNumberCoercion mirrors `typeof value === "number" ? value : Number(value)`.
func jsNumberCoercion(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return 0, false
	}
	if value, _, ok := jsonNumber(trimmed); ok {
		return value, true
	}
	if text, ok := jsonString(trimmed); ok {
		parsed, err := strconvParseFloat(jsTrim(text))
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	// Number(true) is 1 and Number(false) is 0.
	if value, ok := jsonBoolean(trimmed); ok {
		if value {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}
