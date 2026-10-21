package vectorclient

// This file implements the read-side Searcher port declared in search.go. It
// ports VectorClientService.searchBestEffort plus the pieces of
// VectorServiceSettingsService and VectorClient it depends on:
//
//   - effective configuration resolution: the SystemSetting row keyed
//     "vector_service" (Redis cache "vector_service:settings", 30 s TTL,
//     {exists,value} envelope) overlaying the VECTOR_SERVICE_* environment
//     defaults, including the encrypted-token branch;
//   - POST {baseURL}/v1/search with content-type application/json, the
//     x-internal-token header and the optional x-trace-id header;
//   - the VectorClient retry policy: transport failures and 5xx are retried with
//     jittered exponential backoff, 401/403 and non-2xx/bad payloads are final;
//   - the VectorClientService process-local "temporarily unavailable" window;
//   - the VectorSearchResponseSchema validation (collection non-empty, matches
//     optional-defaulting-to-empty, each id non-empty, the score finite and
//     createdAtMs a non-negative integer).
//
// The NestJS searchBestEffort contract returns null when the service is
// unavailable; the Go port returns a non-nil error instead and keeps a nil error
// with an empty slice for "the search ran and found nothing".

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
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

// Vector-service storage keys and client defaults mirrored from
// VectorServiceSettingsService, VectorClient and the NestJS env schema.
const (
	// searchVectorServiceSettingKey is the SystemSetting row key.
	searchVectorServiceSettingKey = "vector_service"
	// searchVectorServiceSettingsCacheKey is that row's Redis cache key.
	searchVectorServiceSettingsCacheKey = "vector_service:settings"
	// searchVectorServiceSettingsCacheTTLSeconds is the cache TTL.
	searchVectorServiceSettingsCacheTTLSeconds = 30
	// searchSettingsReadTimeout bounds one MySQL settings read.
	searchSettingsReadTimeout = 2 * time.Second
	// searchDefaultTimeoutMs is VECTOR_SERVICE_TIMEOUT_MS's default.
	searchDefaultTimeoutMs = 5_000
	// searchDefaultMaxRetries is VECTOR_SERVICE_MAX_RETRIES's default.
	searchDefaultMaxRetries = 2
	// searchMaxRetriesCeiling is a defensive retry-count ceiling. The env schema
	// puts no ceiling on the value; without one a pathological setting could
	// turn one search into a busy retry loop.
	searchMaxRetriesCeiling = 10
	// searchRetryBaseDelay is VectorClient's computeBackoffDelay base.
	searchRetryBaseDelay = 200 * time.Millisecond
	// searchResponseBodyLimit caps one response body read.
	searchResponseBodyLimit = 1 << 20
	// searchUnavailableBackoffCeiling caps the process-local disable window.
	searchUnavailableBackoffCeiling = 60 * time.Second
	// searchUnauthorizedBackoff is the minimum disable window after 401/403.
	searchUnauthorizedBackoff = 5 * time.Minute
	// searchBadResponseBackoff is the minimum disable window after a bad payload.
	searchBadResponseBackoff = 60 * time.Second
	// searchIncompleteWarnInterval rate-limits the incomplete-config warning.
	searchIncompleteWarnInterval = time.Minute
	// searchTraceHeader is the optional distributed trace header.
	searchTraceHeader = "x-trace-id"
)

// NestJS error class names carried by the returned errors.
const (
	searchErrorUnavailable  = "VectorServiceUnavailableError"
	searchErrorUnauthorized = "VectorUnauthorizedError"
	searchErrorBadResponse  = "VectorBadResponseError"
)

// maxSafeInteger is Number.MAX_SAFE_INTEGER, the largest integer a JavaScript
// number represents exactly; createdAtMs is checked against it before the int64
// conversion.
const maxSafeInteger = 9_007_199_254_740_991

// SearchClient is the concrete vector-go search client. It satisfies the
// Searcher port.
type SearchClient struct {
	options SearcherOptions
	http    *http.Client
	now     func() time.Time
	random  func() float64
	// sleep is injectable for tests; a nil value uses a context-aware timer.
	sleep func(context.Context, time.Duration) error
	// settingsLoader is injectable for tests; when set it replaces the Redis +
	// MySQL settings read.
	settingsLoader func(context.Context) (*storedSearchSettings, bool)

	mu                  sync.Mutex
	consecutiveFailures int
	unavailableUntil    time.Time
	lastIncompleteWarn  time.Time
	fingerprint         string
	fingerprintSet      bool
}

