package crawlmetadata

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"sync"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// This file ports discoverListUrls/discoverListCandidates
// (crawl-metadata.service.ts:431-582), the crawl4ai list walk
// (discoverListUrlsViaCrawl4ai, :652-908) and its raw-HTML fallback. The
// crawl4ai path is attempted first; any crawl4ai error falls back to parsing the
// seed page anchors exactly like the source's caught promise rejection.

// ListDiscoveryInput is the discoverListUrls/discoverListCandidates argument set.
type ListDiscoveryInput struct {
	URL                 string
	Domain              string
	Pattern             string
	MaxURLs             *int
	ListMaxPages        *int
	ListPageConcurrency *int
	FollowPagination    *bool
	RequestTimeoutMs    *int
	// CrawlOptions is the raw node/source crawlOptions object.
	CrawlOptions json.RawMessage
}

// DiscoverListURLs ports discoverListUrls.
func (d *Discovery) DiscoverListURLs(ctx context.Context, input ListDiscoveryInput) ([]string, error) {
	candidates, err := d.DiscoverListCandidates(ctx, input)
	if err != nil {
		return nil, err
	}
	urls := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		urls = append(urls, candidate.URL)
	}
	return urls, nil
}

// DiscoverListCandidates ports discoverListCandidates.
func (d *Discovery) DiscoverListCandidates(ctx context.Context, input ListDiscoveryInput) ([]DiscoveryCandidate, error) {
	seedURL, ok := normalizeURL(input.URL)
	if !ok {
		return []DiscoveryCandidate{}, nil
	}
	normalizedSeedURL := normalizeURLForComparisonOr(seedURL)

	maxURLs := clampNumber(input.MaxURLs, 1, 2_000, 200)
	listMaxPages := clampNumber(input.ListMaxPages, 1, 20, 6)
	listPageConcurrency := clampNumber(input.ListPageConcurrency, 1, 5, 2)
	followPagination := input.FollowPagination == nil || *input.FollowPagination
	requestTimeoutMs := requestTimeout(input.RequestTimeoutMs, requestTimeoutMs)

	domain, _ := normalizeDomain(input.Domain)
	patternMatcher := normalizePattern(input.Pattern)
	crawlOptions, err := normalizeCrawlOptions(input.CrawlOptions)
	if err != nil {
		return nil, err
	}

	discoveredViaCrawl4ai, err := d.discoverListURLsViaCrawl4ai(ctx, discoverListInput{
		seedURL:             seedURL,
		domain:              domain,
		maxURLs:             maxURLs,
		listMaxPages:        listMaxPages,
		listPageConcurrency: listPageConcurrency,
		followPagination:    followPagination,
		patternMatcher:      patternMatcher,
		crawlOptions:        crawlOptions,
	})
	if err != nil {
		// The source logs and falls through to the raw HTML parse.
		discoveredViaCrawl4ai = nil
	}
	if len(discoveredViaCrawl4ai) > 0 {
		crawledAtTs := nowMillis()
		candidates := make([]DiscoveryCandidate, 0, len(discoveredViaCrawl4ai))
		for _, discovered := range discoveredViaCrawl4ai {
			candidates = append(candidates, DiscoveryCandidate{
				URL:           discovered,
				PublishedAtTs: parsePublishedAtFromURL(discovered),
				CrawledAtTs:   &crawledAtTs,
			})
		}
		return candidates, nil
	}

	html, ok := d.service.fetchMaybe(ctx, seedURL, requestTimeoutMs)
	if !ok || html == "" {
		return []DiscoveryCandidate{}, nil
	}

	baseOrigin := ""
	if parsed, err := url.Parse(seedURL); err == nil {
		baseOrigin = originOf(parsed)
	}
	allowedOrigin := domain
	if allowedOrigin == "" {
		allowedOrigin = baseOrigin
	}

	document, err := htmlParse(html)
	if err != nil {
		return []DiscoveryCandidate{}, nil
	}
	candidates := []DiscoveryCandidate{}
	seen := map[string]bool{}
	crawledAtTs := nowMillis()

	for _, node := range elementDescendants(document) {
		if node.Data != "a" {
			continue
		}
		href := findAttribute(node, "href")
		if href == "" {
			continue
		}
		trimmed := strings.TrimSpace(href)
		if trimmed == "" || trimmed == "#" || strings.HasPrefix(strings.ToLower(trimmed), "javascript:") {
			continue
		}
		reference, err := url.Parse(trimmed)
		if err != nil {
			continue
		}
		base, err := url.Parse(seedURL)
		if err != nil {
			continue
		}
		resolved := base.ResolveReference(reference)
		if resolved.Scheme != "http" && resolved.Scheme != "https" {
			continue
		}
		resolved.Fragment = ""
		absolute := resolved.String()
		if absolute == normalizedSeedURL {
			continue
		}
		if allowedOrigin != "" && !strings.HasPrefix(absolute, allowedOrigin+"/") && absolute != allowedOrigin {
			continue
		}
		if patternMatcher != nil && !patternMatcher(absolute) {
			continue
		}
		if seen[absolute] {
			continue
		}
		seen[absolute] = true
		candidates = append(candidates, DiscoveryCandidate{
			URL:           absolute,
			PublishedAtTs: parsePublishedAtFromURL(absolute),
			CrawledAtTs:   &crawledAtTs,
		})
	}

	return sliceUpTo(candidates, maxURLs), nil
}

