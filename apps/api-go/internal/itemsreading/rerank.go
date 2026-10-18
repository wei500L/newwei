package itemsreading

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

// This file owns the relevance rerank call and its isolated request log. The
// log is deliberately written from here rather than from a shared logging
// package: only this link's rerank requests are in scope, the writer targets the
// existing llmrequestlogs collection, and a logging failure must never change
// the query result.

// RerankUnavailableError is the typed failure the GraphQL adapter maps to
// SERVICE_UNAVAILABLE with appCode RERANK_UNAVAILABLE. Detail carries the safe
// upstream description and never request or document content.
type RerankUnavailableError struct {
	Detail string
}

// Error returns the NestJS message.
func (e *RerankUnavailableError) Error() string {
	return "Reranker unavailable: failed to rank relevance results."
}

// tryRerankCandidates ports tryRerankCandidates: a disabled reranker, no
// candidates or no usable document text skips reranking (nil result, no error),
// while an enabled reranker that cannot produce usable scores fails with
// RerankUnavailableError instead of silently falling back to the lexical score.
func (s *Service) tryRerankCandidates(
	ctx context.Context,
	orgID string,
	query string,
	candidates []relevanceCandidate,
	timeoutMs int,
) (map[string]float64, error) {
	if len(candidates) == 0 || !s.ranking.RerankEnabled || s.embedder == nil {
		return nil, nil
	}
	documents := make([]string, 0, len(candidates))
	hasDocument := false
	for _, candidate := range candidates {
		documents = append(documents, candidate.Document)
		if len(candidate.Document) > 0 {
			hasDocument = true
		}
	}
	if !hasDocument {
		return nil, nil
	}

	outcome, err := s.embedder.RerankWithOutcome(ctx, llmembed.RerankOptions{
		OrgID:          orgID,
		Query:          query,
		Documents:      documents,
		TimeoutMs:      maxInt(timeoutMs, llmembed.RerankMinTimeoutMs),
		MaxRetries:     1,
		MetadataSource: "items-search-rerank",
	})
	s.writeRerankLog(ctx, orgID, outcome)
	if err != nil {
		return nil, &RerankUnavailableError{Detail: outcome.Error}
	}

	// min/max normalization over the returned scores; a degenerate span maps a
	// positive maximum to 1 and everything else to 0, exactly like NestJS.
	rawScores := make([]float64, 0, len(outcome.Hits))
	for _, hit := range outcome.Hits {
		if isFinite(hit.Score) {
			rawScores = append(rawScores, hit.Score)
		}
	}
	if len(rawScores) == 0 {
		return nil, &RerankUnavailableError{Detail: "rerank response did not include usable scores"}
	}
	minScore := rawScores[0]
	maxScore := rawScores[0]
	for _, score := range rawScores[1:] {
		if score < minScore {
			minScore = score
		}
		if score > maxScore {
			maxScore = score
		}
	}
	span := maxScore - minScore
	scoreByID := make(map[string]float64, len(outcome.Hits))
	for _, hit := range outcome.Hits {
		if hit.Index < 0 || hit.Index >= len(candidates) {
			continue
		}
		normalized := 0.0
		switch {
		case span > 1e-9:
			normalized = (hit.Score - minScore) / span
		case maxScore > 0:
			normalized = 1
		}
		scoreByID[candidates[hit.Index].ID] = clamp01(normalized)
	}
	if len(scoreByID) == 0 {
		return nil, &RerankUnavailableError{Detail: "rerank response did not map to any candidate documents"}
	}
	return scoreByID, nil
}

// llmRequestLogsCollection is the Mongoose LlmRequestLog collection name.
const llmRequestLogsCollection = "llmrequestlogs"

// llmRequestLogSettingsKey is the MySQL SystemSetting key of the request log
// settings.
const llmRequestLogSettingsKey = "llm_request_log_settings"

// defaultLLMLogMetadataKeys mirrors DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS.
var defaultLLMLogMetadataKeys = []string{
	"attempt", "batchid", "category", "channel", "correlationid", "env", "feature", "flowid",
	"jobid", "language", "locale", "model", "module", "nodeid", "operation", "pipeline", "profileid",
	"profile", "provider", "requestid", "retry", "frontiernodeid", "frontierrunid",
	"crawlsiteprofileid", "runid", "scenario", "sessionid", "source", "stage", "tags", "taskid",
	"tenantid", "traceid", "userid", "version",
}

