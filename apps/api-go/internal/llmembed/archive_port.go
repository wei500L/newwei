package llmembed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Archive model-call port.
//
// The shared Embed/Rerank methods fold upstream and parse failures into one
// sentinel and do not expose per-attempt observations, while the archive read
// path must distinguish "upstream failed" from "response had no usable
// vector/score" and must log every real logical attempt. This file adds that
// narrow surface without changing the existing callers.
const (
	archiveRetryDelayStart = time.Second
	archiveRetryDelayMax   = 10 * time.Second
	archiveResponseLimit   = 8 << 20
)

// ModelFailureKind classifies one archive model failure.
type ModelFailureKind int

const (
	// ModelFailureUnavailable means no profile/model is configured.
	ModelFailureUnavailable ModelFailureKind = iota
	// ModelFailureUpstream means the gateway call failed after its retries.
	ModelFailureUpstream
	// ModelFailureInvalidResponse means a 2xx response had no usable vector or
	// score.
	ModelFailureInvalidResponse
)

// ModelFailure is the typed archive model error. Callers map the kind onto the
// public archive appCode; the wrapped error stays diagnostic only.
type ModelFailure struct {
	Kind  ModelFailureKind
	API   string
	Cause error
}

func (e *ModelFailure) Error() string {
	if e == nil {
		return ""
	}
	if e.Cause != nil {
		return fmt.Sprintf("%s %s: %v", e.API, failureLabel(e.Kind), e.Cause)
	}
	return fmt.Sprintf("%s %s", e.API, failureLabel(e.Kind))
}

