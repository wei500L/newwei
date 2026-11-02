package itemsreading

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// Vector service defaults and storage keys mirrored from the NestJS env schema
// and from VectorServiceSettingsService.
const (
	// vectorServiceTimeoutDefaultMs is VECTOR_SERVICE_TIMEOUT_MS's default.
	vectorServiceTimeoutDefaultMs = 5000
	// vectorServiceMaxRetriesDefault is VECTOR_SERVICE_MAX_RETRIES's default.
	vectorServiceMaxRetriesDefault = 2
	// vectorServiceMaxRetriesCeiling is the defensive retry-count ceiling.
	vectorServiceMaxRetriesCeiling = 10
	// vectorServiceRetryBaseDelay is the retry backoff base (the NestJS
	// computeBackoffDelay base).
	vectorServiceRetryBaseDelay = 200 * time.Millisecond
	// vectorServiceResponseBodyLimit caps how much of one response is read.
	vectorServiceResponseBodyLimit = 1 << 20
	// vectorServiceSettingKey is the SystemSetting row that overrides the env
	// default for the vector integration.
	vectorServiceSettingKey = "vector_service"
	// vectorServiceSettingsCacheKey is that row's Redis cache key.
	vectorServiceSettingsCacheKey = "vector_service:settings"
	// vectorServiceSettingsCacheTTLSeconds is that row's cache TTL.
	vectorServiceSettingsCacheTTLSeconds = 30
	// vectorServiceSettingsReadTimeout bounds one settings read.
	vectorServiceSettingsReadTimeout = 2 * time.Second
	// vectorUnavailableIndexMessage mirrors the NestJS hard-fail message for a
	// failed vector index query.
	vectorUnavailableIndexMessage = "Vector search unavailable: failed to query vector index."
	// vectorUnavailableFallbackMessage mirrors the NestJS hard-fail message when
	// the local fallback is refused.
	vectorUnavailableFallbackMessage = "Vector search unavailable: local fallback disabled."
	// vectorSearchMinInputTokens is the token floor that still triggers a
	// recall when the input is long enough.
	vectorSearchMinInputTokens = 2
	// vectorSearchMinInputChars is the character floor for a short input.
	vectorSearchMinInputChars = 16
)

// Sentinel failures of one vector-go HTTP attempt. They only decide whether the
// attempt is retried; callers never see them.
var (
	errVectorUnauthorized = errors.New("vector service authentication failed")
	errVectorUnavailable  = errors.New("vector service unavailable")
	errVectorBadResponse  = errors.New("vector service returned an invalid payload")
)

// sha256HexDigits is the lowercase hex alphabet used by sha256Hex.
const sha256HexDigits = "0123456789abcdef"

// VectorSearchMatch is one vector-go search hit. It is the Go port of the
// VectorSearchMatch interface of @modular/vector-client.
type VectorSearchMatch struct {
	// ProcessedItemID is the Mongo _id of the matched ProcessedItem.
	ProcessedItemID string `json:"processedItemId"`
	// ItemMetaID is the organization-scoped MySQL item id.
	ItemMetaID string `json:"itemMetaId"`
	// Score is the similarity reported by the vector service.
	Score float64 `json:"score"`
	// CreatedAtMs is the candidate's creation time in epoch milliseconds.
	CreatedAtMs int64 `json:"createdAtMs"`
}

// VectorSearchRequest is the POST {base}/v1/search body. It mirrors
// VectorSearchRequest of @modular/vector-client; this gateway always sends all
// six members, exactly like resolveVectorSearchIds does.
type VectorSearchRequest struct {
	// OrgID binds the search to one organization.
	OrgID string `json:"orgId"`
	// EmbeddingModel is the model that produced Vector.
	EmbeddingModel string `json:"embeddingModel"`
	// Vector is the query embedding.
	Vector []float64 `json:"vector"`
	// Limit caps the returned matches.
	Limit int `json:"limit"`
	// MinScore is the similarity floor.
	MinScore float64 `json:"minScore"`
	// LookbackMs is the candidate age window in milliseconds.
	LookbackMs int64 `json:"lookbackMs"`
}

