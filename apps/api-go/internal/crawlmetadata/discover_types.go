package crawlmetadata

// This file adds the discovery-chain types (RSS, list page and deep discovery)
// that apps/api/src/modules/crawl/crawl-metadata.service.ts:57-176 defines. The
// pre-existing urls/sitemap/extract chain keeps its own types in types.go; both
// share the same Service resources (HTTP client, SSRF rules, Redis state).

import "encoding/json"

// DiscoveryCandidate is CrawlDiscoveryCandidate: one discovered URL with the
// optional signals the workflow runtime and the preview merge.
type DiscoveryCandidate struct {
	URL            string
	RelevanceScore *float64
	PublishedAtTs  *int64
	CrawledAtTs    *int64
	// PrefetchedArticle is present only for RSS items that carried a body.
	PrefetchedArticle *PrefetchedArticle
}

// PrefetchedArticle is CrawlDiscoveryPrefetchedArticle: the RSS item body that
// lets the crawl pipeline skip a fetch. The JSON shape is the one the run
// candidate metadata stores, so the field names and omissible keys match NestJS.
type PrefetchedArticle struct {
	Title       *string `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	Author      *string `json:"author,omitempty"`
	Markdown    string  `json:"markdown"`
	PublishedAt *string `json:"publishedAt,omitempty"`
	// Metadata is {source:"rss", markdownSource:<content|description|stub>}.
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

// TimestampSource is CrawlDiscoveryTimestampSource.
type TimestampSource string

const (
	TimestampSourcePublished TimestampSource = "published"
	TimestampSourceCrawled   TimestampSource = "crawled"
	TimestampSourceNone      TimestampSource = "none"
)

// RSS body source strategies (CrawlDiscoveryRssBodySourceStrategy).
const (
	RSSBodySourceContentFirst = "content_first"
	RSSBodySourceContentOnly  = "content_only"
	RSSBodySourceSummaryOnly  = "summary_only"
)

// RSS no-body policies (CrawlDiscoveryRssNoBodyPolicy).
const (
	RSSNoBodyPolicySkip                 = "skip"
	RSSNoBodyPolicyTitleDescriptionStub = "title_description_stub"
)

// RSSFetchOptions is CrawlDiscoveryRssFetchOptions.
type RSSFetchOptions struct {
	RequestTimeoutMs   *int
	BodySourceStrategy string
	NoBodyPolicy       string
}

// DeepOptions is DeepDiscoveryOptions: the normalized deep-discovery limits.
type DeepOptions struct {
	MaxPages            int
	MaxDepth            int
	TimeBudgetSeconds   int
	PageConcurrency     int
	ScoreThreshold      float64
	CandidatePoolSize   int
	HeadFetchTopK       int
	PreferPathDate      bool
	EnableSecondaryHubs bool
	// IgnoreRobotsTxt is hard-locked to true: the crawl4ai client always sends
	// check_robots_txt=false, so the option cannot be turned off.
	IgnoreRobotsTxt bool
}

// DefaultDeepOptions is normalizeDeepDiscoveryOptions(nil).
func DefaultDeepOptions() DeepOptions {
	return DeepOptions{
		MaxPages:            80,
		MaxDepth:            2,
		TimeBudgetSeconds:   60,
		PageConcurrency:     2,
		ScoreThreshold:      0.2,
		CandidatePoolSize:   120,
		HeadFetchTopK:       40,
		PreferPathDate:      true,
		EnableSecondaryHubs: true,
		IgnoreRobotsTxt:     true,
	}
}

// Discovery error codes (DEEP_DISCOVERY_ERROR_CODES).
const (
	DiscoveryCodeCrawl4AIUnavailable = "SEED_DEEP_CRAWL4AI_UNAVAILABLE"
	DiscoveryCodeCrawlFailed         = "SEED_DEEP_CRAWL_FAILED"
	DiscoveryCodeEmptyResult         = "SEED_DEEP_EMPTY_RESULT"
	DiscoveryCodeNoCandidate         = "SEED_DEEP_NO_CANDIDATE"
	DiscoveryCodeNoPublishedAt       = "SEED_DEEP_NO_PUBLISHED_AT"
)

// DiscoveryError is the BadRequestException the source throws for deep
// discovery failures: `[CODE] message` plus an optional ` detail` suffix. The
// HTTP layer maps it to 400 with Error() verbatim, so the preview body and the
// failed run record carry the same text as NestJS.
type DiscoveryError struct {
	Code    string
	Message string
	Detail  string
}

func (e *DiscoveryError) Error() string {
	text := "[" + e.Code + "] " + e.Message
	if e.Detail != "" {
		text += " " + e.Detail
	}
	return text
}

// RSS prefetch limits (RSS_PREFETCH_MAX_*).
const (
	rssPrefetchMaxMarkdownChars    = 20_000
	rssPrefetchMaxTitleChars       = 500
	rssPrefetchMaxAuthorChars      = 200
	rssPrefetchMaxDescriptionChars = 4_000
)

// rssDiscoveryEntry is the internal RssDiscoveryEntry shape.
type rssDiscoveryEntry struct {
	URL           string
	Title         *string
	Description   *string
	Content       *string
	Author        *string
	PublishedAtTs *int64
}

// deepDiscoveryCandidate is the internal DeepDiscoveryCandidate shape.
type deepDiscoveryCandidate struct {
	URL            string
	LinkScore      float64
	RelevanceScore *float64
	PublishedAtTs  *int64
	CrawledAtTs    *int64
}
