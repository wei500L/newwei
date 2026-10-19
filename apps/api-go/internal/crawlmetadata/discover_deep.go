package crawlmetadata

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// This file ports discoverDeepUrls/discoverDeepCandidates
// (crawl-metadata.service.ts:584-650), the crawl4ai breadth walk
// (discoverDeepCandidatesViaCrawl4ai, :947-1279) and
// normalizeDeepDiscoveryOptions (:910-945). Deep discovery requires crawl4ai:
// without a configured client the entry reports SEED_DEEP_CRAWL4AI_UNAVAILABLE.

// DeepDiscoveryInput is the discoverDeepUrls/discoverDeepCandidates argument set.
type DeepDiscoveryInput struct {
	URL              string
	Domain           string
	Pattern          string
	Query            string
	MaxURLs          *int
	RequestTimeoutMs *int
	// CrawlOptions is the raw node/source crawlOptions object.
	CrawlOptions json.RawMessage
	// Deep is the raw deep-discovery option object.
	Deep json.RawMessage
}

// DiscoverDeepURLs ports discoverDeepUrls.
func (d *Discovery) DiscoverDeepURLs(ctx context.Context, input DeepDiscoveryInput) ([]string, error) {
	candidates, err := d.DiscoverDeepCandidates(ctx, input)
	if err != nil {
		return nil, err
	}
	urls := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		urls = append(urls, candidate.URL)
	}
	return urls, nil
}

// DiscoverDeepCandidates ports discoverDeepCandidates.
func (d *Discovery) DiscoverDeepCandidates(ctx context.Context, input DeepDiscoveryInput) ([]DiscoveryCandidate, error) {
	seedURL, ok := normalizeURL(input.URL)
	if !ok {
		return []DiscoveryCandidate{}, nil
	}
	maxURLs := clampNumber(input.MaxURLs, 1, 2_000, 200)
	requestTimeoutMs := requestTimeout(input.RequestTimeoutMs, requestTimeoutMs)
	domain, _ := normalizeDomain(input.Domain)
	patternMatcher := normalizePattern(input.Pattern)
	queryTokens := tokenizeQuery(input.Query)
	crawlOptions, err := normalizeCrawlOptions(input.CrawlOptions)
	if err != nil {
		return nil, err
	}
	deep := normalizeDeepDiscoveryOptions(input.Deep)

	if d.crawlClient() == nil {
		return nil, &DiscoveryError{
			Code:    DiscoveryCodeCrawl4AIUnavailable,
			Message: "Deep discovery requires crawl4ai service, but crawl4ai client is unavailable.",
		}
	}

	viaCrawl4ai, err := d.discoverDeepCandidatesViaCrawl4ai(ctx, deepInput{
		seedURL:          seedURL,
		domain:           domain,
		maxURLs:          maxURLs,
		patternMatcher:   patternMatcher,
		queryTokens:      queryTokens,
		requestTimeoutMs: requestTimeoutMs,
		crawlOptions:     crawlOptions,
		deep:             deep,
	})
	if err != nil {
		return nil, err
	}
	if len(viaCrawl4ai) > 0 {
		return viaCrawl4ai, nil
	}

	return nil, &DiscoveryError{
		Code:    DiscoveryCodeEmptyResult,
		Message: "Deep discovery did not produce article URLs.",
		Detail:  "Adjust seed.deep.pattern/maxPages/maxDepth/headFetchTopK and retry.",
	}
}

// deepInput is the discoverDeepCandidatesViaCrawl4ai argument set.
type deepInput struct {
	seedURL          string
	domain           string
	maxURLs          int
	patternMatcher   func(string) bool
	queryTokens      []string
	requestTimeoutMs int
	crawlOptions     crawl4ai.CrawlOptions
	deep             DeepOptions
}

type deepPendingPage struct {
	url      string
	depth    int
	priority float64
}

type deepBatchResult struct {
	normalizedCurrentURL string
	nextPages            []deepPendingPage
	discoveredCandidates []deepDiscoveryCandidate
}