// requiredLLMLogMetadataKeys mirrors REQUIRED_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS.
var requiredLLMLogMetadataKeys = []string{
	"runid", "nodeid", "profileid", "frontierrunid", "frontiernodeid", "crawlsiteprofileid",
}

// defaultLLMLogMetadataPrefixes mirrors DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES.
var defaultLLMLogMetadataPrefixes = []string{"x_", "meta_", "ctx_"}

// llmRequestLogDoc is the strongly typed insert document of one rerank request
// log. The scalar columns are pointers so an unknown value is written as null,
// exactly like the NestJS defaults.
type llmRequestLogDoc struct {
	OrgID                     string    `bson:"orgId"`
	RequestType               string    `bson:"requestType"`
	Model                     string    `bson:"model"`
	Status                    string    `bson:"status"`
	PromptTokens              *float64  `bson:"promptTokens"`
	CompletionTokens          *float64  `bson:"completionTokens"`
	TotalTokens               *float64  `bson:"totalTokens"`
	CostUSD                   *float64  `bson:"costUsd"`
	Feature                   *string   `bson:"feature"`
	GatewayProfileID          *string   `bson:"gatewayProfileId"`
	GovernanceApplied         *bool     `bson:"governanceApplied"`
	AuthMode                  *string   `bson:"authMode"`
	GovernanceTargetProfileID *string   `bson:"governanceTargetProfileId"`
	LatencyMs                 int64     `bson:"latencyMs"`
	Error                     *string   `bson:"error"`
	Metadata                  *bson.D   `bson:"metadata"`
	APISurface                *string   `bson:"apiSurface"`
	CreatedAt                 time.Time `bson:"createdAt"`
	UpdatedAt                 time.Time `bson:"updatedAt"`
}

// llmRequestLogMetadata is the named metadata payload of this link's rerank
// log. A named struct is used instead of a generic map so the filtered result
// stays strongly typed.
type llmRequestLogMetadata struct {
	OrgID  string
	Source string
}

// writeRerankLog persists one best-effort rerank request log. It never returns
// an error: a logging failure must not change the query result. Requests that
// failed before a profile was resolved are not logged, matching NestJS, which
// starts the runtime request only after the profile is available.
func (s *Service) writeRerankLog(ctx context.Context, orgID string, outcome llmembed.RerankOutcome) {
	if s.mongo == nil || s.mongo.db == nil {
		return
	}
	if outcome.ProfileID == "" && outcome.Attempts == 0 {
		return
	}
	policy := s.llmLogMetadataPolicy(ctx)
	metadata := filterLLMLogMetadata(llmRequestLogMetadata{OrgID: orgID, Source: "items-search-rerank"}, policy)

	document := llmRequestLogDoc{
		OrgID:                     strings.TrimSpace(orgID),
		RequestType:               "rerank",
		Model:                     fallbackString(outcome.Model, "unknown"),
		Status:                    fallbackString(outcome.Status, llmembed.RerankStatusError),
		LatencyMs:                 outcome.LatencyMs,
		Metadata:                  metadata,
		APISurface:                stringPointer("rerank"),
		Error:                     optionalTrimmed(outcome.Error),
		GovernanceApplied:         boolPointer(outcome.GovernanceApplied),
		AuthMode:                  optionalTrimmed(outcome.AuthMode),
		GatewayProfileID:          optionalTrimmed(outcome.ProfileID),
		GovernanceTargetProfileID: optionalTrimmed(outcome.GovernanceTargetProfileID),
		CreatedAt:                 time.Now().UTC(),
		UpdatedAt:                 time.Now().UTC(),
	}
	if document.OrgID == "" {
		document.OrgID = "unknown"
	}
	if _, err := s.mongo.db.Collection(llmRequestLogsCollection).InsertOne(ctx, document); err != nil {
		// Operator diagnostics only; the caller's result is unaffected.
		log.Printf("api-go: items rerank request log write failed: %v", err)
	}
}

