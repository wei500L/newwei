package newsbackfilljobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/infrastructuresettings"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"
)

const (
	// vectorSearchPath is the vector-service similarity endpoint.
	vectorSearchPath = "/v1/search"
	// vectorDefaultTimeoutMs mirrors VECTOR_SERVICE_TIMEOUT_MS (5000).
	vectorDefaultTimeoutMs = 5000
	// vectorMaxResponseBytes caps one response body.
	vectorMaxResponseBytes = 8 << 20
	// vectorRetryBaseDelay mirrors computeBackoffDelay(200, attempt). The Go
	// port omits the random jitter: the retry count and the retryable set are
	// identical, only the delay is deterministic.
	vectorRetryBaseDelay = 200 * time.Millisecond
)

// VectorConfigReader is the narrow port the searcher needs. The production
// implementation is infrastructuresettings.Service, whose VectorRuntimeConfig
// applies the stored row over the environment defaults and decrypts the token.
type VectorConfigReader interface {
	VectorRuntimeConfig(ctx context.Context) (infrastructuresettings.VectorRuntimeConfig, error)
}

// VectorSearcher is the vector-service client of the assignment-candidate
// listing. It resolves the effective vector configuration on every call, so a
// settings edit takes effect without a restart.
type VectorSearcher struct {
	settings VectorConfigReader
	client   *http.Client
}

// NewVectorSearcher builds the searcher. A nil settings reader makes every
// search return no candidates, which the caller treats exactly like the NestJS
// searchBestEffort returning null.
func NewVectorSearcher(settings VectorConfigReader) *VectorSearcher {
	return &VectorSearcher{settings: settings, client: &http.Client{}}
}

// vectorSearchRequest is the /v1/search body.
type vectorSearchRequest struct {
	OrgID          string    `json:"orgId"`
	EmbeddingModel string    `json:"embeddingModel"`
	Vector         []float64 `json:"vector"`
	Limit          int       `json:"limit"`
	MinScore       float64   `json:"minScore"`
	LookbackMs     int64     `json:"lookbackMs"`
}

// vectorSearchResponse is the /v1/search response.
type vectorSearchResponse struct {
	Collection string              `json:"collection"`
	Matches    []vectorSearchMatch `json:"matches"`
}

// vectorSearchMatch is one match of the /v1/search response.
type vectorSearchMatch struct {
	ProcessedItemID string  `json:"processedItemId"`
	ItemMetaID      string  `json:"itemMetaId"`
	Score           float64 `json:"score"`
	CreatedAtMs     int64   `json:"createdAtMs"`
}

// SearchSummaryVectors performs one best-effort similarity search. Any failure
// (configuration, network, HTTP, payload) returns an error and no candidates;
// the assignment-candidate listing degrades to the local topic/entity matches,
// which is exactly what NestJS searchBestEffort's null does.
func (s *VectorSearcher) SearchSummaryVectors(ctx context.Context, req newsnowclusteringops.SummaryVectorSearchRequest) ([]newsnowclusteringops.SummaryVectorMatch, error) {
	if s == nil || s.settings == nil {
		return nil, nil
	}
	cfg, err := s.settings.VectorRuntimeConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("newsbackfilljobs: resolve vector settings: %w", err)
	}
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if !cfg.Enabled || baseURL == "" || strings.TrimSpace(cfg.Token) == "" {
		// The NestJS client is not created when the service is disabled or the
		// configuration is incomplete; searchBestEffort then returns null.
		return nil, nil
	}
	if len(req.Vector) == 0 || strings.TrimSpace(req.EmbeddingModel) == "" {
		return nil, nil
	}
	timeout := cfg.TimeoutMs
	if timeout <= 0 {
		timeout = vectorDefaultTimeoutMs
	}
	payload, err := json.Marshal(vectorSearchRequest{
		OrgID:          req.OrgID,
		EmbeddingModel: req.EmbeddingModel,
		Vector:         req.Vector,
		Limit:          req.Limit,
		MinScore:       req.MinScore,
		LookbackMs:     req.Lookback.Milliseconds(),
	})
	if err != nil {
		return nil, fmt.Errorf("newsbackfilljobs: encode vector search: %w", err)
	}

	maxAttempts := cfg.MaxRetries + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	var last error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		matches, retryable, attemptErr := s.searchOnce(ctx, baseURL, cfg.Token, payload, timeout)
		if attemptErr == nil {
			return matches, nil
		}
		last = attemptErr
		if !retryable || attempt >= maxAttempts {
			break
		}
		if sleepErr := sleepContext(ctx, vectorRetryBaseDelay*time.Duration(1<<uint(attempt-1))); sleepErr != nil {
			return nil, sleepErr
		}
	}
	if last == nil {
		last = errors.New("newsbackfilljobs: vector search failed")
	}
	return nil, last
}

// searchOnce performs one HTTP attempt. The retryable result mirrors the
// vector-client package: 5xx, network and timeout failures retry; 401/403 and
// every other non-2xx or malformed payload do not.
func (s *VectorSearcher) searchOnce(ctx context.Context, baseURL, token string, payload []byte, timeoutMs int) ([]newsnowclusteringops.SummaryVectorMatch, bool, error) {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, http.MethodPost, baseURL+vectorSearchPath, bytes.NewReader(payload))
	if err != nil {
		return nil, false, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-internal-token", token)
	if traceID := httpx.TraceIDFromContext(ctx); traceID != "" {
		request.Header.Set("x-trace-id", traceID)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, true, fmt.Errorf("newsbackfilljobs: vector search request failed: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, vectorMaxResponseBytes))
	if readErr != nil {
		return nil, true, fmt.Errorf("newsbackfilljobs: read vector search response: %w", readErr)
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return nil, false, fmt.Errorf("newsbackfilljobs: vector service authentication failed (HTTP %d)", response.StatusCode)
	}
	if response.StatusCode >= 500 {
		return nil, true, fmt.Errorf("newsbackfilljobs: vector service unavailable (HTTP %d)", response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, false, fmt.Errorf("newsbackfilljobs: vector service returned HTTP %d", response.StatusCode)
	}
	var decoded vectorSearchResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false, fmt.Errorf("newsbackfilljobs: vector search returned an invalid payload: %w", err)
	}
	if strings.TrimSpace(decoded.Collection) == "" {
		return nil, false, errors.New("newsbackfilljobs: vector search returned an invalid payload")
	}
	matches := make([]newsnowclusteringops.SummaryVectorMatch, 0, len(decoded.Matches))
	for _, match := range decoded.Matches {
		processedItemID := strings.TrimSpace(match.ProcessedItemID)
		if processedItemID == "" || strings.TrimSpace(match.ItemMetaID) == "" ||
			math.IsNaN(match.Score) || math.IsInf(match.Score, 0) || match.CreatedAtMs < 0 {
			return nil, false, errors.New("newsbackfilljobs: vector search returned an invalid match")
		}
		matches = append(matches, newsnowclusteringops.SummaryVectorMatch{
			ProcessedItemID: processedItemID,
			Score:           match.Score,
		})
	}
	return matches, false, nil
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