// VectorSearchResponse is the vector-go search payload. Collection is the
// non-empty marker that separates a valid response from a bad payload; a
// missing matches member is a valid empty result.
type VectorSearchResponse struct {
	// Collection is the non-empty collection name the service searched.
	Collection string `json:"collection"`
	// Matches are the ranked hits; nil means the service omitted the member.
	Matches []VectorSearchMatch `json:"matches"`
}

// vectorSearcher talks to the vector-go service over HTTP. It is the Go port of
// VectorClientService.searchBestEffort plus the VectorClient retry policy. The
// db and redis handles are attached by newVectorRecall so FallbackToMongo can
// read the DB-stored override.
type vectorSearcher struct {
	// baseURL is VECTOR_SERVICE_BASE_URL with a trailing slash removed.
	baseURL string
	// token is the VECTOR_INTERNAL_TOKEN sent as x-internal-token.
	token string
	// client is the shared HTTP client with the per-attempt timeout applied.
	client *http.Client
	// maxRetries is the number of retries after the first attempt.
	maxRetries int
	// fallbackToMongo is the VECTOR_SERVICE_FALLBACK_TO_MONGO env default.
	fallbackToMongo bool
	// db is the MySQL pool used for the vector_service SystemSetting row.
	db *sql.DB
	// redis is the shared Redis client used for the settings cache.
	redis *redis.Client
}

// newVectorSearcherFromEnv returns nil when VECTOR_SERVICE_ENABLED is falsy or
// VECTOR_SERVICE_BASE_URL / VECTOR_INTERNAL_TOKEN are blank. Env:
// VECTOR_SERVICE_TIMEOUT_MS (default 5000), VECTOR_SERVICE_MAX_RETRIES
// (default 2), VECTOR_SERVICE_FALLBACK_TO_MONGO (default true) ->
// FallbackToMongo().
func newVectorSearcherFromEnv() *vectorSearcher {
	if !envTruthy(os.Getenv("VECTOR_SERVICE_ENABLED")) {
		return nil
	}
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("VECTOR_SERVICE_BASE_URL")), "/")
	token := strings.TrimSpace(os.Getenv("VECTOR_INTERNAL_TOKEN"))
	if baseURL == "" || token == "" {
		return nil
	}
	timeoutMs := vectorServiceTimeoutDefaultMs
	if raw := strings.TrimSpace(os.Getenv("VECTOR_SERVICE_TIMEOUT_MS")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			timeoutMs = value
		}
	}
	maxRetries := vectorServiceMaxRetriesDefault
	if raw := strings.TrimSpace(os.Getenv("VECTOR_SERVICE_MAX_RETRIES")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 0 {
			maxRetries = value
		}
	}
	// The env schema puts no ceiling on the retry count; cap it defensively so a
	// pathological value cannot turn the recall into a busy retry loop.
	if maxRetries > vectorServiceMaxRetriesCeiling {
		maxRetries = vectorServiceMaxRetriesCeiling
	}
	fallbackToMongo := true
	if raw := strings.TrimSpace(os.Getenv("VECTOR_SERVICE_FALLBACK_TO_MONGO")); raw != "" {
		fallbackToMongo = envTruthy(raw)
	}
	return &vectorSearcher{
		baseURL:         baseURL,
		token:           token,
		client:          &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond},
		maxRetries:      maxRetries,
		fallbackToMongo: fallbackToMongo,
	}
}

// FallbackToMongo reports the fallbackToMongo flag. The DB-stored setting in the
// SystemSetting row keyed "vector_service" (cached in Redis at
// "vector_service:settings", TTL 30, {exists,value} shape) takes precedence over
// the VECTOR_SERVICE_FALLBACK_TO_MONGO env default; a missing row, an
// unreadable row or a row without a boolean fallbackToMongo falls back to the
// env default, exactly like VectorServiceSettingsService.getEffectiveConfig.
func (v *vectorSearcher) FallbackToMongo() bool {
	if v == nil {
		return false
	}
	if stored, ok := loadStoredFallbackToMongo(v.db, v.redis); ok {
		return stored
	}
	return v.fallbackToMongo
}

