package crawlmetadata

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Service owns the metadata preview chain: sitemap/robots discovery through the
// shared conditional HTTP state cache, real page fetches with per-hop SSRF
// validation, HTML head parsing and relevance scoring. It reads no business
// table; the database handle is used only to resolve `mtk_` machine tokens for
// the HTTP entry, exactly like the sibling crawl read handlers.
type Service struct {
	db     *sql.DB
	redis  *redis.Client
	client *http.Client
	// state is the shared conditional HTTP state store used only for
	// robots/sitemap discovery. It defaults to Redis and is replaceable in
	// tests.
	state discoveryStateStore
}

// NewService assembles the service around the shared MySQL, Redis and HTTP
// resources. The Redis client may be nil, in which case the conditional cache
// degrades to a plain fetch.
func NewService(db *sql.DB, redisClient *redis.Client) *Service {
	return &Service{
		db:     db,
		redis:  redisClient,
		client: newMetadataHTTPClient(),
		state:  redisDiscoveryState{redis: redisClient},
	}
}

// NewServiceWithHTTPClient is NewService with a caller-supplied HTTP client. It
// is the narrow seam the Frontier node integration test uses to answer
// robots/sitemap requests from an in-process transport. Only the client is
// replaced; every request still goes through fetchWithStatus and therefore its
// per-hop SSRF validation and manual redirect checks. A nil client keeps the
// production client.
func NewServiceWithHTTPClient(db *sql.DB, redisClient *redis.Client, client *http.Client) *Service {
	service := NewService(db, redisClient)
	if client != nil {
		service.client = client
	}
	return service
}

// newMetadataHTTPClient builds the client used for every outbound request. Go's
// automatic redirect following is disabled so each hop can be validated; the
// transport keeps its default transparent gzip handling.
func newMetadataHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (s *Service) httpClient() *http.Client {
	if s == nil || s.client == nil {
		return http.DefaultClient
	}
	return s.client
}

// Extract runs the whole chain for both entries: normalize, resolve the target
// URLs, fetch every page with bounded concurrency, apply the optional score
// threshold and slice to maxUrls. Results stay in discovery/input order; a
// failed page is a failed item and never fails the batch.
func (s *Service) Extract(ctx context.Context, input ExtractionInput) ([]Result, error) {
	config, err := normalizeInput(input)
	if err != nil {
		return nil, err
	}
	urls, err := s.resolveURLs(ctx, config)
	if err != nil {
		return nil, err
	}
	if len(urls) == 0 {
		return []Result{}, nil
	}

	results := mapWithConcurrency(urls, config.concurrency, func(url string) Result {
		return s.fetchMetadata(ctx, url, config)
	})

	if config.scoreThreshold > 0 {
		filtered := make([]Result, 0, len(results))
		for _, result := range results {
			score := 0.0
			if result.RelevanceScore != nil {
				score = *result.RelevanceScore
			}
			// (result.relevanceScore ?? 0) >= threshold: failed items and
			// query-less results score 0 and are filtered out.
			if score >= config.scoreThreshold {
				filtered = append(filtered, result)
			}
		}
		results = filtered
	}
	return sliceUpTo(results, config.maxURLs), nil
}

// fetchMetadata fetches one page directly. It never uses the robots/sitemap
// conditional cache: a page result must be the current page content.
func (s *Service) fetchMetadata(ctx context.Context, url string, config normalizedConfig) Result {
	response, err := s.fetchWithStatus(ctx, url, config.requestTimeoutMs, nil)
	if err != nil {
		return failedResult(url, err.Error())
	}
	if !response.HasBody {
		return failedResult(url, "Metadata response body missing")
	}
	parsed := parseMetadata(response.Body, config)
	fetchedAt := time.Now().UTC()
	return Result{
		URL:            url,
		Status:         StatusSuccess,
		HTTPStatus:     &response.Status,
		FetchedAt:      &fetchedAt,
		Title:          parsed.Title,
		Description:    parsed.Description,
		Keywords:       parsed.Keywords,
		Author:         parsed.Author,
		MetaTags:       parsed.MetaTags,
		OpenGraph:      parsed.OpenGraph,
		JSONLd:         parsed.JSONLd,
		RelevanceScore: computeRelevance(url, parsed, config.queryTokens),
	}
}

// failedResult is the failed item shape: the three list fields are empty and
// httpStatus/fetchedAt stay absent.
func failedResult(url, message string) Result {
	errorText := message
	return Result{
		URL:       url,
		Status:    StatusFailed,
		MetaTags:  []Tag{},
		OpenGraph: []Tag{},
		JSONLd:    []string{},
		Error:     &errorText,
	}
}

// computeRelevance joins url, title and description, lowercases them and counts
// the query tokens that appear. No query means no score; the ratio keeps three
// decimals.
func computeRelevance(url string, parsed parsedMetadata, tokens []string) *float64 {
	if len(tokens) == 0 {
		return nil
	}
	title := ""
	description := ""
	if parsed.Title != nil {
		title = *parsed.Title
	}
	if parsed.Description != nil {
		description = *parsed.Description
	}
	haystack := strings.ToLower(url + " " + title + " " + description)
	if strings.TrimSpace(haystack) == "" {
		zero := 0.0
		return &zero
	}
	hits := 0
	for _, token := range tokens {
		if strings.Contains(haystack, token) {
			hits++
		}
	}
	score := roundTo(float64(hits)/float64(len(tokens)), 3)
	return &score
}

// mapWithConcurrency runs worker over items with at most concurrency goroutines
// and stores each result at its input index, so the output order never depends
// on completion order.
func mapWithConcurrency[T any, R any](items []T, concurrency int, worker func(T) R) []R {
	if len(items) == 0 {
		return []R{}
	}
	results := make([]R, len(items))
	limit := maxInt(1, minInt(concurrency, len(items)))
	var cursor int64
	var group sync.WaitGroup
	for i := 0; i < limit; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				index := int(atomic.AddInt64(&cursor, 1)) - 1
				if index >= len(items) {
					return
				}
				results[index] = worker(items[index])
			}
		}()
	}
	group.Wait()
	return results
}
