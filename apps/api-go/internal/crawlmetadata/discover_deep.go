package crawlmetadata

import (
	"context"
	"encoding/json"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// This file ports normalizeDeepDiscoveryOptions, discoverDeepUrls,
// discoverDeepCandidates and discoverDeepCandidatesViaCrawl4ai
// (apps/api/src/modules/crawl/crawl-metadata.service.ts:584-650, :910-1289).
//
// Request rhythm: the crawl is bounded twice — by maxPages crawled pages and by
// timeBudgetSeconds wall clock — and at most pageConcurrency crawl4ai calls run
// at once. After the crawl, only the ranked candidates that still lack a
// published timestamp get one direct head fetch, at most headFetchTopK of them
// and at most five at a time. No request is retried.
//
// Failure semantics: a crawl error aborts the whole call with
// SEED_DEEP_CRAWL_FAILED, an empty result with SEED_DEEP_EMPTY_RESULT and no
// ranked candidate with SEED_DEEP_NO_CANDIDATE. The preview catches these codes
// and reports them; the workflow runtime lets them fail the node.

// DeepDiscoveryInput is the discoverDeepUrls/discoverDeepCandidates argument set.
type DeepDiscoveryInput struct {
	URL              string
	Domain           string
	Pattern          string
	Query            string
	MaxURLs          *int
	RequestTimeoutMs *int
	CrawlOptions     json.RawMessage
	// Deep is an already normalized option set (news-source seed config).
	Deep *DeepOptions
	// RawDeep is the node-config `deep` object; it is normalized only when Deep
	// is nil.
	RawDeep json.RawMessage
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
	maxURLs := clampNumber(input.MaxURLs, 1, 2000, 200)
	requestTimeoutMs := 15_000
	if input.RequestTimeoutMs != nil {
		requestTimeoutMs = maxInt(1000, *input.RequestTimeoutMs)
	}
	domain, hasDomain := normalizeDomain(input.Domain)
	if !hasDomain {
		domain = ""
	}
	patternMatcher := normalizePattern(input.Pattern)
	queryTokens := tokenizeQuery(input.Query)
	options, err := ParseCrawlOptions(input.CrawlOptions)
	if err != nil {
		return nil, err
	}
	deep := DefaultDeepOptions()
	if input.Deep != nil {
		deep = *input.Deep
	} else {
		deep = NormalizeDeepOptions(input.RawDeep)
	}

	if d.crawlClient() == nil {
		return nil, &DiscoveryError{
			Code:    DiscoveryCodeCrawl4AIUnavailable,
			Message: "Deep discovery requires crawl4ai service, but crawl4ai client is unavailable.",
		}
	}

	viaCrawl4AI, err := d.discoverDeepCandidatesViaCrawl4AI(ctx, deepCrawlInput{
		seedURL:          seedURL,
		domain:           domain,
		patternMatcher:   patternMatcher,
		queryTokens:      queryTokens,
		requestTimeoutMs: requestTimeoutMs,
		maxURLs:          maxURLs,
		options:          options,
		deep:             deep,
	})
	if err != nil {
		return nil, err
	}
	if len(viaCrawl4AI) > 0 {
		return viaCrawl4AI, nil
	}
	return nil, &DiscoveryError{
		Code:    DiscoveryCodeEmptyResult,
		Message: "Deep discovery did not produce article URLs.",
		Detail:  "Adjust seed.deep.pattern/maxPages/maxDepth/headFetchTopK and retry.",
	}
}

// NormalizeDeepOptions ports normalizeDeepDiscoveryOptions.
func NormalizeDeepOptions(raw json.RawMessage) DeepOptions {
	defaults := DefaultDeepOptions()
	fields, ok := decodeRawObject(raw)
	if !ok {
		return defaults
	}
	resolved := DeepOptions{
		MaxPages:            clampIntField(fields["maxPages"], 5, 300, defaults.MaxPages),
		MaxDepth:            clampIntField(fields["maxDepth"], 1, 4, defaults.MaxDepth),
		TimeBudgetSeconds:   clampIntField(fields["timeBudgetSeconds"], 10, 180, defaults.TimeBudgetSeconds),
		PageConcurrency:     clampIntField(fields["pageConcurrency"], 1, 6, defaults.PageConcurrency),
		ScoreThreshold:      clampScoreField(fields["scoreThreshold"], defaults.ScoreThreshold),
		CandidatePoolSize:   clampIntField(fields["candidatePoolSize"], 20, 400, defaults.CandidatePoolSize),
		HeadFetchTopK:       clampIntField(fields["headFetchTopK"], 10, 120, defaults.HeadFetchTopK),
		PreferPathDate:      true,
		EnableSecondaryHubs: true,
		// The crawl4ai client always sends check_robots_txt=false, so this stays
		// hard-locked.
		IgnoreRobotsTxt: true,
	}
	if value := rawBool(fields["preferPathDate"]); value != nil {
		resolved.PreferPathDate = *value
	}
	if value := rawBool(fields["enableSecondaryHubs"]); value != nil {
		resolved.EnableSecondaryHubs = *value
	}
	return resolved
}

func clampIntField(raw json.RawMessage, min, max, fallback int) int {
	value, ok := rawNumberValue(raw)
	if !ok {
		return fallback
	}
	rounded := int(jsRound(value))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

// clampScoreField mirrors `Math.max(0, Math.min(1, Number(value.toFixed(3))))`.
func clampScoreField(raw json.RawMessage, fallback float64) float64 {
	value, ok := rawNumberValue(raw)
	if !ok {
		return fallback
	}
	rounded := roundTo(value, 3)
	if rounded < 0 {
		return 0
	}
	if rounded > 1 {
		return 1
	}
	return rounded
}

// deepCrawlInput is the discoverDeepCandidatesViaCrawl4ai argument set.
type deepCrawlInput struct {
	seedURL          string
	domain           string
	patternMatcher   func(string) bool
	queryTokens      []string
	requestTimeoutMs int
	maxURLs          int
	options          crawl4ai.CrawlOptions
	deep             DeepOptions
}

// deepPendingPage is one queue entry of the breadth-first crawl.
type deepPendingPage struct {
	url      string
	depth    int
	priority float64
}

// deepBatchResult is one crawled page outcome. err carries the classified crawl
// failure so the caller can abort the whole deep discovery, like the source's
// outer try/catch.
type deepBatchResult struct {
	normalizedURL        string
	nextPages            []deepPendingPage
	discoveredCandidates []deepDiscoveryCandidate
	err                  error
}

// discoverDeepCandidatesViaCrawl4AI ports discoverDeepCandidatesViaCrawl4ai.
func (d *Discovery) discoverDeepCandidatesViaCrawl4AI(ctx context.Context, input deepCrawlInput) ([]DiscoveryCandidate, error) {
	client := d.crawlClient()
	if client == nil {
		return nil, nil
	}

	allowedOrigin := input.domain
	if allowedOrigin == "" {
		if parsed, err := url.Parse(input.seedURL); err == nil {
			allowedOrigin = parsed.Scheme + "://" + parsed.Host
		}
	}
	allowedOrigin = strings.TrimRight(allowedOrigin, "/")

	normalizedSeedURL := stripFragment(input.seedURL)
	startedAt := time.Now()
	timeBudget := time.Duration(input.deep.TimeBudgetSeconds) * time.Second

	pending := []deepPendingPage{{url: input.seedURL, depth: 0, priority: 1}}
	pendingSet := map[string]bool{normalizedSeedURL: true}
	visited := map[string]bool{}
	candidates := map[string]deepDiscoveryCandidate{}
	pagesCrawled := 0

	// Deep discovery always asks for link scoring: a workflow or seed config may
	// disable it, in which case the queue priority falls back to relevance and
	// depth alone.
	options := input.options
	options.Prefetch = boolPtr(true)
	if options.ScoreLinks == nil {
		options.ScoreLinks = boolPtr(true)
	}
	settings := d.crawlSettings(ctx)

	for len(pending) > 0 && pagesCrawled < input.deep.MaxPages && time.Since(startedAt) < timeBudget {
		sort.SliceStable(pending, func(i, j int) bool {
			return pending[i].priority > pending[j].priority
		})
		remainingBudget := input.deep.MaxPages - pagesCrawled
		batchSize := maxInt(1, minInt(input.deep.PageConcurrency, minInt(len(pending), remainingBudget)))
		batch := make([]deepPendingPage, batchSize)
		copy(batch, pending[:batchSize])
		pending = pending[batchSize:]
		for _, item := range batch {
			delete(pendingSet, stripFragment(item.url))
		}

		batchResults := mapWithConcurrency(batch, batchSize, func(current deepPendingPage) deepBatchResult {
			return d.crawlDeepPage(ctx, client, settings, deepPageInput{
				current:           current,
				normalizedSeedURL: normalizedSeedURL,
				allowedOrigin:     allowedOrigin,
				patternMatcher:    input.patternMatcher,
				queryTokens:       input.queryTokens,
				deep:              input.deep,
				options:           options,
			})
		})

		pagesCrawled += len(batch)
		for _, result := range batchResults {
			if result.err != nil {
				return nil, &DiscoveryError{
					Code:    DiscoveryCodeCrawlFailed,
					Message: "Deep discovery crawl failed: " + crawlFailureReason(result.err),
					Detail:  "",
				}
			}
			visited[result.normalizedURL] = true
			for _, candidate := range result.discoveredCandidates {
				existing, ok := candidates[candidate.urlKey()]
				if !ok {
					candidates[candidate.urlKey()] = candidate
					continue
				}
				candidates[candidate.urlKey()] = mergeDeepCandidate(existing, candidate)
			}
			for _, nextPage := range result.nextPages {
				if len(visited)+len(pending) >= input.deep.MaxPages {
					break
				}
				normalizedNext := stripFragment(nextPage.url)
				if visited[normalizedNext] || pendingSet[normalizedNext] {
					continue
				}
				pendingSet[normalizedNext] = true
				pending = append(pending, nextPage)
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
		if candidate.PublishedAtTs != nil {
			continue
		}
		headTargets = append(headTargets, candidate)
		if len(headTargets) >= input.deep.HeadFetchTopK {
			break
		}
	}
	if len(headTargets) > 0 {
		publishTimestamps := mapWithConcurrency(headTargets, maxInt(1, minInt(input.deep.PageConcurrency, 5)), func(candidate deepDiscoveryCandidate) *int64 {
			return d.service.fetchPublishedAtTimestamp(ctx, candidate.URL, input.requestTimeoutMs)
		})
		for index, target := range headTargets {
			publishedAtTs := publishTimestamps[index]
			if publishedAtTs == nil {
				continue
			}
			existing, ok := candidates[target.URL]
			if !ok {
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

// deepPageInput is the crawlDeepPage argument set.
type deepPageInput struct {
	current           deepPendingPage
	normalizedSeedURL string
	allowedOrigin     string
	patternMatcher    func(string) bool
	queryTokens       []string
	deep              DeepOptions
	options           crawl4ai.CrawlOptions
}

// crawlDeepPage crawls one queued page and turns its links into candidates and
// next queue entries. A crawl error aborts the whole deep discovery with
// SEED_DEEP_CRAWL_FAILED, like the source's outer try/catch.
func (d *Discovery) crawlDeepPage(ctx context.Context, client *crawl4ai.Client, settings crawl4ai.Settings, input deepPageInput) deepBatchResult {
	normalizedCurrentURL := stripFragment(input.current.url)
	response, err := client.Crawl(ctx, crawl4ai.CrawlRequest{
		URL:     input.current.url,
		Options: input.options,
	}, settings)
	if err != nil {
		return deepBatchResult{normalizedURL: normalizedCurrentURL, err: err}
	}
	crawledAtTs := nowMillis()
	article, ok := selectDiscoveryResultArticle(response.Results, normalizedCurrentURL)
	if !ok || article.Success == nil || !*article.Success || len(article.Links) == 0 {
		return deepBatchResult{normalizedURL: normalizedCurrentURL}
	}

	nextPages := []deepPendingPage{}
	discovered := []deepDiscoveryCandidate{}
	seenNext := map[string]bool{}
	seenCandidates := map[string]bool{}

	for _, entry := range article.Links {
		normalized, ok := normalizeDeepDiscoveryLink(entry, input.current.url)
		if !ok {
			continue
		}
		if normalized.URL == input.normalizedSeedURL || normalized.URL == normalizedCurrentURL {
			continue
		}
		if input.allowedOrigin != "" && !strings.HasPrefix(normalized.URL, input.allowedOrigin+"/") && normalized.URL != input.allowedOrigin {
			continue
		}

		matchesPattern := true
		if input.patternMatcher != nil {
			matchesPattern = input.patternMatcher(normalized.URL)
		}
		isPagination := isLikelyPaginationLink(normalized.URL, input.current.url, normalized.AnchorText, normalized.Rel)
		isHub := input.deep.EnableSecondaryHubs && isLikelySecondaryHubLink(normalized.URL, normalized.AnchorText)
		articleLike := matchesPattern
		if input.patternMatcher == nil {
			articleLike = isLikelyArticleURL(normalized.URL)
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

		if input.current.depth >= input.deep.MaxDepth || (!isPagination && !isHub) {
			continue
		}
		if seenNext[normalized.URL] {
			continue
		}
		seenNext[normalized.URL] = true
		priority := normalized.LinkScore
		if relevanceScore != nil {
			priority += *relevanceScore
		}
		nextPages = append(nextPages, deepPendingPage{
			url:      normalized.URL,
			depth:    input.current.depth + 1,
			priority: priority,
		})
	}

	return deepBatchResult{
		normalizedURL:        normalizedCurrentURL,
		nextPages:            nextPages,
		discoveredCandidates: discovered,
	}
}

// crawlFailureReason mirrors the source's `error.message` fallback chain.
func crawlFailureReason(err error) string {
	if err == nil {
		return ""
	}
	if message := strings.TrimSpace(err.Error()); message != "" {
		return message
	}
	return "unknown error"
}

// urlKey is the candidate map key.
func (c deepDiscoveryCandidate) urlKey() string { return c.URL }

// mergeDeepCandidate implements the per-URL merge used by the crawl loop: the
// larger link and relevance scores, the newer timestamps.
func mergeDeepCandidate(existing, incoming deepDiscoveryCandidate) deepDiscoveryCandidate {
	merged := deepDiscoveryCandidate{
		URL:           incoming.URL,
		LinkScore:     existing.LinkScore,
		PublishedAtTs: resolveBetterTimestamp(existing.PublishedAtTs, incoming.PublishedAtTs),
		CrawledAtTs:   resolveBetterTimestamp(existing.CrawledAtTs, incoming.CrawledAtTs),
	}
	if incoming.LinkScore > merged.LinkScore {
		merged.LinkScore = incoming.LinkScore
	}
	leftRelevance := 0.0
	if existing.RelevanceScore != nil {
		leftRelevance = *existing.RelevanceScore
	}
	rightRelevance := 0.0
	if incoming.RelevanceScore != nil {
		rightRelevance = *incoming.RelevanceScore
	}
	bestRelevance := leftRelevance
	if rightRelevance > bestRelevance {
		bestRelevance = rightRelevance
	}
	merged.RelevanceScore = &bestRelevance
	return merged
}

// rankDeepCandidates applies the score filter, the ranking and the pool cap.
func rankDeepCandidates(candidates map[string]deepDiscoveryCandidate, deep DeepOptions) []deepDiscoveryCandidate {
	ranked := make([]deepDiscoveryCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.PublishedAtTs == nil && candidate.LinkScore < deep.ScoreThreshold {
			continue
		}
		ranked = append(ranked, candidate)
	}
	sortDeepCandidates(ranked)
	if len(ranked) > deep.CandidatePoolSize {
		ranked = ranked[:deep.CandidatePoolSize]
	}
	return ranked
}