// SearchBestEffort ports VectorClientService.searchBestEffort: POST
// {base}/v1/search with content-type application/json and an x-internal-token
// header, body {orgId,embeddingModel,vector,limit,minScore,lookbackMs}. It
// returns (matches, true) on a 2xx response whose payload has a non-empty
// `collection` (a missing `matches` member means empty), and (nil, false) for
// "infrastructure unavailable" (nil client, timeout, non-2xx, bad payload) —
// callers rely on the nil-and-false versus empty-and-true distinction.
//
// Retries follow VectorClient: transport failures and 5xx responses are retried
// up to maxRetries times, while 401/403, other non-2xx statuses and malformed
// payloads fail immediately. The NestJS jittered backoff is replaced by a
// deterministic 200ms * 2^(attempt-1) delay so the package keeps its minimal
// import set; the retry count and the retryable failure set are identical.
func (v *vectorSearcher) SearchBestEffort(ctx context.Context, req VectorSearchRequest) ([]VectorSearchMatch, bool) {
	if v == nil || v.client == nil || strings.TrimSpace(v.baseURL) == "" {
		return nil, false
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, false
	}
	attempts := v.maxRetries + 1
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		matches, retryable, attemptErr := v.searchOnce(ctx, body)
		if attemptErr == nil {
			return matches, true
		}
		if !retryable || attempt >= attempts {
			return nil, false
		}
		if sleepErr := sleepContext(ctx, vectorServiceRetryBaseDelay*time.Duration(1<<(attempt-1))); sleepErr != nil {
			return nil, false
		}
	}
	return nil, false
}

// searchOnce performs one HTTP attempt. retryable reports whether the failure
// belongs to the VectorClient retry set.
func (v *vectorSearcher) searchOnce(ctx context.Context, body []byte) ([]VectorSearchMatch, bool, error) {
	endpoint := v.baseURL + "/v1/search"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-internal-token", v.token)
	resp, err := v.client.Do(req)
	if err != nil {
		return nil, true, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, vectorServiceResponseBodyLimit))
	if err != nil {
		return nil, true, err
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, false, errVectorUnauthorized
	case resp.StatusCode >= 500:
		return nil, true, errVectorUnavailable
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return nil, false, errVectorBadResponse
	}
	var parsed VectorSearchResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, false, errVectorBadResponse
	}
	if strings.TrimSpace(parsed.Collection) == "" {
		return nil, false, errVectorBadResponse
	}
	if !validVectorMatches(parsed.Matches) {
		return nil, false, errVectorBadResponse
	}
	if parsed.Matches == nil {
		parsed.Matches = []VectorSearchMatch{}
	}
	return parsed.Matches, true, nil
}

// validVectorMatches mirrors the strict element validation of the
// VectorSearchResponseSchema zod schema: empty ids, non-finite scores and
// negative timestamps make the whole payload invalid.
func validVectorMatches(matches []VectorSearchMatch) bool {
	for _, match := range matches {
		if strings.TrimSpace(match.ProcessedItemID) == "" {
			return false
		}
		if strings.TrimSpace(match.ItemMetaID) == "" {
			return false
		}
		if !isFinite(match.Score) {
			return false
		}
		if match.CreatedAtMs < 0 {
			return false
		}
	}
	return true
}

// vectorRecall ports the items-search vector recall from
// items-search-query.service.ts `resolveVectorSearchIds`.
type vectorRecall struct {
	// searcher is the vector-go client; nil means the integration is disabled.
	searcher *vectorSearcher
	// mongo is the local cosine fallback source.
	mongo *mongoStore
	// cache is the distributed candidate cache.
	cache *redisCache
	// embedder resolves the embedding profile and embeds the query.
	embedder *llmembed.Client
	// hardFail mirrors ITEMS_VECTOR_HARD_FAIL_ENABLED.
	hardFail bool
	// db is the MySQL pool used for the vector_service SystemSetting row.
	db *sql.DB
	// redis is the shared Redis client used for the settings cache.
	redis *redis.Client
}

