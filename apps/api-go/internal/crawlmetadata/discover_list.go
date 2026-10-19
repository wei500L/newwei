package crawlmetadata

import (
	"context"
	"encoding/json"
	"log"
	"net/url"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// This file ports discoverListUrls/discoverListCandidates and
// discoverListUrlsViaCrawl4ai (apps/api/src/modules/crawl/crawl-metadata.service.ts:431-582
// and :652-908).
//
// Request rhythm: at most listPageConcurrency crawl4ai calls run at a time (the
// page batch), the crawl stops after listMaxPages pages or maxUrls article URLs,
// and every fetch carries the shared request timeout. The raw-HTML fallback
// issues exactly one direct request to the seed page, and it runs only when the
// crawl4ai path produced no article URL — the same "crawl4ai first, one HTML
// fallback" order as the source. Nothing is retried.

// ListDiscoveryInput is the discoverListUrls/discoverListCandidates argument set.
type ListDiscoveryInput struct {
	URL                 string
	Domain              string
	Pattern             string
	MaxURLs             *int
	ListMaxPages        *int
	ListPageConcurrency *int
	// FollowPagination defaults to true (the source only disables it on an
	// explicit false).
	FollowPagination *bool
	RequestTimeoutMs *int
	CrawlOptions     json.RawMessage
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
	normalizedSeedURL := stripFragment(seedURL)

	maxURLs := clampNumber(input.MaxURLs, 1, 2000, 200)
	listMaxPages := clampNumber(input.ListMaxPages, 1, 20, 6)
	listPageConcurrency := clampNumber(input.ListPageConcurrency, 1, 5, 2)
	followPagination := input.FollowPagination == nil || *input.FollowPagination
	requestTimeoutMs := 15_000
	if input.RequestTimeoutMs != nil {
		requestTimeoutMs = maxInt(1000, *input.RequestTimeoutMs)
	}
	domain, hasDomain := normalizeDomain(input.Domain)
	if !hasDomain {
		domain = ""
	}
	patternMatcher := normalizePattern(input.Pattern)
	options, err := ParseCrawlOptions(input.CrawlOptions)
	if err != nil {
		return nil, err
	}
	options.Prefetch = boolPtr(true)

	discovered := d.discoverListURLsViaCrawl4AI(ctx, crawlListInput{
		seedURL:             seedURL,
		normalizedSeedURL:   normalizedSeedURL,
		domain:              domain,
		patternMatcher:      patternMatcher,
		maxURLs:             maxURLs,
		listMaxPages:        listMaxPages,
		listPageConcurrency: listPageConcurrency,
		followPagination:    followPagination,
		options:             options,
	})
	if len(discovered) > 0 {
		crawledAtTs := nowMillis()
		candidates := make([]DiscoveryCandidate, 0, len(discovered))
		for _, entry := range discovered {
			candidates = append(candidates, DiscoveryCandidate{
				URL:           entry,
				PublishedAtTs: parsePublishedAtFromURL(entry),
				CrawledAtTs:   &crawledAtTs,
			})
		}
		return candidates, nil
	}

	body, ok := d.service.fetchMaybe(ctx, seedURL, requestTimeoutMs)
	if !ok {
		return []DiscoveryCandidate{}, nil
	}
	allowedOrigin := domain
	if allowedOrigin == "" {
		if parsed, err := url.Parse(seedURL); err == nil {
			allowedOrigin = parsed.Scheme + "://" + parsed.Host
		}
	}
	allowedOrigin = strings.TrimRight(allowedOrigin, "/")

	document, err := htmlParse(body)
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
		href := strings.TrimSpace(findAttribute(node, "href"))
		if href == "" || href == "#" || strings.HasPrefix(strings.ToLower(href), "javascript:") {
			continue
		}
		resolved, ok := resolveURLAgainst(seedURL, href)
		if !ok {
			continue
		}
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
		if len(candidates) >= maxURLs {
			break
		}
	}
	return candidates, nil
}

// crawlListInput is the discoverListUrlsViaCrawl4ai argument set.
type crawlListInput struct {
	seedURL             string
	normalizedSeedURL   string
	domain              string
	patternMatcher      func(string) bool
	maxURLs             int
	listMaxPages        int
	listPageConcurrency int
	followPagination    bool
	options             crawl4ai.CrawlOptions
}

// listPageResult is one crawled list page outcome.
type listPageResult struct {
	normalizedURL  string
	articleURLs    []string
	paginationURLs []string
}