// discoverDeepCandidatesViaCrawl4ai ports the breadth walk. The candidate map
// and the visited/pending sets keep the source's de-duplication semantics; the
// batch worker order and the per-batch concurrency are unchanged.
func (d *Discovery) discoverDeepCandidatesViaCrawl4ai(ctx context.Context, input deepInput) ([]DiscoveryCandidate, error) {
	client := d.crawlClient()
	if client == nil {
		return nil, nil
	}
	settings := d.crawlSettings(ctx)

	allowedOrigin := input.domain
	if allowedOrigin == "" {
		if parsed, err := url.Parse(input.seedURL); err == nil {
			allowedOrigin = originOf(parsed)
		}
	}
	allowedOrigin = strings.TrimRight(allowedOrigin, "/")

	normalizedSeedURL := normalizeURLForComparisonOr(input.seedURL)
	startedAtMs := nowMillis()
	timeBudgetMs := int64(input.deep.TimeBudgetSeconds) * 1000
	pendingPages := []deepPendingPage{{url: input.seedURL, depth: 0, priority: 1}}
	pendingPageSet := map[string]bool{normalizedSeedURL: true}
	visitedPages := map[string]bool{}
	candidates := map[string]deepDiscoveryCandidate{}
	pagesCrawled := 0

	crawlOptions := input.crawlOptions
	crawlOptions.ExtractLinks = true
	crawlOptions.Prefetch = true

	for len(pendingPages) > 0 && pagesCrawled < input.deep.MaxPages && nowMillis()-startedAtMs < timeBudgetMs {
		sort.SliceStable(pendingPages, func(i, j int) bool {
			return pendingPages[i].priority > pendingPages[j].priority
		})
		remainingPageBudget := input.deep.MaxPages - pagesCrawled
		batchSize := maxInt(1, minInt(minInt(input.deep.PageConcurrency, len(pendingPages)), remainingPageBudget))
		batch := append([]deepPendingPage{}, pendingPages[:batchSize]...)
		pendingPages = pendingPages[batchSize:]
		for _, item := range batch {
			delete(pendingPageSet, normalizeURLForComparisonOr(item.url))
		}

		results, err := d.crawlDeepBatch(ctx, client, settings, batch, batchSize, input, crawlOptions, allowedOrigin, normalizedSeedURL)
		if err != nil {
			reason := strings.TrimSpace(err.Error())
			if reason == "" {
				reason = err.Error()
			}
			return nil, &DiscoveryError{
				Code:    DiscoveryCodeCrawlFailed,
				Message: "Deep discovery crawl failed: " + reason,
			}
		}

		pagesCrawled += len(batch)
		for _, result := range results {
			visitedPages[result.normalizedCurrentURL] = true

			for _, candidate := range result.discoveredCandidates {
				existing, found := candidates[candidate.URL]
				if !found {
					candidates[candidate.URL] = candidate
					continue
				}
				candidates[candidate.URL] = deepDiscoveryCandidate{
					URL:            candidate.URL,
					LinkScore:      math.Max(existing.LinkScore, candidate.LinkScore),
					RelevanceScore: maxRelevance(existing.RelevanceScore, candidate.RelevanceScore),
					PublishedAtTs:  resolveBetterTimestamp(existing.PublishedAtTs, candidate.PublishedAtTs),
					CrawledAtTs:    resolveBetterTimestamp(existing.CrawledAtTs, candidate.CrawledAtTs),
				}
			}

			for _, nextPage := range result.nextPages {
				if len(visitedPages)+len(pendingPages) >= input.deep.MaxPages {
					break
				}
				normalizedNext := normalizeURLForComparisonOr(nextPage.url)
				if visitedPages[normalizedNext] || pendingPageSet[normalizedNext] {
					continue
				}
				pendingPageSet[normalizedNext] = true
				pendingPages = append(pendingPages, nextPage)
			}
		}

		if len(candidates) > input.deep.CandidatePoolSize*2 {
			trimDeepCandidates(candidates, input.deep.CandidatePoolSize)
		}
	}

	ranked := rankDeepCandidates(candidates, input.deep)
	if len(ranked) == 0 {
		return nil, &DiscoveryError{
			Code:    DiscoveryCodeNoCandidate,
			Message: "Deep discovery found no article candidates.",
			Detail:  "Refine seed URL/pattern or increase discovery limits.",
		}
	}

	headTargets := []deepDiscoveryCandidate{}
	for _, candidate := range ranked {
		if candidate.PublishedAtTs == nil {
			headTargets = append(headTargets, candidate)
			if len(headTargets) >= input.deep.HeadFetchTopK {
				break
			}
		}
	}
	if len(headTargets) > 0 {
		concurrency := maxInt(1, minInt(input.deep.PageConcurrency, 5))
		timestamps := mapWithConcurrency(headTargets, concurrency, func(candidate deepDiscoveryCandidate) *int64 {
			return d.service.fetchPublishedAtTimestamp(ctx, candidate.URL, input.requestTimeoutMs)
		})
		for index, target := range headTargets {
			publishedAtTs := timestamps[index]
			if publishedAtTs == nil {
				continue
			}
			existing, found := candidates[target.URL]
			if !found {
				continue
			}
			existing.PublishedAtTs = publishedAtTs
			candidates[target.URL] = existing
		}
		ranked = rankDeepCandidates(candidates, input.deep)
	}

	limited := ranked
	if len(limited) > input.maxURLs {
		limited = limited[:input.maxURLs]
	}
	out := make([]DiscoveryCandidate, 0, len(limited))
	for _, candidate := range limited {
		out = append(out, DiscoveryCandidate{
			URL:            candidate.URL,
			RelevanceScore: candidate.RelevanceScore,
			PublishedAtTs:  candidate.PublishedAtTs,
			CrawledAtTs:    candidate.CrawledAtTs,
		})
	}
	return out, nil
}