// discoverListInput is the discoverListUrlsViaCrawl4ai argument set.
type discoverListInput struct {
	seedURL             string
	domain              string
	maxURLs             int
	listMaxPages        int
	listPageConcurrency int
	followPagination    bool
	patternMatcher      func(string) bool
	crawlOptions        crawl4ai.CrawlOptions
}

type listBatchResult struct {
	listPageURL           string
	normalizedListPageURL string
	articleURLs           []string
	paginationURLs        []string
}

// discoverListURLsViaCrawl4ai ports discoverListUrlsViaCrawl4ai.
func (d *Discovery) discoverListURLsViaCrawl4ai(ctx context.Context, input discoverListInput) ([]string, error) {
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

	crawlOptions := input.crawlOptions
	crawlOptions.ExtractLinks = true
	crawlOptions.Prefetch = true

	pendingListPages := []string{input.seedURL}
	pendingListPageSet := map[string]bool{normalizedSeedURL: true}
	visitedListPages := map[string]bool{}
	discoveredArticleURLs := []string{}
	discoveredArticleSet := map[string]bool{}

	for len(pendingListPages) > 0 && len(visitedListPages) < input.listMaxPages && len(discoveredArticleURLs) < input.maxURLs {
		availableSlots := input.listMaxPages - len(visitedListPages)
		batchSize := maxInt(1, minInt(minInt(input.listPageConcurrency, len(pendingListPages)), availableSlots))
		batch := append([]string{}, pendingListPages[:batchSize]...)
		pendingListPages = pendingListPages[batchSize:]
		for _, pageURL := range batch {
			delete(pendingListPageSet, normalizeURLForComparisonOr(pageURL))
		}

		results, err := d.crawlListBatch(ctx, client, settings, batch, batchSize, input, crawlOptions, allowedOrigin, normalizedSeedURL)
		if err != nil {
			return nil, err
		}
		for _, result := range results {
			visitedListPages[result.normalizedListPageURL] = true
			for _, articleURL := range result.articleURLs {
				if discoveredArticleSet[articleURL] {
					continue
				}
				discoveredArticleSet[articleURL] = true
				discoveredArticleURLs = append(discoveredArticleURLs, articleURL)
				if len(discoveredArticleURLs) >= input.maxURLs {
					break
				}
			}
			if len(discoveredArticleURLs) >= input.maxURLs {
				break
			}
			if !input.followPagination {
				continue
			}
			for _, paginationURL := range result.paginationURLs {
				if len(visitedListPages)+len(pendingListPages) >= input.listMaxPages {
					break
				}
				normalizedPaginationURL := normalizeURLForComparisonOr(paginationURL)
				if visitedListPages[normalizedPaginationURL] || pendingListPageSet[normalizedPaginationURL] {
					continue
				}
				pendingListPageSet[normalizedPaginationURL] = true
				pendingListPages = append(pendingListPages, paginationURL)
			}
		}
	}

	return sliceUpTo(discoveredArticleURLs, input.maxURLs), nil
}