// newVectorRecall wires the vector recall. The same db and redisClient are
// attached to the searcher so FallbackToMongo can resolve the DB-stored
// override. A nil searcher means the vector integration is disabled and only
// the local fallback is available; a nil cache means every call runs the loader
// directly.
func newVectorRecall(searcher *vectorSearcher, mongo *mongoStore, cache *redisCache, embedder *llmembed.Client, hardFail bool, db *sql.DB, redisClient *redis.Client) *vectorRecall {
	if searcher != nil {
		searcher.db = db
		searcher.redis = redisClient
	}
	return &vectorRecall{
		searcher: searcher,
		mongo:    mongo,
		cache:    cache,
		embedder: embedder,
		hardFail: hardFail,
		db:       db,
		redis:    redisClient,
	}
}

// ItemVectorUnavailableError signals ITEMS_VECTOR_HARD_FAIL_ENABLED with an
// unavailable service. The GraphQL layer maps it to the NestJS
// VECTOR_SEARCH_UNAVAILABLE ServiceUnavailableException envelope.
type ItemVectorUnavailableError struct {
	// Message is the NestJS-style failure message.
	Message string
}

// Error implements error.
func (e *ItemVectorUnavailableError) Error() string {
	if e == nil || e.Message == "" {
		return "Vector search unavailable"
	}
	return e.Message
}

// RecallIDs returns the itemMetaId candidates in rank order. It ports
// resolveVectorSearchIds: the embedding model is resolved and the query
// embedded, a query with fewer than two tokens that is also shorter than 16
// characters is skipped, the loader is wrapped in the distributed cache with
// TTL 300s / lock 5000ms / retry 50ms / maxWait 2000ms, the vector service is
// asked for limit 300, minScore 0.78 and a 30 day lookback, and the local Mongo
// cosine scan runs when the matches are empty or the service is unavailable and
// fallbackToMongo is enabled. Every degraded path yields an empty slice unless
// hard-fail is on, in which case an unavailable service yields an
// *ItemVectorUnavailableError.
func (v *vectorRecall) RecallIDs(ctx context.Context, orgID string, search string) ([]string, error) {
	if v == nil || v.embedder == nil {
		return []string{}, nil
	}
	normalized := strings.TrimSpace(search)
	if normalized == "" {
		return []string{}, nil
	}
	tokens := TokenizeSearch(normalized, MongoMinTokenLength)
	if len(tokens) < vectorSearchMinInputTokens && len([]rune(normalized)) < vectorSearchMinInputChars {
		return []string{}, nil
	}
	key := vectorSearchCacheKey(orgID, strings.ToLower(normalized))
	loader := func(loaderCtx context.Context) (json.RawMessage, error) {
		return v.loadCandidateIDs(loaderCtx, orgID, normalized)
	}
	if v.cache == nil {
		return decodeCandidateResult(loader(ctx))
	}
	raw, err := v.cache.Wrap(ctx, key, VectorSearchCacheTTLSeconds, loader)
	if err != nil {
		// cache.wrap can fail for a cache reason (lock, Redis write) as well as
		// for a loader failure; NestJS logs and retries the loader directly.
		raw, err = loader(ctx)
	}
	return decodeCandidateResult(raw, err)
}

// decodeCandidateResult turns a loader outcome into the RecallIDs contract:
// hard-fail errors propagate, every other failure degrades to an empty slice.
//
// Every final loader failure records integration_events_total{integration=
// "vector", operation="items_vector_search", status="failure"}. That is the only
// vector call site NestJS instruments: the inner catch of resolveVectorSearchIds
// runs after the cache wrap and the direct loader retry have both failed, records
// the event and returns []. Hard-fail failures travel through the same catch in
// NestJS (the ServiceUnavailableException is thrown inside the loader), so they
// are counted here as well before this gateway surfaces its typed 503 error.
func decodeCandidateResult(raw json.RawMessage, err error) ([]string, error) {
	if err != nil {
		metrics.RecordVectorSearchFailure()
		var unavailable *ItemVectorUnavailableError
		if errors.As(err, &unavailable) {
			return nil, unavailable
		}
		return []string{}, nil
	}
	ids, ok := decodeIDList(raw)
	if !ok {
		return []string{}, nil
	}
	return ids, nil
}

