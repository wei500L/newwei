package crawl4ai

// Pipeline crawl client extension.
//
// The discovery chain only needs the normalized markdown/links projection
// (CrawlResponse). The crawl execution port (internal/crawlexecution) needs the
// whole /crawl result instead: the markdown variant object (raw_markdown,
// markdown_with_citations, references_markdown, fit_markdown), publishedAt,
// media, tables, runId, nextCursor and the server memory stats, because those
// values are written to CrawlResultContent / CrawlResult by the ported
// CrawlResultService.persistResults.
//
// This file adds a second entry point on the same Client instead of changing
// the existing Crawl contract: health check, SSRF validation, payload build,
// timeout resolution, the prefetch-compatibility fallback and the
// scanFullPage bounded-virtualScroll fallback are all shared with Crawl.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// PipelineRequest is one /crawl call with the multi-URL form Crawl4aiRequest
// supports (urls is the target list, url is the primary target used as the
// buildPayload base).
type PipelineRequest struct {
	URL              string
	URLs             []string
	Keywords         []string
	Options          CrawlOptions
	RequestTimeoutMs int
}

// PipelineArticle is one raw /crawl result entry. Markdown/links/metadata/media/
// tables/publishedAt stay raw because CrawlResultService treats them as open
// leaves.
type PipelineArticle struct {
	URL         string
	Success     *bool
	StatusCode  *int
	Error       string
	Links       json.RawMessage
	Markdown    json.RawMessage
	Metadata    json.RawMessage
	PublishedAt json.RawMessage
	Media       json.RawMessage
	Tables      json.RawMessage
}

// PipelineResponse is the /crawl envelope plus the fields runTask persists
// (runId/nextCursor/memory stats) or reads (warnings/systemEvents).
type PipelineResponse struct {
	Results          []PipelineArticle
	Warnings         []string
	SystemEvents     []SystemEvent
	RunID            string
	NextCursor       *string
	ServerMemoryMB   *float64
	PeakMemoryMB     *float64
	MemoryEfficiency *float64
}

type pipelineRawResponse struct {
	Results          []pipelineRawArticle `json:"results"`
	Warnings         []string             `json:"warnings"`
	SystemEvents     []SystemEvent        `json:"systemEvents"`
	RunID            *string              `json:"runId"`
	NextCursor       *string              `json:"nextCursor"`
	ServerMemoryMB   *float64             `json:"serverMemoryMb"`
	PeakMemoryMB     *float64             `json:"peakMemoryMb"`
	MemoryEfficiency *float64             `json:"memoryEfficiency"`
}

type pipelineRawArticle struct {
	URL             string          `json:"url"`
	Success         *bool           `json:"success"`
	StatusCode      *int            `json:"statusCode"`
	StatusCodeSnake *int            `json:"status_code"`
	Error           string          `json:"error"`
	ErrorMessage    string          `json:"errorMessage"`
	ErrorMessageSn  string          `json:"error_message"`
	Links           json.RawMessage `json:"links"`
	Markdown        json.RawMessage `json:"markdown"`
	Metadata        json.RawMessage `json:"metadata"`
	PublishedAt     json.RawMessage `json:"publishedAt"`
	Media           json.RawMessage `json:"media"`
	Tables          json.RawMessage `json:"tables"`
}

