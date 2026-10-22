package crawlmetadata

import (
	"context"
	"net/url"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// Discovery is the crawl discovery chain (RSS, list page and deep discovery)
// built on the shared metadata Service resources. Keeping it separate from
// Service means the already migrated urls/sitemap/extract chain keeps its exact
// behaviour and the crawl4ai dependency is only constructed when a discovery
// switch is go.
//
// Provenance: apps/api/src/modules/crawl/crawl-metadata.service.ts
// discoverRssCandidates (:364-429), discoverListCandidates (:446-582),
// discoverDeepCandidates (:598-650) and their private helpers.
type Discovery struct {
	service *Service
	client  *crawl4ai.Client
	// settings resolves the crawl client settings once per request. A nil
	// provider uses the built-in defaults (CRAWL4AI_TIMEOUT_MS / health TTL).
	settings SettingsProvider
}

// SettingsProvider loads the crawl client settings for one discovery request.
// The wiring layer supplies the shared crawl_client:settings reader; tests
// supply a fixed value.
type SettingsProvider func(ctx context.Context) crawl4ai.Settings

// NewDiscovery builds the discovery chain. client may be nil (crawl4ai not
// configured), in which case deep discovery reports SEED_DEEP_CRAWL4AI_UNAVAILABLE
// and list discovery falls back to raw HTML parsing.
func NewDiscovery(service *Service, client *crawl4ai.Client, settings SettingsProvider) *Discovery {
	return &Discovery{service: service, client: client, settings: settings}
}

// Service returns the shared metadata service (used by tests and wiring).
func (d *Discovery) Service() *Service {
	if d == nil {
		return nil
	}
	return d.service
}

// crawlClient returns the client only when a base URL is configured. Callers use
// this to decide between the crawl4ai path and the HTML fallback.
func (d *Discovery) crawlClient() *crawl4ai.Client {
	if d == nil || d.client == nil || !d.client.Configured() {
		return nil
	}
	return d.client
}

// crawlSettings resolves the settings for one request.
func (d *Discovery) crawlSettings(ctx context.Context) crawl4ai.Settings {
	if d != nil && d.settings != nil {
		return d.settings(ctx)
	}
	return crawl4ai.DefaultSettings()
}

// DiscoverSitemapCandidates delegates to the existing sitemap chain so the
// preview and the workflow seed node share one implementation. The candidates
// keep the sitemap publish timestamp and the per-document crawl timestamp,
// which is what CrawlMetadataService.discoverSitemapCandidates returns and what
// the preview's publishedAt/crawledAt/effectiveAt columns are built from.
func (d *Discovery) DiscoverSitemapCandidates(ctx context.Context, domain, pattern string, maxURLs *int) ([]DiscoveryCandidate, error) {
	config, err := normalizeInput(ExtractionInput{
		Source:  string(SourceSitemap),
		Domain:  domain,
		Pattern: pattern,
		MaxURLs: maxURLs,
	})
	if err != nil {
		return nil, err
	}
	if config.domain == "" {
		return []DiscoveryCandidate{}, nil
	}
	return d.service.discoverFromSitemapCandidateEntries(ctx, config)
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

func parseURL(value string) (*url.URL, error) {
	return url.Parse(value)
}

func parseURLReference(value string) (*url.URL, error) {
	return url.Parse(value)
}
