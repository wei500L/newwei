package crawlmetadata

import "context"

// DiscoverSitemapSeedCandidates ports the CrawlMetadataService.discoverSitemapCandidates
// shape the news-source scheduler calls: domain, pattern, maxUrls and the
// freshness cutoff are applied exactly like the preview path, but every
// candidate also carries the sitemap publish timestamp (news:publication_date
// first, lastmod second). The scheduler needs that timestamp for its freshness
// window and for the effective-time sort, so the URL-only discovery wrappers
// cannot be reused here.
//
// A nil maxURLs keeps the shared default (50, clamped to 1..200); a nil
// freshnessCutoffTs disables the timestamp filter, which is what the preview
// and workflow callers expect.
func (d *Discovery) DiscoverSitemapSeedCandidates(
	ctx context.Context,
	domain, pattern string,
	maxURLs *int,
	freshnessCutoffTs *int64,
) ([]DiscoveryCandidate, error) {
	config, err := normalizeInput(ExtractionInput{
		Source:  string(SourceSitemap),
		Domain:  domain,
		Pattern: pattern,
		MaxURLs: maxURLs,
	})
	if err != nil {
		return nil, err
	}
	if freshnessCutoffTs != nil {
		cutoff := *freshnessCutoffTs
		config.freshnessCutoffTs = &cutoff
	}
	if config.domain == "" {
		return []DiscoveryCandidate{}, nil
	}
	return d.service.discoverFromSitemapCandidateEntries(ctx, config)
}
