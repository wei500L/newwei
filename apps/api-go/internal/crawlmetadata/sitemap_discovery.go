package crawlmetadata

// sitemap_discovery.go holds the named seed-discovery input, the requested
// discovery mode and the full diagnostics the Frontier seed branch records.
//
// These types are the Go form of CrawlMetadataService.discoverSitemap and its
// CrawlSitemapDiscoveryResult / CrawlSitemapDiscoveryDiagnostics
// (crawl-metadata.service.ts 162-176, 243). They are only used by the named
// seed-discovery entry point below; the preview, workflow and news-source
// scheduler callers keep their narrower wrappers and never see a mode or a
// diagnostics payload.
//
// Ownership: this file owns the seed-discovery semantics (four modes, the
// robots/common-path seed order, the per-call timeout and the diagnostics
// counters). The XML traversal and cache live in sitemap.go; the HTTP
// conditional cache lives in fetch.go and httpstate.go.

import (
	"context"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// SitemapDiscoveryMode is CrawlSeedDiscoveryMode. The zero value is not a valid
// mode; callers should resolve it through NormalizeSitemapDiscoveryMode so an
// absent value keeps the historical "robots" default.
type SitemapDiscoveryMode string

const (
	// SitemapDiscoveryModeRobots reads robots.txt first and falls back to the
	// ordered common paths when robots declares no sitemap.
	SitemapDiscoveryModeRobots SitemapDiscoveryMode = "robots"
	// SitemapDiscoveryModeCommonPaths skips the robots probe and goes straight
	// to the ordered common paths.
	SitemapDiscoveryModeCommonPaths SitemapDiscoveryMode = "common_paths"
	// SitemapDiscoveryModeSitemapOnly is the historical alias that behaves like
	// "robots": it still reads robots.txt first and falls back to the common
	// paths. The name does not imply "one XML document only".
	SitemapDiscoveryModeSitemapOnly SitemapDiscoveryMode = "sitemap_only"
	// SitemapDiscoveryModeDisabled fetches nothing and discovers no candidate.
	SitemapDiscoveryModeDisabled SitemapDiscoveryMode = "disabled"
)

// SitemapSeedMethod is CrawlSitemapDiscoveryDiagnostics.seedMethod: how the
// seed sitemap list was produced, not which sitemap was parsed.
type SitemapSeedMethod string

const (
	SitemapSeedMethodRobots      SitemapSeedMethod = "robots"
	SitemapSeedMethodCommonPaths SitemapSeedMethod = "common_paths"
	SitemapSeedMethodNone        SitemapSeedMethod = "none"
)

// NormalizeSitemapDiscoveryMode ports normalizeSitemapDiscoveryMode: a
// non-string/unknown value falls back to "robots", which keeps the historical
// default for callers that never pass a mode.
func NormalizeSitemapDiscoveryMode(value string) SitemapDiscoveryMode {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case string(SitemapDiscoveryModeRobots):
		return SitemapDiscoveryModeRobots
	case string(SitemapDiscoveryModeCommonPaths):
		return SitemapDiscoveryModeCommonPaths
	case string(SitemapDiscoveryModeSitemapOnly):
		return SitemapDiscoveryModeSitemapOnly
	case string(SitemapDiscoveryModeDisabled):
		return SitemapDiscoveryModeDisabled
	default:
		return SitemapDiscoveryModeRobots
	}
}

// SitemapDiscoveryDiagnostics is CrawlSitemapDiscoveryDiagnostics. The field
// order and JSON names are the persisted contract the run/node read projection
// and the Web console consume, so they must not be renamed. Every slice field is
// always non-nil so an empty result serializes as [] and not null.
type SitemapDiscoveryDiagnostics struct {
	DiscoveryMode            SitemapDiscoveryMode `json:"discoveryMode"`
	SeedMethod               SitemapSeedMethod    `json:"seedMethod"`
	RobotsURL                string               `json:"robotsUrl,omitempty"`
	RobotsDiscoveredSitemaps []string             `json:"robotsDiscoveredSitemaps"`
	AttemptedSitemaps        []string             `json:"attemptedSitemaps"`
	FetchedSitemaps          []string             `json:"fetchedSitemaps"`
	ParsedSitemaps           int                  `json:"parsedSitemaps"`
	CandidateCount           int                  `json:"candidateCount"`
}