// filterLLMLogMetadata applies the llm_request_log_settings metadata policy to
// the two named tokens this link emits, mirroring normalizeMetadata: keys are
// lowercased, truncated to 64 characters and kept only when they match an
// allowed key or prefix.
func filterLLMLogMetadata(source llmRequestLogMetadata, policy llmLogMetadataPolicy) *bson.D {
	candidates := []struct {
		key   string
		value string
	}{
		{key: "orgId", value: source.OrgID},
		{key: "source", value: source.Source},
	}
	out := make(bson.D, 0, len(candidates))
	for _, candidate := range candidates {
		key := normalizeLLMLogMetadataKey(candidate.key)
		if key == "" || !policy.allows(key) {
			continue
		}
		value := strings.TrimSpace(candidate.value)
		if value == "" {
			continue
		}
		out = append(out, bson.E{Key: key, Value: value})
	}
	if len(out) == 0 {
		return nil
	}
	return &out
}

// llmLogMetadataPolicy is the resolved metadata allow-list.
type llmLogMetadataPolicy struct {
	keys     map[string]struct{}
	prefixes []string
}

// allows reports whether a normalized key is permitted.
func (p llmLogMetadataPolicy) allows(key string) bool {
	if _, ok := p.keys[key]; ok {
		return true
	}
	for _, prefix := range p.prefixes {
		if prefix != "" && strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

// llmLogStoredPolicy is the SystemSetting.value shape this reader understands.
// A drifted value falls back to the defaults, mirroring the lenient read path.
type llmLogStoredPolicy struct {
	MetadataAllowedTopLevelKeys     json.RawMessage `json:"metadataAllowedTopLevelKeys"`
	MetadataAllowedTopLevelPrefixes json.RawMessage `json:"metadataAllowedTopLevelPrefixes"`
}

// llmLogMetadataPolicy loads the effective metadata allow-list from
// llm_request_log_settings. A missing, unreadable or drifted setting yields the
// defaults.
func (s *Service) llmLogMetadataPolicy(ctx context.Context) llmLogMetadataPolicy {
	keys := append([]string{}, defaultLLMLogMetadataKeys...)
	prefixes := append([]string{}, defaultLLMLogMetadataPrefixes...)

	if s.mysql != nil {
		raw, found, err := s.mysql.ReadJSONSystemSetting(ctx, llmRequestLogSettingsKey)
		if err == nil && found && raw.Valid() {
			var stored llmLogStoredPolicy
			if json.Unmarshal(raw.Bytes(), &stored) == nil {
				if values, ok := decodeLLMLogTokenList(stored.MetadataAllowedTopLevelKeys, 100, 64); ok {
					keys = values
				}
				if values, ok := decodeLLMLogTokenList(stored.MetadataAllowedTopLevelPrefixes, 20, 24); ok {
					prefixes = values
				}
			}
		}
	}
	keys = mergeRequiredLLMLogKeys(keys)
	allowed := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		allowed[key] = struct{}{}
	}
	return llmLogMetadataPolicy{keys: allowed, prefixes: prefixes}
}

// decodeLLMLogTokenList decodes a JSON string array, dropping blank entries and
// truncating each token. A malformed value is not ok so the caller keeps the
// default.
func decodeLLMLogTokenList(raw json.RawMessage, maxItems, maxLength int) ([]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, false
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.ToLower(strings.TrimSpace(value))
		if trimmed == "" {
			continue
		}
		if len(trimmed) > maxLength {
			trimmed = trimmed[:maxLength]
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
		if len(out) >= maxItems {
			break
		}
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

// mergeRequiredLLMLogKeys appends the required keys that are missing, keeping
// the first-occurrence order.
func mergeRequiredLLMLogKeys(keys []string) []string {
	seen := make(map[string]struct{}, len(keys)+len(requiredLLMLogMetadataKeys))
	out := make([]string, 0, len(keys)+len(requiredLLMLogMetadataKeys))
	for _, key := range keys {
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	for _, key := range requiredLLMLogMetadataKeys {
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

// normalizeLLMLogMetadataKey ports normalizeMetadataKey.
func normalizeLLMLogMetadataKey(rawKey string) string {
	trimmed := strings.ToLower(strings.TrimSpace(rawKey))
	if trimmed == "" {
		return ""
	}
	if len(trimmed) > 64 {
		trimmed = trimmed[:64]
	}
	return trimmed
}

// fallbackString returns value when it is non-blank, otherwise fallback.
func fallbackString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// optionalTrimmed returns nil for a blank string.
func optionalTrimmed(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// boolPointer returns a pointer to a copy of value.
func boolPointer(value bool) *bool {
	copied := value
	return &copied
}