// rankDeepCandidates applies the source filter (a published timestamp keeps the
// candidate, otherwise the link score must reach the threshold), sorts by
// compareDeepCandidates and slices to candidatePoolSize.
func rankDeepCandidates(candidates map[string]deepDiscoveryCandidate, deep DeepOptions) []deepDiscoveryCandidate {
	pool := make([]deepDiscoveryCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.PublishedAtTs != nil {
			pool = append(pool, candidate)
			continue
		}
		if candidate.LinkScore >= deep.ScoreThreshold {
			pool = append(pool, candidate)
		}
	}
	sortDeepCandidates(pool)
	if len(pool) > deep.CandidatePoolSize {
		pool = pool[:deep.CandidatePoolSize]
	}
	return pool
}

// crawlDeepBatch runs one bounded batch and returns the batch results in input
// order, aborting on the first crawl error like the source's Promise.all.
func (d *Discovery) crawlDeepBatch(
	ctx context.Context,
	client *crawl4ai.Client,
	settings crawl4ai.Settings,
	batch []deepPendingPage,
	batchSize int,
	input deepInput,
	crawlOptions crawl4ai.CrawlOptions,
	allowedOrigin string,
	normalizedSeedURL string,
) ([]deepBatchResult, error) {
	results := make([]deepBatchResult, len(batch))
	errs := make([]error, len(batch))
	limit := maxInt(1, minInt(batchSize, len(batch)))
	var cursor int64
	var mutex sync.Mutex
	var group sync.WaitGroup
	for worker := 0; worker < limit; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				mutex.Lock()
				index := int(cursor)
				cursor++
				mutex.Unlock()
				if index >= len(batch) {
					return
				}
				results[index], errs[index] = d.crawlDeepPage(ctx, client, settings, batch[index], input, crawlOptions, allowedOrigin, normalizedSeedURL)
			}
		}()
	}
	group.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return results, nil
}

func (d *Discovery) crawlDeepPage(
	ctx context.Context,
	client *crawl4ai.Client,
	settings crawl4ai.Settings,
	current deepPendingPage,
	input deepInput,
	crawlOptions crawl4ai.CrawlOptions,
	allowedOrigin string,
	normalizedSeedURL string,
) (deepBatchResult, error) {
	normalizedCurrentURL := normalizeURLForComparisonOr(current.url)
	result := deepBatchResult{normalizedCurrentURL: normalizedCurrentURL}
	response, err := client.Crawl(ctx, crawl4ai.CrawlRequest{URL: current.url, Options: crawlOptions}, settings)
	if err != nil {
		return result, err
	}
	crawledAtTs := nowMillis()
	article, ok := selectDiscoveryResultArticle(response.Results, normalizedCurrentURL)
	if !ok || article.Success == nil || !*article.Success {
		return result, nil
	}
	if len(article.Links) == 0 {
		return result, nil
	}

	nextPages := []deepPendingPage{}
	discovered := []deepDiscoveryCandidate{}
	seenNextPages := map[string]bool{}
	seenCandidates := map[string]bool{}

	for _, entry := range article.Links {
		normalized, ok := normalizeDeepDiscoveryLink(entry, current.url)
		if !ok {
			continue
		}
		if normalized.URL == normalizedSeedURL || normalized.URL == normalizedCurrentURL {
			continue
		}
		if allowedOrigin != "" && !strings.HasPrefix(normalized.URL, allowedOrigin+"/") && normalized.URL != allowedOrigin {
			continue
		}

		var matchesPattern *bool
		if input.patternMatcher != nil {
			matched := input.patternMatcher(normalized.URL)
			matchesPattern = &matched
		}
		isPagination := isLikelyPaginationLink(normalized.URL, current.url, normalized.AnchorText, normalized.Rel)
		isHub := input.deep.EnableSecondaryHubs && isLikelySecondaryHubLink(normalized.URL, normalized.AnchorText)
		articleLike := isLikelyArticleURL(normalized.URL)
		if matchesPattern != nil {
			articleLike = *matchesPattern
		}
		relevanceScore := computeLinkRelevance(normalized.URL, normalized.AnchorText, input.queryTokens)

		if articleLike && !seenCandidates[normalized.URL] {
			seenCandidates[normalized.URL] = true
			var publishedAtTs *int64
			if input.deep.PreferPathDate {
				publishedAtTs = parsePublishedAtFromURL(normalized.URL)
			}
			discovered = append(discovered, deepDiscoveryCandidate{
				URL:            normalized.URL,
				LinkScore:      normalized.LinkScore,
				RelevanceScore: relevanceScore,
				PublishedAtTs:  publishedAtTs,
				CrawledAtTs:    &crawledAtTs,
			})
		}

		if current.depth >= input.deep.MaxDepth || (!isPagination && !isHub) {
			continue
		}
		if seenNextPages[normalized.URL] {
			continue
		}
		seenNextPages[normalized.URL] = true
		priority := normalized.LinkScore
		if relevanceScore != nil {
			priority += *relevanceScore
		}
		nextPages = append(nextPages, deepPendingPage{url: normalized.URL, depth: current.depth + 1, priority: priority})
	}

	result.nextPages = nextPages
	result.discoveredCandidates = discovered
	return result, nil
}

