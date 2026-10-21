package crawlexecution

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// conditional preflight defaults (CrawlConditionalPreflightService).
const (
	defaultConditionalRequestEnabled    = true
	defaultConditionalRequestTimeoutMs  = 5_000
	defaultConditionalRequestMaxRetries = 0
	maxConditionalRedirectHops          = 5
)

// conditionalPreflightInput is CrawlConditionalPreflightService.runConditionalPreflight's
// option object.
type conditionalPreflightInput struct {
	TargetURL        string
	Options          normalizedOptions
	RequestTimeoutMs int
	ETag             *string
	LastModified     *string
	TimeoutMs        int
	MaxRetries       int
}

// getConditionalRequestSettings is getConditionalRequestSettings. A settings
// read failure falls back to the defaults with a warning.
func (s *Service) getConditionalRequestSettings(ctx context.Context) conditionalRequestSettings {
	fallback := conditionalRequestSettings{
		Enabled:    defaultConditionalRequestEnabled,
		TimeoutMs:  defaultConditionalRequestTimeoutMs,
		MaxRetries: defaultConditionalRequestMaxRetries,
	}
	if s.settings == nil {
		return fallback
	}
	normalized := s.settings.ReadNormalized(ctx)
	settings := normalized.Settings
	return conditionalRequestSettings{
		Enabled:    settings.ConditionalRequestEnabled,
		TimeoutMs:  settings.ConditionalRequestTimeoutMs,
		MaxRetries: settings.ConditionalRequestMaxRetries,
	}
}

// findLatestResultHTTPValidationState is
// findLatestResultHttpValidationState: the newest CrawlResult of this task
// matched by canonical fingerprint/canonical URL/raw target URL.
func (s *Service) findLatestResultHTTPValidationState(ctx context.Context, task *taskRow, allowlist []string) (*httpValidationState, error) {
	if s.db == nil {
		return nil, errNotConfigured("crawlexecution: mysql is not configured")
	}
	normalizedTarget := strings.TrimSpace(task.TargetURL)
	canonical := buildCanonicalURLFingerprint(normalizedTarget, allowlist)

	conditions := make([]string, 0, 3)
	args := make([]any, 0, 5)
	args = append(args, task.ID)
	conditions = append(conditions, "`taskId` = ?")
	if canonical != nil {
		conditions = append(conditions, "`sourceUrlFingerprint` = ?")
		args = append(args, canonical.Fingerprint)
		conditions = append(conditions, "`sourceUrl` = ?")
		args = append(args, canonical.CanonicalURL)
	}
	if normalizedTarget != "" {
		conditions = append(conditions, "`sourceUrl` = ?")
		args = append(args, normalizedTarget)
	}
	if len(conditions) == 1 {
		return nil, nil
	}
	query := "SELECT `id`, `fetchedAt`, `metadata` FROM `CrawlResult` WHERE " +
		strings.Join(conditions, " OR ") + " ORDER BY `fetchedAt` DESC LIMIT 1"
	var resultID string
	var fetchedAt time.Time
	var metadataRaw sql.NullString
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&resultID, &fetchedAt, &metadataRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("crawlexecution: load latest crawl result validation state: %w", err)
	}
	state := &httpValidationState{ResultID: resultID, FetchedAt: fetchedAt.UTC()}
	if metadataRaw.Valid && metadataRaw.String != "" {
		var metadata map[string]json.RawMessage
		if err := json.Unmarshal([]byte(metadataRaw.String), &metadata); err == nil {
			state.ETag = pickRawString(metadata, "httpEtag", "etag")
			state.LastModified = pickRawString(metadata, "httpLastModified", "lastModified", "last-modified")
		}
	}
	return state, nil
}

// pickRawString returns the first non-empty string value for keys.
func pickRawString(record map[string]json.RawMessage, keys ...string) *string {
	for _, key := range keys {
		raw, ok := record[key]
		if !ok || len(raw) == 0 {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			continue
		}
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return &trimmed
		}
	}
	return nil
}