func (e *ModelFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func failureLabel(kind ModelFailureKind) string {
	switch kind {
	case ModelFailureUpstream:
		return "upstream failed"
	case ModelFailureInvalidResponse:
		return "invalid response"
	default:
		return "unavailable"
	}
}

// ArchiveUsage is the upstream-reported token/cost snapshot. Unreported members stay
// nil so the log document stores null rather than a fabricated zero.
type ArchiveUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// Attempt is one real logical model attempt: one HTTP call after the optional
// 404/405 path fallback, exactly like executeEmbeddingWithRetry /
// executeRerankWithRetry.
type ArchiveAttempt struct {
	Model                     string
	ProfileID                 string
	ProfileName               string
	APISurface                string
	AuthMode                  string
	GovernanceApplied         bool
	GovernanceTargetProfileID string
	Latency                   time.Duration
	Success                   bool
	Error                     string
	Usage                     ArchiveUsage
	OccurredAt                time.Time
}

// ArchiveEmbeddingOutcome is the archive embedding result with every attempt.
type ArchiveEmbeddingOutcome struct {
	Vectors  [][]float64
	Model    string
	Attempts []ArchiveAttempt
}

// ArchiveRerankOutcome is the archive rerank result with every attempt.
type ArchiveRerankOutcome struct {
	Hits     []Hit
	Model    string
	Attempts []ArchiveAttempt
}

// RuntimeEmbeddingModel reports the currently selected embedding model. ok is
// false when no enabled profile configures one.
func (c *Client) RuntimeEmbeddingModel(ctx context.Context) (string, bool) {
	profile, err := c.resolveEmbedding(ctx)
	if err != nil {
		return "", false
	}
	model := strings.TrimSpace(profile.EmbeddingModel)
	return model, model != ""
}

// RuntimeRerankModel reports the currently selected rerank model.
func (c *Client) RuntimeRerankModel(ctx context.Context) (string, bool) {
	_, _, ok := c.RuntimeRerankProfile(ctx)
	if !ok {
		return "", false
	}
	profile, err := c.resolveRerank(ctx)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(profile.RerankModel), true
}

// RuntimeRerankProfile reports the selected rerank model and its effective
// profile timeout. The archive rerank must pass that timeout explicitly.
func (c *Client) RuntimeRerankProfile(ctx context.Context) (string, time.Duration, bool) {
	profile, err := c.resolveRerank(ctx)
	if err != nil {
		return "", 0, false
	}
	model := strings.TrimSpace(profile.RerankModel)
	if model == "" || profile.Timeout <= 0 {
		return "", 0, false
	}
	return model, profile.Timeout, true
}

// EmbedForArchive embeds one query for the archive search. configuredModel is
// the model the caller observed before the cache lookup; the profile is resolved
// again so governance and fallback behavior match the shared client.
func (c *Client) EmbedForArchive(ctx context.Context, orgID, configuredModel, input, source string) (ArchiveEmbeddingOutcome, error) {
	outcome := ArchiveEmbeddingOutcome{}
	profile, err := c.resolveEmbedding(ctx)
	if err != nil {
		return outcome, &ModelFailure{Kind: ModelFailureUnavailable, API: "embeddings", Cause: err}
	}
	model := strings.TrimSpace(configuredModel)
	if model == "" {
		model = strings.TrimSpace(profile.EmbeddingModel)
	}
	if model == "" {
		return outcome, &ModelFailure{Kind: ModelFailureUnavailable, API: "embeddings"}
	}
	payload := map[string]any{
		"model": model,
		"input": input,
	}
	if meta := metadataPayloadForSource(profile.SendMetadata, source); meta != nil {
		payload["metadata"] = meta
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "embeddings", Cause: err}
	}

	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := archiveRetryDelayStart
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if ctx.Err() != nil {
			return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "embeddings", Cause: ctx.Err()}
		}
		started := time.Now()
		status, headers, raw, callErr := c.postRaw(ctx, profile, "/v1/embeddings", "/embeddings", body, profile.Timeout)
		latency := time.Since(started)
		if callErr == nil && status >= 200 && status < 300 {
			vectors, responseModel, usage, parseErr := parseArchiveEmbeddings(raw, headers)
			if parseErr == nil && len(vectors) > 0 && len(vectors[0]) > 0 {
				actualModel := responseModel
				if actualModel == "" {
					actualModel = model
				}
				outcome.Vectors = vectors
				outcome.Model = actualModel
				outcome.Attempts = append(outcome.Attempts, archiveAttempt(profile, "embeddings", actualModel, latency, nil, usage))
				return outcome, nil
			}
			outcome.Attempts = append(outcome.Attempts, archiveAttempt(profile, "embeddings", model, latency, parseErr, usage))
			return outcome, &ModelFailure{Kind: ModelFailureInvalidResponse, API: "embeddings", Cause: parseErr}
		}
		if callErr == nil {
			callErr = fmt.Errorf("gateway returned status %d", status)
		}
		outcome.Attempts = append(outcome.Attempts, archiveAttempt(profile, "embeddings", model, latency, callErr, ArchiveUsage{}))
		lastErr = callErr
		if attempt+1 >= attempts || !archiveRetryable(status, callErr) {
			break
		}
		if err := sleepContext(ctx, delay); err != nil {
			return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "embeddings", Cause: err}
		}
		delay *= 2
		if delay > archiveRetryDelayMax {
			delay = archiveRetryDelayMax
		}
	}
	return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "embeddings", Cause: lastErr}
}