// loadCandidateIDs is the cached loader: embed, ask the vector service, then
// fall back to the local Mongo cosine scan. It returns the JSON array of
// itemMetaIds that gets cached.
func (v *vectorRecall) loadCandidateIDs(ctx context.Context, orgID string, normalized string) (json.RawMessage, error) {
	// llmembed.Client.Embed resolves the active embedding profile and posts to
	// the same OpenAI-compatible /v1/embeddings endpoint as
	// liteLlm.embedding. The one protocol difference is that Embed always sends
	// `input` as a one-element array while NestJS sends the single string; every
	// embedding gateway accepts both forms, so reusing Embed avoids a second
	// embedding client and its profile-decryption path.
	vectors, model, err := v.embedder.Embed(ctx, orgID, []string{normalized})
	if err != nil {
		return nil, err
	}
	if len(vectors) == 0 || len(vectors[0]) == 0 {
		return emptyIDListJSON(), nil
	}
	embedding := vectors[0]
	model = strings.TrimSpace(model)
	if model == "" {
		return nil, errVectorUnavailable
	}
	lookbackMs := int64(VectorSearchLookbackDays) * int64(DayMs)
	if v.searcher != nil {
		matches, available := v.searcher.SearchBestEffort(ctx, VectorSearchRequest{
			OrgID:          orgID,
			EmbeddingModel: model,
			Vector:         embedding,
			Limit:          VectorSearchMaxResults,
			MinScore:       VectorSearchMinSimilarity,
			LookbackMs:     lookbackMs,
		})
		if available {
			if len(matches) > 0 {
				return encodeIDList(dedupeAndCapMatches(matches))
			}
			if !v.fallbackToMongo() {
				return emptyIDListJSON(), nil
			}
		} else {
			if v.hardFail {
				return nil, &ItemVectorUnavailableError{Message: vectorUnavailableIndexMessage}
			}
			if !v.fallbackToMongo() {
				return emptyIDListJSON(), nil
			}
		}
	}
	// Reaching this point means the vector client was not configured, the
	// matches were empty, or the service was unavailable while fallbackToMongo
	// was enabled. NestJS still refuses the local scan when hard-fail is on.
	if v.hardFail {
		return nil, &ItemVectorUnavailableError{Message: vectorUnavailableFallbackMessage}
	}
	return v.localCosineIDs(ctx, orgID, model, embedding, lookbackMs)
}

// fallbackToMongo reports whether the local cosine scan may run. A nil searcher
// never consults this flag: NestJS reaches the local scan without a
// fallbackToMongo check when no vector client is configured at all, which is
// why the caller tests it only inside the searcher branch. The recall's own db
// and Redis handles are preferred so the DB override still resolves when the
// searcher was constructed without them.
func (v *vectorRecall) fallbackToMongo() bool {
	if v == nil {
		return false
	}
	if stored, ok := loadStoredFallbackToMongo(v.db, v.redis); ok {
		return stored
	}
	if v.searcher == nil {
		return false
	}
	return v.searcher.fallbackToMongo
}

// scoredCandidate is one locally scored ProcessedItem.
type scoredCandidate struct {
	itemMetaID string
	score      float64
}