// runConditionalPreflight is runConditionalPreflight. It returns nil only never;
// failures are reported as an outcome with status=failed.
func (s *Service) runConditionalPreflight(ctx context.Context, input conditionalPreflightInput) *conditionalPreflightOutcome {
	timeoutMs := resolveConditionalPreflightTimeoutMs(input.TimeoutMs, input.RequestTimeoutMs)
	maxRetries := resolveConditionalPreflightMaxRetries(input.MaxRetries)
	headers := buildConditionalPreflightHeaders(input.Options, input.ETag, input.LastModified)
	maxAttempts := maxInt(maxRetries+1, 1)
	failures := 0
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		head := s.requestConditionalURLStatus(ctx, input.TargetURL, http.MethodHead, headers, timeoutMs)
		if head == nil {
			failures++
			continue
		}
		if head.Status == http.StatusForbidden || head.Status == http.StatusMethodNotAllowed || head.Status == http.StatusNotImplemented {
			get := s.requestConditionalURLStatus(ctx, input.TargetURL, http.MethodGet, headers, timeoutMs)
			if get == nil {
				failures++
				continue
			}
			if shouldRetryConditionalPreflightStatus(get.Status) && attempt < maxAttempts {
				failures++
				continue
			}
			return &conditionalPreflightOutcome{Status: "completed", Result: get, Attempts: attempt, Failures: failures}
		}
		if shouldRetryConditionalPreflightStatus(head.Status) && attempt < maxAttempts {
			failures++
			continue
		}
		return &conditionalPreflightOutcome{Status: "completed", Result: head, Attempts: attempt, Failures: failures}
	}
	return &conditionalPreflightOutcome{Status: "failed", Attempts: maxAttempts, Failures: failures}
}

func resolveConditionalPreflightTimeoutMs(configuredTimeoutMs, requestTimeoutMs int) int {
	bounded := configuredTimeoutMs
	if bounded < 500 {
		bounded = 500
	}
	if bounded > 60_000 {
		bounded = 60_000
	}
	if requestTimeoutMs <= 0 {
		return bounded
	}
	effective := requestTimeoutMs
	if effective > bounded {
		effective = bounded
	}
	if effective < 500 {
		effective = 500
	}
	return effective
}

func resolveConditionalPreflightMaxRetries(value int) int {
	if value < 0 {
		return 0
	}
	if value > 5 {
		return 5
	}
	return value
}