// crawlListBatch runs one bounded batch with the same per-batch concurrency as
// the source and returns the batch results in input order.
func (d *Discovery) crawlListBatch(
	ctx context.Context,
	client *crawl4ai.Client,
	settings crawl4ai.Settings,
	batch []string,
	batchSize int,
	input discoverListInput,
	crawlOptions crawl4ai.CrawlOptions,
	allowedOrigin string,
	normalizedSeedURL string,
) ([]listBatchResult, error) {
	results := make([]listBatchResult, len(batch))
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
				results[index], errs[index] = d.crawlListPage(ctx, client, settings, batch[index], input, crawlOptions, allowedOrigin, normalizedSeedURL)
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

func (d *Discovery) crawlListPage(
	ctx context.Context,
	client *crawl4ai.Client,
	settings crawl4ai.Settings,
	listPageURL string,
	input discoverListInput,
	crawlOptions crawl4ai.CrawlOptions,
	allowedOrigin string,
	normalizedSeedURL string,
) (listBatchResult, error) {
	result := listBatchResult{listPageURL: listPageURL, normalizedListPageURL: normalizeURLForComparisonOr(listPageURL)}
	normalizedListPageURL := result.normalizedListPageURL

	response, err := client.Crawl(ctx, crawl4ai.CrawlRequest{URL: listPageURL, Options: crawlOptions}, settings)
	if err != nil {
		return result, err
	}
	article, ok := selectDiscoveryResultArticle(response.Results, normalizedListPageURL)
	if !ok || article.Success == nil || !*article.Success {
		return result, nil
	}
	if len(article.Links) == 0 {
		return result, nil
	}

	articleURLs := []string{}
	paginationURLs := []string{}
	seenArticleURLs := map[string]bool{}
	seenPaginationURLs := map[string]bool{}

	for _, entry := range article.Links {
		href := strings.TrimSpace(entry.Href)
		if href == "" || href == "#" || strings.HasPrefix(strings.ToLower(href), "javascript:") {
			continue
		}
		base, err := url.Parse(listPageURL)
		if err != nil {
			continue
		}
		reference, err := url.Parse(href)
		if err != nil {
			continue
		}
		resolved := base.ResolveReference(reference)
		if resolved.Scheme != "http" && resolved.Scheme != "https" {
			continue
		}
		resolved.Fragment = ""
		absolute := resolved.String()
		if absolute == normalizedListPageURL || absolute == normalizedSeedURL {
			continue
		}
		if allowedOrigin != "" && !strings.HasPrefix(absolute, allowedOrigin+"/") && absolute != allowedOrigin {
			continue
		}

		anchorText := entry.Text
		if anchorText == "" {
			anchorText = entry.Title
		}
		rel := entry.Rel

		matchesPattern := true
		if input.patternMatcher != nil {
			matchesPattern = input.patternMatcher(absolute)
		}
		isPagination := isLikelyPaginationLink(absolute, listPageURL, anchorText, rel)

		if matchesPattern && (!isPagination || !input.followPagination) {
			if !seenArticleURLs[absolute] {
				seenArticleURLs[absolute] = true
				articleURLs = append(articleURLs, absolute)
			}
			continue
		}
		if input.patternMatcher == nil && !isPagination {
			if !seenArticleURLs[absolute] {
				seenArticleURLs[absolute] = true
				articleURLs = append(articleURLs, absolute)
			}
			continue
		}
		if input.followPagination && isPagination && !seenPaginationURLs[absolute] {
			seenPaginationURLs[absolute] = true
			paginationURLs = append(paginationURLs, absolute)
		}
	}

	result.articleURLs = articleURLs
	result.paginationURLs = paginationURLs
	return result, nil
}

// normalizeURLForComparisonOr is `normalizeUrlForComparison(x) ?? x`.
func normalizeURLForComparisonOr(value string) string {
	if normalized, ok := normalizeURLForComparison(value); ok {
		return normalized
	}
	return value
}

// originOf renders the `scheme://host` origin Node's URL.origin produces for a
// canonicalized URL (default ports were already stripped by normalizeUrl).
func originOf(parsed *url.URL) string {
	if parsed == nil || parsed.Scheme == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

// requestTimeout mirrors the source's `typeof x === "number" ? max(1000,
// round(x)) : 15000`.
func requestTimeout(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return maxInt(1000, *value)
}