// Compile-time assertion that the concrete client satisfies the port.
var _ Searcher = (*SearchClient)(nil)

// NewSearcher builds the vector-go search client. The zero value of
// SearcherEnv.TimeoutMS falls back to 5000 ms and a negative MaxRetries falls
// back to 2, the VECTOR_SERVICE_* defaults; any non-negative MaxRetries is used
// as-is (0 means a single attempt) and capped defensively.
func NewSearcher(options SearcherOptions) *SearchClient {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	random := options.Random
	if random == nil {
		random = rand.Float64
	}
	if options.Env.TimeoutMS <= 0 {
		options.Env.TimeoutMS = searchDefaultTimeoutMs
	}
	if options.Env.MaxRetries < 0 {
		options.Env.MaxRetries = searchDefaultMaxRetries
	}
	if options.Env.MaxRetries > searchMaxRetriesCeiling {
		options.Env.MaxRetries = searchMaxRetriesCeiling
	}
	options.Env.BaseURL = strings.TrimRight(strings.TrimSpace(options.Env.BaseURL), "/")
	options.Env.Token = strings.TrimSpace(options.Env.Token)
	return &SearchClient{options: options, http: &http.Client{}, now: now, random: random}
}

// searchConfig is the effective vector-service configuration.
type searchConfig struct {
	Enabled         bool
	FallbackToMongo bool
	BaseURL         string
	Token           string
	TimeoutMS       int
	MaxRetries      int
}

// storedSearchSettings is the vector_service row projection. Every member stays
// raw because the NestJS coercion discriminates on the stored runtime type.
type storedSearchSettings struct {
	Enabled         json.RawMessage `json:"enabled"`
	FallbackToMongo json.RawMessage `json:"fallbackToMongo"`
	BaseURL         json.RawMessage `json:"baseUrl"`
	Token           json.RawMessage `json:"token"`
	TimeoutMS       json.RawMessage `json:"timeoutMs"`
	MaxRetries      json.RawMessage `json:"maxRetries"`
}

// cachedSearchSettings is the {exists,value} Redis envelope written by
// VectorServiceSettingsService.
type cachedSearchSettings struct {
	Exists bool                  `json:"exists"`
	Value  *storedSearchSettings `json:"value"`
}

// searchRequestBody is the POST /v1/search body. The dedupe caller always sends
// limit, minScore and lookbackMs; the optional members are omitted only when the
// caller passes nil, which mirrors an omitted (undefined) NestJS member.
type searchRequestBody struct {
	OrgID          string    `json:"orgId"`
	EmbeddingModel string    `json:"embeddingModel"`
	Vector         []float64 `json:"vector"`
	Limit          int       `json:"limit"`
	MinScore       *float64  `json:"minScore,omitempty"`
	LookbackMS     *int64    `json:"lookbackMs,omitempty"`
}

// searchResponsePayload is the vector-go success payload. Matches stays raw so
// an omitted member (zod `.default([])`) is distinguished from an explicit null
// (which fails the array schema).
type searchResponsePayload struct {
	Collection string          `json:"collection"`
	Matches    json.RawMessage `json:"matches"`
}

// searchMatchPayload is one raw hit. CreatedAtMS stays raw so a non-integer or
// negative value can be rejected the way z.number().int().nonnegative() does.
type searchMatchPayload struct {
	ProcessedItemID string `json:"processedItemId"`
	ItemMetaID      string `json:"itemMetaId"`
	// Score and CreatedAtMS stay raw because the NestJS zod schema requires
	// both members and a missing member must be rejected, which a plain
	// float64/int64 zero value cannot distinguish.
	Score       json.RawMessage `json:"score"`
	CreatedAtMS json.RawMessage `json:"createdAtMs"`
}

// searchAttemptError is one classified attempt failure. It carries the NestJS
// error class name so callers can classify the failure, plus the retry decision
// of VectorClient.requestWithRetry.
type searchAttemptError struct {
	kind         string
	retryable    bool
	unauthorized bool
	badResponse  bool
	message      string
	cause        error
}

// Error implements error.
func (e *searchAttemptError) Error() string {
	if e == nil {
		return ""
	}
	if e.message != "" {
		if e.cause != nil {
			return e.message + ": " + e.cause.Error()
		}
		return e.message
	}
	if e.cause != nil {
		return e.cause.Error()
	}
	return e.kind
}