func shouldRetryConditionalPreflightStatus(status int) bool {
	switch status {
	case http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

// buildConditionalPreflightHeaders is buildConditionalPreflightHeaders.
func buildConditionalPreflightHeaders(options normalizedOptions, etag, lastModified *string) map[string]string {
	userAgent := "Mozilla/5.0 (compatible; CrawlConditionalProbe/1.0; +https://example.com)"
	if options.UserAgent != nil && strings.TrimSpace(*options.UserAgent) != "" {
		userAgent = strings.TrimSpace(*options.UserAgent)
	}
	headers := map[string]string{
		"accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"user-agent": userAgent,
	}
	if etag != nil && *etag != "" {
		headers["if-none-match"] = *etag
	}
	if lastModified != nil && *lastModified != "" {
		headers["if-modified-since"] = *lastModified
	}
	return headers
}

// requestConditionalURLStatus is requestConditionalUrlStatus: one SSRF-safe
// HEAD/GET probe that follows redirects manually and validates every hop.
func (s *Service) requestConditionalURLStatus(ctx context.Context, targetURL, method string, headers map[string]string, timeoutMs int) *conditionalPreflightResult {
	response, _, ok := s.ssrfSafeFetch(ctx, targetURL, method, headers, timeoutMs)
	if !ok {
		return nil
	}
	// Only the status and validators are needed; drain and close the body so the
	// probe never leaks a connection (NestJS cancels the GET body the same way).
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	_ = response.Body.Close()
	result := &conditionalPreflightResult{
		Status:    response.StatusCode,
		Method:    method,
		CheckedAt: s.now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if etag := strings.TrimSpace(response.Header.Get("etag")); etag != "" {
		result.ETag = &etag
	}
	if lastModified := strings.TrimSpace(response.Header.Get("last-modified")); lastModified != "" {
		result.LastModified = &lastModified
	}
	return result
}

// ssrfSafeFetch is ssrfSafeFetch: manual redirect following with the shared
// SSRF rules applied to every hop.
func (s *Service) ssrfSafeFetch(ctx context.Context, targetURL, method string, headers map[string]string, timeoutMs int) (*http.Response, string, bool) {
	currentURL := targetURL
	for hop := 0; hop <= maxConditionalRedirectHops; hop++ {
		reason, ok := newssources.ValidateOutboundTargetURL(ctx, currentURL)
		if !ok {
			log.Printf("crawlexecution: blocked SSRF target during conditional preflight url=%s reason=%s", currentURL, reason)
			return nil, "", false
		}
		requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
		request, err := http.NewRequestWithContext(requestCtx, method, currentURL, nil)
		if err != nil {
			cancel()
			return nil, "", false
		}
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		response, err := s.http.Do(request)
		if err != nil {
			cancel()
			log.Printf("crawlexecution: conditional preflight request failed url=%s method=%s: %v", currentURL, method, err)
			return nil, "", false
		}
		cancel()
		location := strings.TrimSpace(response.Header.Get("location"))
		if response.StatusCode >= 300 && response.StatusCode < 400 && location != "" {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			_ = response.Body.Close()
			base, parseErr := url.Parse(currentURL)
			if parseErr != nil {
				return nil, "", false
			}
			next, resolveErr := url.Parse(location)
			if resolveErr != nil {
				return nil, "", false
			}
			currentURL = base.ResolveReference(next).String()
			continue
		}
		return response, currentURL, true
	}
	log.Printf("crawlexecution: too many redirects during conditional preflight url=%s", targetURL)
	return nil, "", false
}

// buildHTTPValidationMetadata is buildHttpValidationMetadata.
func buildHTTPValidationMetadata(outcome *conditionalPreflightOutcome) map[string]any {
	if outcome == nil || outcome.Status != "completed" || outcome.Result == nil {
		return nil
	}
	metadata := map[string]any{
		"httpValidationStatus":    outcome.Result.Status,
		"httpValidationMethod":    outcome.Result.Method,
		"httpValidationCheckedAt": outcome.Result.CheckedAt,
	}
	if outcome.Result.ETag != nil {
		metadata["httpEtag"] = *outcome.Result.ETag
	}
	if outcome.Result.LastModified != nil {
		metadata["httpLastModified"] = *outcome.Result.LastModified
	}
	return metadata
}

// attachHTTPValidationMetadata is attachHttpValidationMetadata: the
// etag/last-modified describe the target URL only, so detail-expansion articles
// are left untouched.
func attachHTTPValidationMetadata(successes []crawl4ai.PipelineArticle, metadata map[string]any, targetURL string) []crawl4ai.PipelineArticle {
	if len(metadata) == 0 || len(successes) == 0 {
		return successes
	}
	var targetFingerprint string
	if targetURL != "" {
		if canonical := buildCanonicalURLFingerprint(targetURL, nil); canonical != nil {
			targetFingerprint = canonical.Fingerprint
		}
	}
	attached := make([]crawl4ai.PipelineArticle, 0, len(successes))
	for _, article := range successes {
		if targetFingerprint != "" {
			articleURL := strings.TrimSpace(article.URL)
			if articleURL != "" {
				articleFingerprint := buildCanonicalURLFingerprint(articleURL, nil)
				if articleFingerprint == nil || articleFingerprint.Fingerprint != targetFingerprint {
					attached = append(attached, article)
					continue
				}
			}
		}
		merged := mergeRawObject(article.Metadata, metadata)
		article.Metadata = merged
		attached = append(attached, article)
	}
	return attached
}

// mergeRawObject merges string-keyed values into an existing JSON object while
// keeping the untouched leaves byte-for-byte.
func mergeRawObject(raw json.RawMessage, additions map[string]any) json.RawMessage {
	record := map[string]json.RawMessage{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &record)
	}
	if record == nil {
		record = map[string]json.RawMessage{}
	}
	for key, value := range additions {
		encoded, err := json.Marshal(value)
		if err != nil {
			continue
		}
		record[key] = encoded
	}
	merged, err := json.Marshal(record)
	if err != nil {
		return raw
	}
	return merged
}

// validationETag/validationLastModified read an optional validation state.
func validationETag(state *httpValidationState) *string {
	if state == nil {
		return nil
	}
	return state.ETag
}

func validationLastModified(state *httpValidationState) *string {
	if state == nil {
		return nil
	}
	return state.LastModified
}