// CrawlPipeline posts one /crawl request and returns the raw result projection.
// Errors are classified exactly like Crawl: prefetch compatibility and
// scanFullPage fallbacks are retried once, and the returned error is a *Error
// when the failure can be attributed to the request or the service.
func (c *Client) CrawlPipeline(ctx context.Context, request PipelineRequest, settings Settings) (PipelineResponse, error) {
	timeoutMs := resolveRequestTimeout(request.RequestTimeoutMs, settings)
	if err := c.ensureHealthy(ctx, settings); err != nil {
		return PipelineResponse{}, err
	}

	urls := pipelineTargets(request)
	if len(urls) == 0 {
		return PipelineResponse{}, newError(http.StatusBadRequest, "crawl4ai request has no target URL")
	}
	if err := c.validateRequestURLs(ctx, urls); err != nil {
		return PipelineResponse{}, err
	}

	base := CrawlRequest{
		URL:              urls[0],
		Keywords:         request.Keywords,
		Options:          request.Options,
		RequestTimeoutMs: request.RequestTimeoutMs,
	}
	payload, err := buildPayload(base, c.options.SSRFProxyURL, c.options.JSCodeEnabled)
	if err != nil {
		return PipelineResponse{}, err
	}
	// buildPayload always writes a single target; overwrite it with the exact
	// target list NestJS toHttpPayload sends.
	payload.URLs = urls

	response, err := c.sendPipeline(ctx, payload, timeoutMs)
	if err == nil {
		return response, nil
	}

	resolvedError := err
	resolvedPayload := payload
	if compatibility, ok := prefetchCompatibilityPayload(payload, err); ok {
		retried, retryErr := c.sendPipeline(ctx, compatibility, timeoutMs)
		if retryErr == nil {
			retried.SystemEvents = append(retried.SystemEvents, SystemEvent{
				Level:         "warn",
				EventType:     "prefetch_compatibility_fallback",
				Message:       "crawl4ai server rejected prefetch; retried without prefetch",
				TriggerReason: stringPtr("prefetch_incompatible"),
				BeforeCount:   intPtr(1),
				AfterCount:    intPtr(1),
				RescuedCount:  intPtr(1),
				Details:       rawObject(map[string]string{"requestUrl": urls[0], "fallbackMode": "disable_prefetch"}),
				Timestamp:     nestNow(c.now()),
			})
			return retried, nil
		}
		resolvedError = retryErr
		resolvedPayload = compatibility
	}

	if fallback, ok := scanFullPageFallbackPayload(base, resolvedPayload, resolvedError); ok {
		retried, retryErr := c.sendPipeline(ctx, fallback, timeoutMs)
		if retryErr == nil {
			triggerReason := "scan_full_page_failure"
			if isTimeoutError(resolvedError) {
				triggerReason = "scan_full_page_timeout"
			}
			retried.SystemEvents = append(retried.SystemEvents, SystemEvent{
				Level:         "warn",
				EventType:     "scan_full_page_virtual_scroll_fallback",
				Message:       "scanFullPage failed or timed out; retried with bounded virtualScroll",
				TriggerReason: &triggerReason,
				BeforeCount:   intPtr(1),
				AfterCount:    intPtr(1),
				RescuedCount:  intPtr(1),
				Details:       rawObject(map[string]string{"requestUrl": urls[0], "fallbackMode": "bounded_virtual_scroll"}),
				Timestamp:     nestNow(c.now()),
			})
			return retried, nil
		}
		resolvedError = retryErr
	}

	return PipelineResponse{}, classifyError(base, resolvedError, timeoutMs)
}

// pipelineTargets mirrors toHttpPayload's url list resolution: request.urls
// wins, otherwise the single request.url; values are trimmed and empty entries
// dropped.
func pipelineTargets(request PipelineRequest) []string {
	source := request.URLs
	if len(source) == 0 {
		if strings.TrimSpace(request.URL) == "" {
			return nil
		}
		source = []string{request.URL}
	}
	targets := make([]string, 0, len(source))
	seen := map[string]struct{}{}
	for _, entry := range source {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		targets = append(targets, trimmed)
	}
	return targets
}

// sendPipeline is send() returning the raw body decode instead of the
// normalized markdown/links projection.
func (c *Client) sendPipeline(ctx context.Context, payload httpPayload, timeoutMs int) (PipelineResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return PipelineResponse{}, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, c.options.BaseURL+"/crawl", bytes.NewReader(body))
	if err != nil {
		return PipelineResponse{}, err
	}
	c.applyHeaders(request)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return PipelineResponse{}, err
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return PipelineResponse{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return PipelineResponse{}, &httpStatusError{status: response.StatusCode, body: data}
	}
	return normalizePipelineResponse(data)
}

// normalizePipelineResponse decodes the /crawl body keeping the open leaves the
// result writer needs. System events are filtered exactly like
// normalizeCrawlResponse.
func normalizePipelineResponse(data []byte) (PipelineResponse, error) {
	var decoded pipelineRawResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		return PipelineResponse{}, &httpStatusError{status: 0, body: nil}
	}
	response := PipelineResponse{
		Results:          make([]PipelineArticle, 0, len(decoded.Results)),
		Warnings:         decoded.Warnings,
		SystemEvents:     make([]SystemEvent, 0, len(decoded.SystemEvents)),
		NextCursor:       decoded.NextCursor,
		ServerMemoryMB:   decoded.ServerMemoryMB,
		PeakMemoryMB:     decoded.PeakMemoryMB,
		MemoryEfficiency: decoded.MemoryEfficiency,
	}
	if response.Warnings == nil {
		response.Warnings = []string{}
	}
	if decoded.RunID != nil {
		response.RunID = *decoded.RunID
	}
	for _, event := range decoded.SystemEvents {
		if event.Level == "" || event.EventType == "" || event.Message == "" || event.Timestamp == "" {
			continue
		}
		response.SystemEvents = append(response.SystemEvents, event)
	}
	for _, entry := range decoded.Results {
		article := PipelineArticle{
			URL:         entry.URL,
			Success:     entry.Success,
			Links:       trimSpace(entry.Links),
			Markdown:    trimSpace(entry.Markdown),
			Metadata:    trimSpace(entry.Metadata),
			PublishedAt: trimSpace(entry.PublishedAt),
			Media:       trimSpace(entry.Media),
			Tables:      trimSpace(entry.Tables),
		}
		switch {
		case entry.StatusCode != nil:
			article.StatusCode = entry.StatusCode
		case entry.StatusCodeSnake != nil:
			article.StatusCode = entry.StatusCodeSnake
		}
		article.Error = firstNonEmpty(entry.ErrorMessage, entry.ErrorMessageSn, entry.Error)
		response.Results = append(response.Results, article)
	}
	return response, nil
}