// discoverListURLsViaCrawl4AI ports discoverListUrlsViaCrawl4ai. A crawl error
// (or an unconfigured client) yields no URLs so the caller falls back to the raw
// HTML parse.
func (d *Discovery) discoverListURLsViaCrawl4AI(ctx context.Context, input crawlListInput) []string {
	client := d.crawlClient()
	if client == nil {
		return nil
	}

	allowedOrigin := input.domain
	if allowedOrigin == "" {
		if parsed, err := url.Parse(input.seedURL); err == nil {
			allowedOrigin = parsed.Scheme + "://" + parsed.Host
		}
	}
	allowedOrigin = strings.TrimRight(allowedOrigin, "/")

	pendingListPages := []string{input.seedURL}
	pendingSet := map[string]bool{input.normalizedSeedURL: true}
	visited := map[string]bool{}
	articleURLs := []string{}
	articleSet := map[string]bool{}
	settings := d.crawlSettings(ctx)

	for len(pendingListPages) > 0 && len(visited) < input.listMaxPages && len(articleURLs) < input.maxURLs {
		availableSlots := input.listMaxPages - len(visited)
		batchSize := maxInt(1, minInt(input.listPageConcurrency, minInt(len(pendingListPages), availableSlots)))
		batch := make([]string, batchSize)
		copy(batch, pendingListPages[:batchSize])
		pendingListPages = pendingListPages[batchSize:]
		for _, pageURL := range batch {
			delete(pendingSet, stripFragment(pageURL))
		}

		results := mapWithConcurrency(batch, batchSize, func(listPageURL string) listPageResult {
			normalizedListPageURL := stripFragment(listPageURL)
			response, err := client.Crawl(ctx, crawl4ai.CrawlRequest{
				URL:     listPageURL,
				Options: input.options,
			}, settings)
			if err != nil {
				logListDiscoveryFailure(listPageURL, err)
				return listPageResult{normalizedURL: normalizedListPageURL}
			}
			article, ok := selectDiscoveryResultArticle(response.Results, normalizedListPageURL)
			if !ok || article.Success == nil || !*article.Success || len(article.Links) == 0 {
				return listPageResult{normalizedURL: normalizedListPageURL}
			}
			return classifyListPageLinks(listPagePage{
				listPageURL:           listPageURL,
				normalizedListPageURL: normalizedListPageURL,
				normalizedSeedURL:     input.normalizedSeedURL,
				allowedOrigin:         allowedOrigin,
				patternMatcher:        input.patternMatcher,
				followPagination:      input.followPagination,
				links:                 article.Links,
			})
		})

		for _, result := range results {
			visited[result.normalizedURL] = true
			for _, articleURL := range result.articleURLs {
				if articleSet[articleURL] {
					continue
				}
				articleSet[articleURL] = true
				articleURLs = append(articleURLs, articleURL)
				if len(articleURLs) >= input.maxURLs {
					break
				}
			}
			if len(articleURLs) >= input.maxURLs {
				break
			}
			if !input.followPagination {
				continue
			}
			for _, paginationURL := range result.paginationURLs {
				if len(visited)+len(pendingListPages) >= input.listMaxPages {
					break
				}
				normalizedPaginationURL := stripFragment(paginationURL)
				if visited[normalizedPaginationURL] || pendingSet[normalizedPaginationURL] {
					continue
				}
				pendingSet[normalizedPaginationURL] = true
				pendingListPages = append(pendingListPages, paginationURL)
			}
		}
	}

	return sliceUpTo(articleURLs, input.maxURLs)
}

// listPagePage is the argument set of classifyListPageLinks.
type listPagePage struct {
	listPageURL           string
	normalizedListPageURL string
	normalizedSeedURL     string
	allowedOrigin         string
	patternMatcher        func(string) bool
	followPagination      bool
	links                 []crawl4ai.Link
}

// classifyListPageLinks splits one page's links into article and pagination URLs
// with the source's three-branch decision.
func classifyListPageLinks(page listPagePage) listPageResult {
	result := listPageResult{normalizedURL: page.normalizedListPageURL}
	seenArticles := map[string]bool{}
	seenPagination := map[string]bool{}

	for _, entry := range page.links {
		href := strings.TrimSpace(entry.Href)
		if href == "" || href == "#" || strings.HasPrefix(strings.ToLower(href), "javascript:") {
			continue
		}
		resolved, ok := resolveURLAgainst(page.listPageURL, href)
		if !ok {
			continue
		}
		if resolved.Scheme != "http" && resolved.Scheme != "https" {
			continue
		}
		resolved.Fragment = ""
		absolute := resolved.String()
		if absolute == page.normalizedListPageURL || absolute == page.normalizedSeedURL {
			continue
		}
		if page.allowedOrigin != "" && !strings.HasPrefix(absolute, page.allowedOrigin+"/") && absolute != page.allowedOrigin {
			continue
		}

		anchorText := entry.Text
		if anchorText == "" {
			anchorText = entry.Title
		}
		matchesPattern := true
		if page.patternMatcher != nil {
			matchesPattern = page.patternMatcher(absolute)
		}
		isPagination := isLikelyPaginationLink(absolute, page.listPageURL, anchorText, entry.Rel)

		if matchesPattern && (!isPagination || !page.followPagination) {
			if !seenArticles[absolute] {
				seenArticles[absolute] = true
				result.articleURLs = append(result.articleURLs, absolute)
			}
			continue
		}
		if page.patternMatcher == nil && !isPagination {
			if !seenArticles[absolute] {
				seenArticles[absolute] = true
				result.articleURLs = append(result.articleURLs, absolute)
			}
			continue
		}
		if page.followPagination && isPagination && !seenPagination[absolute] {
			seenPagination[absolute] = true
			result.paginationURLs = append(result.paginationURLs, absolute)
		}
	}
	return result
}

// logListDiscoveryFailure records the fallback trigger. The crawl error already
// carries the classified message, so only the page URL and the error are logged.
func logListDiscoveryFailure(pageURL string, err error) {
	if err == nil {
		return
	}
	log.Printf("crawl4ai list discovery failed; falling back to raw HTML parsing (page=%s): %v", pageURL, err)
}

// stripFragment removes the fragment and normalizes the URL for comparisons.
func stripFragment(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return value
	}
	parsed.Fragment = ""
	return parsed.String()
}

// resolveURLAgainst implements new URL(reference, base).
func resolveURLAgainst(baseURL, reference string) (*url.URL, bool) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, false
	}
	resolved, err := url.Parse(strings.TrimSpace(reference))
	if err != nil {
		return nil, false
	}
	return base.ResolveReference(resolved), true
}

// boolPtr returns a pointer to value.
func boolPtr(value bool) *bool { return &value }