// RerankForArchive reranks the archive candidates. maxRetries follows the Nest
// per-model attempt count: 1 means one attempt per configured model, and the
// fallback list is tried only after the previous model's attempts fail. timeout
// must be the profile timeout; passing 0 here would be a caller bug because the
// explicit timeout is what keeps this path off the shared 100ms floor.
func (c *Client) RerankForArchive(ctx context.Context, orgID, query string, documents []string, maxRetries int, timeout time.Duration, source string) (ArchiveRerankOutcome, error) {
	outcome := ArchiveRerankOutcome{}
	if len(documents) == 0 {
		return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "rerank", Cause: fmt.Errorf("documents are required")}
	}
	profile, err := c.resolveRerank(ctx)
	if err != nil {
		return outcome, &ModelFailure{Kind: ModelFailureUnavailable, API: "rerank", Cause: err}
	}
	models := uniqueModels(append([]string{profile.RerankModel}, profile.RerankFallbacks...))
	if len(models) == 0 {
		return outcome, &ModelFailure{Kind: ModelFailureUnavailable, API: "rerank"}
	}
	if timeout <= 0 {
		return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "rerank", Cause: fmt.Errorf("profile timeout is required")}
	}
	attempts := maxRetries
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	invalidResponse := false
	for _, model := range models {
		payload := map[string]any{
			"model":     model,
			"query":     query,
			"documents": documents,
			"top_n":     len(documents),
		}
		if meta := metadataPayloadForSource(profile.SendMetadata, source); meta != nil {
			payload["metadata"] = meta
		}
		body, err := json.Marshal(payload)
		if err != nil {
			lastErr = err
			continue
		}
		delay := archiveRetryDelayStart
		for attempt := 0; attempt < attempts; attempt++ {
			if ctx.Err() != nil {
				return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "rerank", Cause: ctx.Err()}
			}
			started := time.Now()
			status, headers, raw, callErr := c.postRaw(ctx, profile, "/v1/rerank", "/rerank", body, timeout)
			latency := time.Since(started)
			if callErr == nil && status >= 200 && status < 300 {
				hits, responseModel, usage, parseErr := parseArchiveRerank(raw, headers, len(documents))
				if parseErr == nil && len(hits) > 0 {
					actualModel := responseModel
					if actualModel == "" {
						actualModel = model
					}
					outcome.Hits = hits
					outcome.Model = actualModel
					outcome.Attempts = append(outcome.Attempts, archiveAttempt(profile, "rerank", actualModel, latency, nil, usage))
					return outcome, nil
				}
				outcome.Attempts = append(outcome.Attempts, archiveAttempt(profile, "rerank", model, latency, parseErr, usage))
				lastErr = parseErr
				invalidResponse = true
				break
			}
			if callErr == nil {
				callErr = fmt.Errorf("gateway returned status %d", status)
			}
			outcome.Attempts = append(outcome.Attempts, archiveAttempt(profile, "rerank", model, latency, callErr, ArchiveUsage{}))
			lastErr = callErr
			invalidResponse = false
			if attempt+1 >= attempts || !archiveRetryable(status, callErr) {
				break
			}
			if err := sleepContext(ctx, delay); err != nil {
				return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "rerank", Cause: err}
			}
			delay *= 2
			if delay > archiveRetryDelayMax {
				delay = archiveRetryDelayMax
			}
		}
	}
	if invalidResponse {
		return outcome, &ModelFailure{Kind: ModelFailureInvalidResponse, API: "rerank", Cause: lastErr}
	}
	if lastErr != nil {
		return outcome, &ModelFailure{Kind: ModelFailureUpstream, API: "rerank", Cause: lastErr}
	}
	return outcome, &ModelFailure{Kind: ModelFailureUnavailable, API: "rerank"}
}

// postRaw issues one attempt and also returns the response headers so the
// attempt observer can read the LiteLLM cost headers.
func (c *Client) postRaw(ctx context.Context, profile runtimeProfile, primary, fallback string, body []byte, timeout time.Duration) (int, http.Header, []byte, error) {
	status, headers, raw, err := c.postRawOnce(ctx, profile, primary, body, timeout)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) && fallback != "" {
		return c.postRawOnce(ctx, profile, fallback, body, timeout)
	}
	return status, headers, raw, err
}

func (c *Client) postRawOnce(ctx context.Context, profile runtimeProfile, path string, body []byte, timeout time.Duration) (int, http.Header, []byte, error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if profile.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, archiveResponseLimit))
	return resp.StatusCode, resp.Header.Clone(), raw, err
}