func maxRelevance(left, right *float64) *float64 {
	leftValue := 0.0
	if left != nil {
		leftValue = *left
	}
	rightValue := 0.0
	if right != nil {
		rightValue = *right
	}
	value := math.Max(leftValue, rightValue)
	return &value
}

// normalizeDeepDiscoveryOptions ports normalizeDeepDiscoveryOptions. A nil,
// scalar or array input is the empty object.
func normalizeDeepDiscoveryOptions(raw json.RawMessage) DeepOptions {
	record := decodeRawObject(raw)
	defaults := DefaultDeepOptions()
	return DeepOptions{
		MaxPages:            clampRoundedNumber(record["maxPages"], 5, 300, defaults.MaxPages),
		MaxDepth:            clampRoundedNumber(record["maxDepth"], 1, 4, defaults.MaxDepth),
		TimeBudgetSeconds:   clampRoundedNumber(record["timeBudgetSeconds"], 10, 180, defaults.TimeBudgetSeconds),
		PageConcurrency:     clampRoundedNumber(record["pageConcurrency"], 1, 6, defaults.PageConcurrency),
		ScoreThreshold:      deepScoreThreshold(record["scoreThreshold"]),
		CandidatePoolSize:   clampRoundedNumber(record["candidatePoolSize"], 20, 400, defaults.CandidatePoolSize),
		HeadFetchTopK:       clampRoundedNumber(record["headFetchTopK"], 10, 120, defaults.HeadFetchTopK),
		PreferPathDate:      boolValueOrDefault(record["preferPathDate"], true),
		EnableSecondaryHubs: boolValueOrDefault(record["enableSecondaryHubs"], true),
		IgnoreRobotsTxt:     true,
	}
}

func deepScoreThreshold(raw json.RawMessage) float64 {
	value, ok := rawNumberValue(raw)
	if !ok {
		return 0.2
	}
	return clampFloatValue(roundTo(value, 3), 0, 1)
}

func decodeRawObject(raw json.RawMessage) map[string]json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return map[string]json.RawMessage{}
	}
	record := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return map[string]json.RawMessage{}
	}
	return record
}

func rawNumberValue(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	switch trimmed[0] {
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
	default:
		return 0, false
	}
	var value float64
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

func clampRoundedNumber(raw json.RawMessage, min, max, fallback int) int {
	value, ok := rawNumberValue(raw)
	if !ok {
		return fallback
	}
	rounded := int(roundTo(value, 0))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

func boolValueOrDefault(raw json.RawMessage, fallback bool) bool {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "true":
		return true
	case "false":
		return false
	}
	return fallback
}

func clampFloatValue(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// deepTimeBudgetElapsed is a small seam so tests can assert the budget check
// without sleeping.
func deepTimeBudgetElapsed(startedAtMs int64, timeBudgetMs int64) bool {
	return time.Now().UnixMilli()-startedAtMs >= timeBudgetMs
}