// localCosineIDs ports the Mongo fallback of resolveVectorSearchIds: load at
// most VectorSearchMaxCandidates newest completed candidates for the model in
// this organization, keep the finite cosine scores at or above
// VectorSearchMinSimilarity, sort by score DESC, and return at most
// VectorSearchMaxResults distinct itemMetaIds.
func (v *vectorRecall) localCosineIDs(ctx context.Context, orgID string, model string, embedding []float64, lookbackMs int64) (json.RawMessage, error) {
	if v.mongo == nil {
		return emptyIDListJSON(), nil
	}
	cutoff := time.Now().Add(-time.Duration(lookbackMs) * time.Millisecond)
	candidates, err := v.mongo.VectorCandidates(ctx, orgID, model, cutoff)
	if err != nil {
		return nil, err
	}
	scored := make([]scoredCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		itemMetaID := strings.TrimSpace(candidate.ItemMetaID)
		if itemMetaID == "" {
			continue
		}
		vector := candidate.SummaryEmbedding
		if len(vector) != len(embedding) {
			continue
		}
		similarity := cosineSimilarity(embedding, vector)
		if !isFinite(similarity) || similarity < VectorSearchMinSimilarity {
			continue
		}
		scored = append(scored, scoredCandidate{itemMetaID: itemMetaID, score: similarity})
	}
	sortScoredCandidatesDescending(scored)
	ids := make([]string, 0, len(scored))
	seen := make(map[string]struct{}, len(scored))
	for _, entry := range scored {
		if _, ok := seen[entry.itemMetaID]; ok {
			continue
		}
		seen[entry.itemMetaID] = struct{}{}
		ids = append(ids, entry.itemMetaID)
		if len(ids) >= VectorSearchMaxResults {
			break
		}
	}
	return encodeIDList(ids)
}

// sortScoredCandidatesDescending orders candidates by score DESC with a stable
// insertion sort, so the Mongo scan order breaks ties exactly like the stable
// Array.prototype.sort NestJS relies on. The window is capped at
// VectorSearchMaxCandidates, so the quadratic bound is acceptable on this
// degraded fallback path.
func sortScoredCandidatesDescending(candidates []scoredCandidate) {
	for index := 1; index < len(candidates); index++ {
		current := candidates[index]
		position := index - 1
		for position >= 0 && candidates[position].score < current.score {
			candidates[position+1] = candidates[position]
			position--
		}
		candidates[position+1] = current
	}
}

// dedupeAndCapMatches keeps the first occurrence order of the vector service
// matches and caps the result at VectorSearchMaxResults itemMetaIds.
func dedupeAndCapMatches(matches []VectorSearchMatch) []string {
	ids := make([]string, 0, len(matches))
	seen := make(map[string]struct{}, len(matches))
	for _, match := range matches {
		if _, ok := seen[match.ItemMetaID]; ok {
			continue
		}
		seen[match.ItemMetaID] = struct{}{}
		ids = append(ids, match.ItemMetaID)
		if len(ids) >= VectorSearchMaxResults {
			break
		}
	}
	return ids
}

