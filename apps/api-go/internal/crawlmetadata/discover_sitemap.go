package crawlmetadata

import (
	"context"
)

// This file adds the candidate-producing sitemap traversal the news-source
// preview needs. The already migrated POST /api/crawl-tasks/metadata chain keeps
// its URL-only discoverFromSitemapCandidates (the REST contract returns page
// URLs, not preview candidates); this traversal walks the same seeds, parses the
// same payloads and fetches through the same conditional state cache, but also
// keeps the published timestamp each entry carries — which is what the preview
// reports as publishedAt/effectiveAt.
//
// The duplicated walk is deliberate: discoverFromSitemapCandidates is part of an
// already delivered contract and must not change signature or behaviour.

// discoverSitemapCandidateDetails is the CrawlDiscoveryCandidate-producing
// counterpart of discoverFromSitemapCandidates.
func (s *Service) discoverSitemapCandidateDetails(ctx context.Context, config normalizedConfig) ([]DiscoveryCandidate, error) {
	if config.domain == "" {
		return []DiscoveryCandidate{}, nil
	}
	seeds := s.resolveSitemapSeedURLs(ctx, config.domain, config.requestTimeoutMs)

	order := []string{}
	collected := map[string]DiscoveryCandidate{}
	visited := map[string]bool{}
	for _, sitemapURL := range seeds {
		if len(collected) >= config.maxURLs {
			break
		}
		if visited[sitemapURL] {
			continue
		}
		visited[sitemapURL] = true
		xmlBody, ok := s.fetchMaybe(ctx, sitemapURL, config.requestTimeoutMs)
		if !ok {
			continue
		}
		s.collectSitemapCandidates(ctx, sitemapURL, xmlBody, config, &order, collected, visited)
	}

	candidates := make([]DiscoveryCandidate, 0, len(order))
	for _, url := range order {
		candidates = append(candidates, collected[url])
	}
	return candidates, nil
}

// collectSitemapCandidates walks one sitemap body depth first, like
// extractFromSitemapPayload.
func (s *Service) collectSitemapCandidates(
	ctx context.Context,
	sitemapURL string,
	xmlBody string,
	config normalizedConfig,
	order *[]string,
	collected map[string]DiscoveryCandidate,
	visited map[string]bool,
) {
	payload, ok := s.parseSitemapPayload(ctx, sitemapURL, xmlBody)
	if !ok {
		return
	}
	crawledAtTs := nowMillis()

	for _, entry := range payload.URLs {
		if len(collected) >= config.maxURLs {
			break
		}
		normalized, ok := normalizeURL(entry.Loc)
		if !ok {
			normalized = entry.Loc
		}
		if config.patternMatcher != nil && !config.patternMatcher(normalized) {
			continue
		}
		publishedAtTs := resolveSitemapEntryPublishedAt(entry)
		if config.freshnessCutoffTs != nil && publishedAtTs != nil && *publishedAtTs < *config.freshnessCutoffTs {
			continue
		}
		candidate := DiscoveryCandidate{
			URL:           normalized,
			PublishedAtTs: publishedAtTs,
			CrawledAtTs:   &crawledAtTs,
		}
		if existing, ok := collected[normalized]; ok {
			candidate = mergeDiscoveryCandidates(existing, candidate)
		} else {
			*order = append(*order, normalized)
		}
		collected[normalized] = candidate
	}

	for _, child := range payload.ChildSitemaps {
		if len(collected) >= config.maxURLs {
			break
		}
		if config.freshnessCutoffTs != nil && child.LastmodTs != nil && *child.LastmodTs < *config.freshnessCutoffTs {
			continue
		}
		normalized, ok := normalizeURL(child.Loc)
		if !ok {
			normalized = child.Loc
		}
		if visited[normalized] {
			continue
		}
		visited[normalized] = true
		xmlChild, ok := s.fetchMaybe(ctx, normalized, config.requestTimeoutMs)
		if !ok {
			continue
		}
		s.collectSitemapCandidates(ctx, normalized, xmlChild, config, order, collected, visited)
	}
}

// mergeDiscoveryCandidates implements mergeDiscoveryCandidates: the larger
// relevance score and the newer timestamps, keyed by URL.
func mergeDiscoveryCandidates(existing, incoming DiscoveryCandidate) DiscoveryCandidate {
	merged := DiscoveryCandidate{
		URL:               incoming.URL,
		PublishedAtTs:     resolveBetterTimestamp(existing.PublishedAtTs, incoming.PublishedAtTs),
		CrawledAtTs:       resolveBetterTimestamp(existing.CrawledAtTs, incoming.CrawledAtTs),
		PrefetchedArticle: incoming.PrefetchedArticle,
	}
	if merged.PrefetchedArticle == nil {
		merged.PrefetchedArticle = existing.PrefetchedArticle
	}
	bestRelevance := -1.0
	hasRelevance := false
	for _, value := range []*float64{existing.RelevanceScore, incoming.RelevanceScore} {
		if value == nil {
			continue
		}
		hasRelevance = true
		if *value > bestRelevance {
			bestRelevance = *value
		}
	}
	if hasRelevance {
		merged.RelevanceScore = &bestRelevance
	}
	return merged
}