// Unwrap exposes the transport cause.
func (e *searchAttemptError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// Name returns the NestJS-compatible error class name.
func (e *searchAttemptError) Name() string {
	if e == nil {
		return ""
	}
	return e.kind
}

// SearchBestEffort implements Searcher. A nil error with an empty slice means
// the search ran and found nothing; a non-nil error means the vector service is
// unavailable (the NestJS null result) and the caller must apply its Mongo
// fallback rules.
func (s *SearchClient) SearchBestEffort(ctx context.Context, request SearchRequest) ([]SearchMatch, error) {
	if s == nil {
		return nil, &searchAttemptError{kind: searchErrorUnavailable, message: "Vector service is unavailable"}
	}
	config := s.resolveConfig(ctx)
	if !config.Enabled {
		return nil, &searchAttemptError{kind: searchErrorUnavailable, message: "Vector service is disabled"}
	}
	if config.BaseURL == "" || config.Token == "" {
		s.warnIncompleteOnce()
		return nil, &searchAttemptError{kind: searchErrorUnavailable, message: "Vector service enabled but configuration is incomplete"}
	}
	s.refreshFingerprint(config)
	if s.isTemporarilyUnavailable() {
		return nil, &searchAttemptError{kind: searchErrorUnavailable, message: "Vector service is temporarily unavailable"}
	}

	body, err := json.Marshal(searchRequestBody{
		OrgID:          request.OrgID,
		EmbeddingModel: request.EmbeddingModel,
		Vector:         request.Vector,
		Limit:          request.Limit,
		MinScore:       request.MinScore,
		LookbackMS:     request.LookbackMS,
	})
	if err != nil {
		return nil, &searchAttemptError{
			kind:    searchErrorBadResponse,
			message: "Vector search request could not be encoded",
			cause:   err,
		}
	}

	timeout := time.Duration(config.TimeoutMS) * time.Millisecond
	attempts := config.MaxRetries + 1
	if attempts < 1 {
		attempts = 1
	}
	var lastErr *searchAttemptError
	for attempt := 1; attempt <= attempts; attempt++ {
		matches, failure := s.searchOnce(ctx, config, request.TraceID, body, timeout)
		if failure == nil {
			s.markAvailable()
			if matches == nil {
				matches = []SearchMatch{}
			}
			return matches, nil
		}
		lastErr = failure
		if !failure.retryable || attempt >= attempts {
			s.markUnavailable(failure)
			return nil, failure
		}
		if err := s.sleepContext(ctx, s.backoff(attempt)); err != nil {
			return nil, &searchAttemptError{
				kind:    searchErrorUnavailable,
				message: "Vector request failed",
				cause:   err,
			}
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, &searchAttemptError{kind: searchErrorUnavailable, message: "Vector request failed"}
}

// searchOnce performs one HTTP attempt with its own per-attempt timeout.
func (s *SearchClient) searchOnce(ctx context.Context, config searchConfig, traceID string, body []byte, timeout time.Duration) ([]SearchMatch, *searchAttemptError) {
	attemptCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := config.BaseURL + "/v1/search"
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &searchAttemptError{kind: searchErrorUnavailable, message: "Vector request failed", cause: err}
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-internal-token", config.Token)
	if traceID != "" {
		request.Header.Set(searchTraceHeader, traceID)
	}

	response, err := s.http.Do(request)
	if err != nil {
		return nil, &searchAttemptError{kind: searchErrorUnavailable, retryable: true, message: "Vector request failed", cause: err}
	}
	defer func() { _ = response.Body.Close() }()

	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return nil, &searchAttemptError{kind: searchErrorUnauthorized, unauthorized: true, message: "Vector service authentication failed"}
	case response.StatusCode >= 500:
		return nil, &searchAttemptError{kind: searchErrorUnavailable, retryable: true, message: "Vector service returned " + strconv.Itoa(response.StatusCode)}
	case response.StatusCode < 200 || response.StatusCode >= 300:
		text, _ := io.ReadAll(io.LimitReader(response.Body, 300))
		return nil, &searchAttemptError{
			kind:        searchErrorBadResponse,
			badResponse: true,
			message:     "Vector service returned " + strconv.Itoa(response.StatusCode) + ": " + string(text),
		}
	}

	raw, err := io.ReadAll(io.LimitReader(response.Body, searchResponseBodyLimit))
	if err != nil {
		return nil, &searchAttemptError{kind: searchErrorBadResponse, badResponse: true, message: "Vector search returned invalid payload", cause: err}
	}
	matches, err := decodeSearchResponse(raw)
	if err != nil {
		return nil, &searchAttemptError{kind: searchErrorBadResponse, badResponse: true, message: "Vector search returned invalid payload", cause: err}
	}
	return matches, nil
}

// decodeSearchResponse validates the payload against VectorSearchResponseSchema.
// A missing matches member is a valid empty result.
func decodeSearchResponse(raw []byte) ([]SearchMatch, error) {
	var decoded searchResponsePayload
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	if decoded.Collection == "" {
		return nil, errors.New("missing collection")
	}
	trimmedMatches := bytes.TrimSpace(decoded.Matches)
	if len(trimmedMatches) == 0 {
		return []SearchMatch{}, nil
	}
	if string(trimmedMatches) == "null" {
		return nil, errors.New("matches is null")
	}
	var rawMatches []searchMatchPayload
	if err := json.Unmarshal(trimmedMatches, &rawMatches); err != nil {
		return nil, err
	}
	matches := make([]SearchMatch, 0, len(rawMatches))
	for _, match := range rawMatches {
		if strings.TrimSpace(match.ProcessedItemID) == "" {
			return nil, errors.New("missing processedItemId")
		}
		if strings.TrimSpace(match.ItemMetaID) == "" {
			return nil, errors.New("missing itemMetaId")
		}
		if len(bytes.TrimSpace(match.Score)) == 0 || string(bytes.TrimSpace(match.Score)) == "null" {
			return nil, errors.New("missing score")
		}
		var score float64
		if err := json.Unmarshal(match.Score, &score); err != nil {
			return nil, errors.New("score is not a number")
		}
		if math.IsNaN(score) || math.IsInf(score, 0) {
			return nil, errors.New("score is not finite")
		}
		createdAtMS, err := searchDecodeNonNegativeInteger(match.CreatedAtMS)
		if err != nil {
			return nil, err
		}
		matches = append(matches, SearchMatch{
			ProcessedItemID: match.ProcessedItemID,
			ItemMetaID:      match.ItemMetaID,
			CreatedAtMS:     createdAtMS,
			Score:           score,
		})
	}
	return matches, nil
}

// searchDecodeNonNegativeInteger validates z.number().int().nonnegative().
func searchDecodeNonNegativeInteger(raw json.RawMessage) (int64, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, errors.New("missing createdAtMs")
	}
	if string(trimmed) == "null" {
		return 0, errors.New("createdAtMs is not a number")
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, errors.New("createdAtMs is not a number")
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value {
		return 0, errors.New("createdAtMs is not an integer")
	}
	if value < 0 || value > maxSafeInteger {
		return 0, errors.New("createdAtMs is out of range")
	}
	return int64(value), nil
}

// resolveConfig mirrors VectorClientService.resolveClient's effective
// configuration: the stored row overlays the environment defaults member by
// member, with a wrong stored type falling back to the environment default.
func (s *SearchClient) resolveConfig(ctx context.Context) searchConfig {
	config := s.envDefaults()
	stored, present := s.loadStoredSettings(ctx)
	if !present || stored == nil {
		return config
	}
	if value, ok := searchJSONBoolean(stored.Enabled); ok {
		config.Enabled = value
	}
	if value, ok := searchJSONBoolean(stored.FallbackToMongo); ok {
		config.FallbackToMongo = value
	}
	if text, ok := searchJSONString(stored.BaseURL); ok {
		if normalized := strings.TrimRight(strings.TrimSpace(text), "/"); normalized != "" {
			config.BaseURL = normalized
		}
	}
	if value, ok := searchJSONPositiveInt(stored.TimeoutMS); ok {
		config.TimeoutMS = value
	}
	if value, ok := searchJSONNonNegativeInt(stored.MaxRetries); ok {
		config.MaxRetries = value
	}
	if token, ok := modelaccesssettings.DecodeStoredSettingsSecret(stored.Token, s.options.Env.EncryptionKey); ok {
		config.Token = token
	}
	if config.MaxRetries > searchMaxRetriesCeiling {
		config.MaxRetries = searchMaxRetriesCeiling
	}
	return config
}

// FallbackToMongoEnabled ports VectorClientService.fallbackToMongoEnabled: the
// stored fallbackToMongo override over the VECTOR_SERVICE_FALLBACK_TO_MONGO env
// default. The dedupe stage type-asserts the port to this method when deciding
// whether an empty or unavailable vector result may fall back to Mongo.
func (s *SearchClient) FallbackToMongoEnabled(ctx context.Context) bool {
	if s == nil {
		return false
	}
	return s.resolveConfig(ctx).FallbackToMongo
}

// envDefaults projects the VECTOR_SERVICE_* environment defaults.
func (s *SearchClient) envDefaults() searchConfig {
	return searchConfig{
		Enabled:         s.options.Env.Enabled,
		FallbackToMongo: s.options.Env.FallbackToMongo,
		BaseURL:         s.options.Env.BaseURL,
		Token:           s.options.Env.Token,
		TimeoutMS:       s.options.Env.TimeoutMS,
		MaxRetries:      s.options.Env.MaxRetries,
	}
}

// loadStoredSettings mirrors VectorServiceSettingsService.loadStoredSettings:
// the Redis envelope first, then MySQL with a best-effort cache fill. A read
// failure is logged and treated as "no stored row", so a settings outage
// degrades to the environment defaults.
func (s *SearchClient) loadStoredSettings(ctx context.Context) (*storedSearchSettings, bool) {
	if s.settingsLoader != nil {
		return s.settingsLoader(ctx)
	}
	if s.options.Redis != nil {
		if raw, err := s.options.Redis.Get(ctx, searchVectorServiceSettingsCacheKey).Bytes(); err == nil && len(raw) > 0 {
			if stored, present, ok := searchDecodeCachedSettings(raw); ok {
				return stored, present
			}
		}
	}

	stored, exists, err := s.readStoredRow(ctx)
	if err != nil {
		log.Printf("vectorclient: vector settings read failed: %v", err)
		return nil, false
	}
	if s.options.Redis != nil {
		if payload, marshalErr := json.Marshal(cachedSearchSettings{Exists: exists, Value: stored}); marshalErr == nil {
			_ = s.options.Redis.Set(ctx, searchVectorServiceSettingsCacheKey, payload,
				time.Duration(searchVectorServiceSettingsCacheTTLSeconds)*time.Second).Err()
		}
	}
	if !exists {
		return nil, false
	}
	return stored, stored != nil
}

// readStoredRow reads the vector_service SystemSetting row.
func (s *SearchClient) readStoredRow(ctx context.Context) (*storedSearchSettings, bool, error) {
	if s.options.DB == nil {
		return nil, false, errors.New("database is not configured")
	}
	readCtx, cancel := context.WithTimeout(ctx, searchSettingsReadTimeout)
	defer cancel()
	var raw []byte
	err := s.options.DB.QueryRowContext(readCtx,
		"SELECT `value` FROM `SystemSetting` WHERE `key` = ? LIMIT 1", searchVectorServiceSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return searchDecodeStoredRow(raw), true, nil
}

// searchDecodeStoredRow decodes one SystemSetting value. A non-object value is
// kept as "the row exists but carries no usable settings", which makes the
// environment defaults apply member by member, exactly like the NestJS
// `raw && typeof raw === "object"` guard.
func searchDecodeStoredRow(raw []byte) *storedSearchSettings {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	var stored storedSearchSettings
	if err := json.Unmarshal(trimmed, &stored); err != nil {
		return nil
	}
	return &stored
}

// searchDecodeCachedSettings decodes the {exists,value} Redis envelope.
// present reports whether a stored row was found; ok is false when the envelope
// itself is unreadable, in which case the caller falls through to MySQL.
func searchDecodeCachedSettings(raw []byte) (stored *storedSearchSettings, present bool, ok bool) {
	var cached cachedSearchSettings
	if err := json.Unmarshal(raw, &cached); err != nil {
		return nil, false, false
	}
	if !cached.Exists {
		return nil, false, true
	}
	return cached.Value, cached.Value != nil, true
}

// backoff ports VectorClient.computeBackoffDelay(200, attempt):
// round(200ms * 2^(attempt-1) * (0.5 + random)).
func (s *SearchClient) backoff(attempt int) time.Duration {
	exponent := attempt - 1
	if exponent < 0 {
		exponent = 0
	}
	exponential := float64(searchRetryBaseDelay) * math.Pow(2, float64(exponent))
	return time.Duration(math.Round(exponential * (0.5 + s.random())))
}

// sleepContext waits unless a test injected a no-op sleep.
func (s *SearchClient) sleepContext(ctx context.Context, delay time.Duration) error {
	if s.sleep != nil {
		return s.sleep(ctx, delay)
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

// isTemporarilyUnavailable reports the process-local disable window.
func (s *SearchClient) isTemporarilyUnavailable() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now().Before(s.unavailableUntil)
}

// markAvailable clears the failure streak.
func (s *SearchClient) markAvailable() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.consecutiveFailures = 0
	s.unavailableUntil = time.Time{}
}

// markUnavailable extends the process-local disable window. A 401/403 keeps at
// least five minutes and a bad payload at least one minute, exactly like
// VectorClientService.markUnavailable.
func (s *SearchClient) markUnavailable(failure *searchAttemptError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	wasAvailable := !now.Before(s.unavailableUntil)

	s.consecutiveFailures++
	if s.consecutiveFailures > 10 {
		s.consecutiveFailures = 10
	}
	exponent := s.consecutiveFailures - 1
	if exponent < 0 {
		exponent = 0
	}
	backoff := math.Min(float64(searchUnavailableBackoffCeiling),
		float64(time.Second)*math.Pow(2, float64(exponent)))
	if failure != nil && failure.unauthorized {
		backoff = math.Max(backoff, float64(searchUnauthorizedBackoff))
	}
	if failure != nil && failure.badResponse {
		backoff = math.Max(backoff, float64(searchBadResponseBackoff))
	}
	s.unavailableUntil = now.Add(time.Duration(backoff))
	if wasAvailable {
		log.Printf("vectorclient: vector request failed; temporarily disabling vector service for %s (consecutive failures: %d)",
			time.Duration(backoff).String(), s.consecutiveFailures)
	}
}

// refreshFingerprint resets the disable window when the connection changes,
// mirroring the client rebuild of VectorClientService.resolveClient.
func (s *SearchClient) refreshFingerprint(config searchConfig) {
	sum := sha256.Sum256([]byte(config.Token))
	fingerprint := strings.Join([]string{
		config.BaseURL,
		strconv.Itoa(config.TimeoutMS),
		strconv.Itoa(config.MaxRetries),
		hex.EncodeToString(sum[:])[:16],
	}, "|")

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fingerprintSet && s.fingerprint == fingerprint {
		return
	}
	s.fingerprint = fingerprint
	s.fingerprintSet = true
	s.consecutiveFailures = 0
	s.unavailableUntil = time.Time{}
}

// warnIncompleteOnce logs at most once a minute.
func (s *SearchClient) warnIncompleteOnce() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if !s.lastIncompleteWarn.IsZero() && now.Sub(s.lastIncompleteWarn) < searchIncompleteWarnInterval {
		return
	}
	s.lastIncompleteWarn = now
	log.Printf("vectorclient: vector service enabled but configuration is incomplete")
}

// searchJSONBoolean reads a stored JSON boolean (`typeof value === "boolean"`).
func searchJSONBoolean(raw json.RawMessage) (bool, bool) {
	switch strings.TrimSpace(string(raw)) {
	case "true":
		return true, true
	case "false":
		return false, true
	}
	return false, false
}

// searchJSONString reads a stored JSON string (`typeof value === "string"`).
func searchJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return "", false
	}
	return value, true
}