// cosineSimilarity ports the NestJS cosineSimilarity helper: equal non-zero
// dimensions, finite components and non-zero norms are required, and every
// other input returns 0.
func cosineSimilarity(a []float64, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	dot := 0.0
	normA := 0.0
	normB := 0.0
	for index := 0; index < len(a); index++ {
		left := a[index]
		right := b[index]
		if !isFinite(left) || !isFinite(right) {
			return 0
		}
		dot += left * right
		normA += left * left
		normB += right * right
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

// vectorSearchCacheKey ports vectorSearchCacheKey: the items vector prefix, the
// organization id, then the sha256 hex digest of the query.
func vectorSearchCacheKey(orgID string, query string) string {
	return ItemsVectorSearchPrefix + orgID + ":" + sha256Hex(query)
}

// sha256Hex returns the lowercase hex digest of a value without importing
// encoding/hex.
func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	out := make([]byte, len(sum)*2)
	for index, octet := range sum {
		out[index*2] = sha256HexDigits[octet>>4]
		out[index*2+1] = sha256HexDigits[octet&0x0f]
	}
	return string(out)
}

// encodeIDList marshals an itemMetaId list. A nil list becomes [] so the cached
// value is always a JSON array.
func encodeIDList(ids []string) (json.RawMessage, error) {
	if ids == nil {
		ids = []string{}
	}
	raw, err := json.Marshal(ids)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// decodeIDList reads a cached itemMetaId array. It fails on missing bytes and on
// values that are not a string array, which makes the caller degrade to empty.
func decodeIDList(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return nil, false
	}
	if ids == nil {
		ids = []string{}
	}
	return ids, true
}

// emptyIDListJSON is the cached representation of an empty recall.
func emptyIDListJSON() json.RawMessage {
	return json.RawMessage("[]")
}

// vectorServiceSetting is the typed projection of the stored settings object.
// Only the fallbackToMongo member is consumed here.
type vectorServiceSetting struct {
	FallbackToMongo json.RawMessage `json:"fallbackToMongo"`
}

// cachedVectorServiceSetting is the {exists,value} Redis cache envelope used by
// VectorServiceSettingsService. Value stays raw so an entry written by this
// gateway still carries every member (enabled, baseUrl, token, timeoutMs,
// maxRetries) that the NestJS settings service reads from the same key.
type cachedVectorServiceSetting struct {
	Exists bool            `json:"exists"`
	Value  json.RawMessage `json:"value,omitempty"`
}

// loadStoredFallbackToMongo reads the DB-stored fallbackToMongo override,
// preferring the Redis cache. found is false when there is no usable override,
// in which case the env default applies.
func loadStoredFallbackToMongo(db *sql.DB, redisClient *redis.Client) (bool, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), vectorServiceSettingsReadTimeout)
	defer cancel()
	if redisClient != nil {
		if raw, err := redisClient.Get(ctx, vectorServiceSettingsCacheKey).Bytes(); err == nil && len(raw) > 0 {
			var cached cachedVectorServiceSetting
			if json.Unmarshal(raw, &cached) == nil {
				if !cached.Exists {
					return false, false
				}
				return decodeStoredFallback(cached.Value)
			}
		}
	}
	if db == nil {
		return false, false
	}
	var raw []byte
	err := db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", vectorServiceSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		cacheStoredSetting(ctx, redisClient, cachedVectorServiceSetting{Exists: false})
		return false, false
	}
	if err != nil {
		return false, false
	}
	settingRaw := json.RawMessage(raw)
	cached := cachedVectorServiceSetting{Exists: true}
	if isJSONObject(settingRaw) {
		cached.Value = settingRaw
	}
	cacheStoredSetting(ctx, redisClient, cached)
	return decodeStoredFallback(settingRaw)
}

// decodeStoredFallback reads the boolean fallbackToMongo member of a stored
// settings value. found is false when the value is not an object or the member
// is absent or not a boolean, so the caller keeps the env default.
func decodeStoredFallback(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 {
		return false, false
	}
	var settings vectorServiceSetting
	if err := json.Unmarshal(raw, &settings); err != nil {
		return false, false
	}
	return decodeStoredBool(settings.FallbackToMongo)
}

// isJSONObject reports whether a value is a JSON object, matching the
// `typeof raw === "object"` guard of VectorServiceSettingsService.
func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// decodeStoredBool reads a nullable stored boolean. found is false when the
// member is absent or is not a boolean, which makes the caller use the default.
func decodeStoredBool(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

// cacheStoredSetting writes the settings cache best-effort, mirroring the
// NestJS behaviour of logging a cache failure and continuing.
func cacheStoredSetting(ctx context.Context, redisClient *redis.Client, cached cachedVectorServiceSetting) {
	if redisClient == nil {
		return
	}
	raw, err := json.Marshal(cached)
	if err != nil {
		return
	}
	_ = redisClient.Set(ctx, vectorServiceSettingsCacheKey, raw,
		time.Duration(vectorServiceSettingsCacheTTLSeconds)*time.Second).Err()
}

// envTruthy reports whether an environment value is truthy. It ports the
// envBoolean preprocessor of the NestJS env schema: "true", "1", "yes", "y" and
// "on" (case-insensitive, trimmed) are true and everything else is false.
func envTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes", "y", "on":
		return true
	default:
		return false
	}
}