func archiveAttempt(profile runtimeProfile, surface, model string, latency time.Duration, callErr error, usage ArchiveUsage) ArchiveAttempt {
	attempt := ArchiveAttempt{
		Model:                     model,
		ProfileID:                 profile.ID,
		ProfileName:               profile.Name,
		APISurface:                surface,
		AuthMode:                  profile.AuthMode,
		GovernanceApplied:         profile.GovernanceApplied,
		GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
		Latency:                   latency,
		Success:                   callErr == nil,
		Usage:                     usage,
		OccurredAt:                time.Now().UTC(),
	}
	if callErr != nil {
		attempt.Error = callErr.Error()
	}
	return attempt
}

func parseArchiveEmbeddings(raw []byte, headers http.Header) ([][]float64, string, ArchiveUsage, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, "", ArchiveUsage{}, err
	}
	rows, _ := doc["data"].([]any)
	if len(rows) == 0 {
		return nil, "", ArchiveUsage{}, fmt.Errorf("embedding response has no data")
	}
	vectors := make([][]float64, 0, len(rows))
	for _, row := range rows {
		record, ok := row.(map[string]any)
		if !ok {
			continue
		}
		vector := floatSlice(record["embedding"])
		if len(vector) == 0 {
			continue
		}
		vectors = append(vectors, vector)
	}
	if len(vectors) == 0 {
		return nil, "", ArchiveUsage{}, fmt.Errorf("embedding response has no usable vector")
	}
	return vectors, jsonString(doc["model"]), archiveUsage(doc, headers), nil
}

func parseArchiveRerank(raw []byte, headers http.Header, docCount int) ([]Hit, string, ArchiveUsage, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, "", ArchiveUsage{}, err
	}
	rows, _ := doc["results"].([]any)
	if rows == nil {
		rows, _ = doc["data"].([]any)
	}
	hits := make([]Hit, 0, len(rows))
	for _, row := range rows {
		record, ok := row.(map[string]any)
		if !ok {
			continue
		}
		index, ok := integerIndex(record["index"])
		if !ok || index < 0 || index >= docCount {
			continue
		}
		score, ok := rerankScore(record)
		if !ok {
			continue
		}
		hits = append(hits, Hit{Index: index, Score: score})
	}
	if len(hits) == 0 {
		return nil, "", ArchiveUsage{}, fmt.Errorf("rerank response has no usable score")
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	return hits, jsonString(doc["model"]), archiveUsage(doc, headers), nil
}

func archiveUsage(doc map[string]any, headers http.Header) ArchiveUsage {
	usage := ArchiveUsage{}
	if payload, ok := doc["usage"].(map[string]any); ok {
		usage.PromptTokens = optionalNumber(payload["prompt_tokens"])
		usage.CompletionTokens = optionalNumber(payload["completion_tokens"])
		usage.TotalTokens = optionalNumber(payload["total_tokens"])
		if usage.CostUSD == nil {
			usage.CostUSD = optionalNumber(payload["response_cost"])
		}
	}
	if usage.CostUSD == nil {
		usage.CostUSD = optionalNumber(doc["response_cost"])
	}
	if usage.CostUSD == nil {
		for _, name := range []string{"x-litellm-response-cost", "x-litellm-cost", "litellm-cost"} {
			if value, ok := parseHeaderCost(headers.Get(name)); ok {
				usage.CostUSD = &value
				break
			}
		}
	}
	return usage
}

func optionalNumber(value any) *float64 {
	number, ok := finiteFloat(value)
	if !ok {
		return nil
	}
	return &number
}

func parseHeaderCost(raw string) (float64, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 {
		return 0, false
	}
	return parsed, true
}

// metadataPayloadForSource is metadataPayload for a caller that supplies only a
// source token.
func metadataPayloadForSource(send bool, source string) any {
	if !send || strings.TrimSpace(source) == "" {
		return nil
	}
	return requestMeta{Source: source}
}

func archiveRetryable(status int, callErr error) bool {
	if callErr != nil && status == 0 {
		return true
	}
	switch status {
	case http.StatusRequestTimeout, http.StatusConflict, http.StatusLocked, 425, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