// searchJSONPositiveInt mirrors asPositiveInt: `typeof value === "number" ?
// value : Number(value)`, finite and above zero, floored.
func searchJSONPositiveInt(raw json.RawMessage) (int, bool) {
	value, ok := searchJSONNumberCoercion(raw)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0, false
	}
	return int(math.Floor(value)), true
}

// searchJSONNonNegativeInt mirrors asNonNegativeInt.
func searchJSONNonNegativeInt(raw json.RawMessage) (int, bool) {
	value, ok := searchJSONNumberCoercion(raw)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false
	}
	return int(math.Floor(value)), true
}

// searchJSONNumberCoercion mirrors `typeof value === "number" ? value :
// Number(value)`: a JSON number is used directly, a JSON string, boolean or null
// goes through the JavaScript Number() coercion, and an absent member is
// undefined (NaN, i.e. not usable).
func searchJSONNumberCoercion(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch string(trimmed) {
	case "null":
		// Number(null) is 0.
		return 0, true
	case "true":
		// Number(true) is 1.
		return 1, true
	case "false":
		// Number(false) is 0.
		return 0, true
	}
	if trimmed[0] == '"' {
		text, ok := searchJSONString(trimmed)
		if !ok {
			return 0, false
		}
		normalized := strings.TrimSpace(text)
		if normalized == "" {
			// Number("") is 0.
			return 0, true
		}
		parsed, err := strconv.ParseFloat(normalized, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	var value float64
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0, false
	}
	return value, true
}