// NewSitemapDiscoveryDiagnostics returns the initial diagnostics document. The
// seed method starts at "none" and the counters at zero, exactly like the
// NestJS object literal, so every early-return branch (no domain, blocked
// domain, disabled) already has the accurate shape.
func NewSitemapDiscoveryDiagnostics(mode SitemapDiscoveryMode) SitemapDiscoveryDiagnostics {
	return SitemapDiscoveryDiagnostics{
		DiscoveryMode:            mode,
		SeedMethod:               SitemapSeedMethodNone,
		RobotsDiscoveredSitemaps: []string{},
		AttemptedSitemaps:        []string{},
		FetchedSitemaps:          []string{},
	}
}

// SitemapDiscoveryOptions is discoverSitemap's named input
// (crawl-metadata.service.ts 243-250). A nil MaxURLs/RequestTimeoutMs keeps the
// shared defaults; a nil FreshnessCutoffTs disables the timestamp filter, which
// is what a caller that has no freshness window passes.
type SitemapDiscoveryOptions struct {
	Domain            string
	Pattern           string
	MaxURLs           *int
	RequestTimeoutMs  *int
	FreshnessCutoffTs *int64
	DiscoveryMode     SitemapDiscoveryMode
}

// SitemapDiscoveryResult is CrawlSitemapDiscoveryResult: the ordered candidates
// plus the diagnostics that describe how they were produced.
type SitemapDiscoveryResult struct {
	Candidates  []DiscoveryCandidate
	Diagnostics SitemapDiscoveryDiagnostics
}

// DiscoverSitemapCandidatesForSeed ports CrawlMetadataService.discoverSitemap.
// It normalizes the named input, resolves the per-call request timeout and
// freshness cutoff, then runs the depth-first sitemap walk in the requested
// mode while recording the diagnostics. Existing preview/workflow/scheduler
// callers keep their own wrappers; only the Frontier seed branch uses this
// entry point because it is the only caller that needs the mode and the
// diagnostics.
//
// The timeout is applied to this call's normalized config and therefore to every
// robots/sitemap HTTP request and its context cancellation; the shared settings
// timeout is never mutated.
func (d *Discovery) DiscoverSitemapCandidatesForSeed(ctx context.Context, options SitemapDiscoveryOptions) (SitemapDiscoveryResult, error) {
	mode := NormalizeSitemapDiscoveryMode(string(options.DiscoveryMode))
	diagnostics := NewSitemapDiscoveryDiagnostics(mode)

	domain, ok := normalizeDomain(options.Domain)
	if !ok || domain == "" {
		// The source returns the empty diagnostics document without fetching
		// when the domain is missing or unparseable.
		return SitemapDiscoveryResult{Candidates: []DiscoveryCandidate{}, Diagnostics: diagnostics}, nil
	}
	// Defense in depth beyond the option shape, mirroring validateSsrfUrlAsync:
	// a blocked domain discovers nothing and reports the empty shape. The
	// per-hop validation in fetchWithStatus still guards every redirect.
	if _, allowed := newssources.ValidateOutboundTargetURL(ctx, domain); !allowed {
		return SitemapDiscoveryResult{Candidates: []DiscoveryCandidate{}, Diagnostics: diagnostics}, nil
	}

	config, err := normalizeInput(ExtractionInput{
		Source:  string(SourceSitemap),
		Domain:  options.Domain,
		Pattern: options.Pattern,
		MaxURLs: options.MaxURLs,
	})
	if err != nil {
		return SitemapDiscoveryResult{}, err
	}
	if options.RequestTimeoutMs != nil {
		config.requestTimeoutMs = clampSitemapRequestTimeout(*options.RequestTimeoutMs)
	}
	if options.FreshnessCutoffTs != nil {
		cutoff := *options.FreshnessCutoffTs
		if cutoff < 0 {
			cutoff = 0
		}
		config.freshnessCutoffTs = &cutoff
	}

	if mode == SitemapDiscoveryModeDisabled {
		// A hard off switch: no seed URL, no fetch, no candidate.
		return SitemapDiscoveryResult{Candidates: []DiscoveryCandidate{}, Diagnostics: diagnostics}, nil
	}

	candidates := d.service.discoverFromSitemapCandidateEntriesWithDiagnostics(ctx, config, mode, &diagnostics)
	if candidates == nil {
		candidates = []DiscoveryCandidate{}
	}
	diagnostics.CandidateCount = len(candidates)
	return SitemapDiscoveryResult{Candidates: candidates, Diagnostics: diagnostics}, nil
}

// clampSitemapRequestTimeout is Math.max(1000, Math.round(value)): a positive
// per-call timeout is floored at one second so a tiny value cannot cancel the
// request before it leaves the process.
func clampSitemapRequestTimeout(value int) int {
	if value < 1000 {
		return 1000
	}
	return value
}
