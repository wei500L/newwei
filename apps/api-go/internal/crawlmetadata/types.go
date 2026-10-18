// Package crawlmetadata migrates the web page metadata preview chain from
// apps/api/src/modules/crawl/crawl-metadata.service.ts. That chain answers two
// entries: POST /api/crawl-tasks/metadata (crawl.read) and the crawlMetadata
// GraphQL query (crawl.read).
//
// Only the urls/sitemap discovery paths belong to these two entries. The same
// Nest service also owns RSS/list/deep (crawl4ai) discovery for the crawl
// worker, and none of those branches is migrated here: they are reachable only
// from other entries, so migrating them would add crawl4ai execution rights to
// a read-only preview.
//
// The chain performs real outbound work: robots.txt and sitemap discovery with
// a shared conditional HTTP cache, per-hop SSRF validation with manual
// redirects, gzip handling, one-pass HTML5 DOM parsing of the head, JSON-LD
// compaction and relevance scoring. Results are stable in discovery order.
package crawlmetadata

import "time"

// Source selects how candidate page URLs are produced. NestJS treats every
// value other than "urls" as "sitemap", so Source is a plain string upstream.
type Source string

const (
	// SourceSitemap discovers page URLs from robots.txt and sitemap files.
	SourceSitemap Source = "sitemap"
	// SourceURLs fetches exactly the caller-supplied URL list.
	SourceURLs Source = "urls"
)

// Status values of one metadata result.
const (
	StatusSuccess = "success"
	StatusFailed  = "failed"
)

// ExtractionInput is the normalized-shape input of CrawlMetadataService.extract
// (CrawlMetadataExtractionInput). Pointer fields carry the GraphQL/REST
// distinction between "absent or null" (nil) and an explicit value; a nil
// pointer always takes the source default.
type ExtractionInput struct {
	// Source is "urls" or anything else (treated as sitemap).
	Source string
	// Domain is the site origin for sitemap discovery.
	Domain string
	// URLs is the explicit page list for SourceURLs.
	URLs []string
	// Pattern is the wildcard filter applied only to discovered sitemap URLs.
	Pattern string
	// Query is the relevance query text.
	Query string
	// MaxURLs caps the number of fetched pages (default 50, clamp 1..200).
	MaxURLs *int
	// Concurrency caps parallel page fetches (default 5, clamp 1..10).
	Concurrency *int
	// ScoreThreshold drops results below the score (default 0, 3 decimals).
	ScoreThreshold *float64
	// ExtractJSONLd, ExtractOpenGraph and ExtractStandardMeta default to true.
	ExtractJSONLd       *bool
	ExtractOpenGraph    *bool
	ExtractStandardMeta *bool
}

// Tag is one collected meta element: the raw name (name or property attribute)
// and the trimmed content.
type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Result is one page result (CrawlMetadataResult). Optional fields stay nil and
// are omitted from the REST body / rendered as GraphQL null.
type Result struct {
	URL            string
	Status         string
	HTTPStatus     *int
	FetchedAt      *time.Time
	Title          *string
	Description    *string
	Keywords       *[]string
	Author         *string
	MetaTags       []Tag
	OpenGraph      []Tag
	JSONLd         []string
	RelevanceScore *float64
	Error          *string
}

// normalizedConfig is the resolved configuration used by discovery and fetch.
// It mirrors NormalizedMetadataConfig; freshnessCutoffTs stays nil because
// neither migrated entry exposes a freshness parameter.
type normalizedConfig struct {
	source            Source
	domain            string
	urls              []string
	patternMatcher    func(string) bool
	maxURLs           int
	includeJSONLd     bool
	includeOpenGraph  bool
	includeMeta       bool
	concurrency       int
	queryTokens       []string
	scoreThreshold    float64
	requestTimeoutMs  int
	freshnessCutoffTs *int64
}
