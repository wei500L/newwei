package crawlmetadata

import (
	"context"
	"encoding/xml"
	"io"
	"regexp"
	"strings"
	"time"
)

// parsedSitemapPayload is ParsedSitemapPayload. The JSON tags are the shared
// cache contract with the NestJS discovery callers, so the news publication
// timestamps and lastmod values are preserved even though this chain only uses
// the loc values.
type parsedSitemapPayload struct {
	URLs          []parsedSitemapURL        `json:"urls"`
	ChildSitemaps []parsedSitemapIndexEntry `json:"childSitemaps"`
}

type parsedSitemapURL struct {
	Loc               string `json:"loc"`
	LastmodTs         *int64 `json:"lastmodTs,omitempty"`
	NewsPublishedAtTs *int64 `json:"newsPublishedAtTs,omitempty"`
}

type parsedSitemapIndexEntry struct {
	Loc       string `json:"loc"`
	LastmodTs *int64 `json:"lastmodTs,omitempty"`
}

// resolveURLs is the source resolveUrls: the explicit list is taken in order
// (pattern is deliberately not applied to it), otherwise sitemap discovery runs
// from the domain origin.
func (s *Service) resolveURLs(ctx context.Context, config normalizedConfig) ([]string, error) {
	if config.source == SourceURLs && len(config.urls) > 0 {
		return sliceUpTo(config.urls, config.maxURLs), nil
	}
	if config.domain == "" {
		return nil, nil
	}
	return s.discoverFromSitemaps(ctx, config)
}

func (s *Service) discoverFromSitemaps(ctx context.Context, config normalizedConfig) ([]string, error) {
	candidates, err := s.discoverFromSitemapCandidates(ctx, config)
	if err != nil {
		return nil, err
	}
	return candidates, nil
}

// discoverFromSitemapCandidates walks the seed sitemaps and then their child
// sitemaps depth first. Insertion order is the discovery order and duplicates
// are dropped on first sight; nothing is re-sorted by date or relevance.
func (s *Service) discoverFromSitemapCandidates(ctx context.Context, config normalizedConfig) ([]string, error) {
	collected := s.walkSitemaps(ctx, config)
	return collected.slice(config.maxURLs), nil
}

// discoverFromSitemapCandidateEntries is discoverFromSitemapsCandidates: the
// same depth-first walk, but every page URL keeps the publish timestamp the
// sitemap carried. The news-source scheduler needs the timestamp for its
// freshness window and for the effective-time sort; the URL-only discovery
// paths keep their existing projection. It keeps the historical default mode
// ("robots") and records no diagnostics.
func (s *Service) discoverFromSitemapCandidateEntries(ctx context.Context, config normalizedConfig) ([]DiscoveryCandidate, error) {
	return s.discoverFromSitemapCandidateEntriesWithDiagnostics(ctx, config, SitemapDiscoveryModeRobots, nil), nil
}

// discoverFromSitemapCandidateEntriesWithDiagnostics runs the depth-first walk
// in the requested discovery mode and, when diagnostics is non-nil, records the
// seed method, the attempted/fetched/parsed sitemaps and every collected
// timestamp. CandidateCount is filled by the caller because the source sets it
// after the walk returns.
func (s *Service) discoverFromSitemapCandidateEntriesWithDiagnostics(
	ctx context.Context,
	config normalizedConfig,
	mode SitemapDiscoveryMode,
	diagnostics *SitemapDiscoveryDiagnostics,
) []DiscoveryCandidate {
	collected := s.walkSitemapsInMode(ctx, config, mode, diagnostics)
	urls := collected.slice(config.maxURLs)
	candidates := make([]DiscoveryCandidate, 0, len(urls))
	for _, entry := range urls {
		publishedAtTs, crawledAtTs := collected.timestamps(entry)
		candidates = append(candidates, DiscoveryCandidate{
			URL:           entry,
			PublishedAtTs: publishedAtTs,
			CrawledAtTs:   crawledAtTs,
		})
	}
	return candidates
}

// walkSitemaps runs the shared depth-first sitemap traversal with the historical
// default mode and returns the first-seen URL set with the timestamps recorded
// alongside it.
func (s *Service) walkSitemaps(ctx context.Context, config normalizedConfig) *orderedURLSet {
	return s.walkSitemapsInMode(ctx, config, SitemapDiscoveryModeRobots, nil)
}

// walkSitemapsInMode is the depth-first traversal with an explicit discovery
// mode and optional diagnostics. The attempted/fetched/parsed counters are
// recorded at the same points the NestJS source records them: a seed sitemap is
// attempted before its fetch, a fetched seed sitemap is recorded on success, and
// a child sitemap is only recorded once its fetch succeeds.
func (s *Service) walkSitemapsInMode(
	ctx context.Context,
	config normalizedConfig,
	mode SitemapDiscoveryMode,
	diagnostics *SitemapDiscoveryDiagnostics,
) *orderedURLSet {
	collected := newOrderedURLSet()
	if config.domain == "" {
		return collected
	}
	seeds := s.resolveSitemapSeedURLs(ctx, config.domain, config.requestTimeoutMs, mode, diagnostics)

	visited := map[string]bool{}
	for _, sitemapURL := range seeds {
		if collected.len() >= config.maxURLs {
			break
		}
		if visited[sitemapURL] {
			continue
		}
		visited[sitemapURL] = true
		if diagnostics != nil {
			diagnostics.AttemptedSitemaps = append(diagnostics.AttemptedSitemaps, sitemapURL)
		}
		xmlBody, ok := s.fetchMaybe(ctx, sitemapURL, config.requestTimeoutMs)
		if !ok {
			continue
		}
		if diagnostics != nil {
			diagnostics.FetchedSitemaps = append(diagnostics.FetchedSitemaps, sitemapURL)
		}
		s.extractFromSitemapPayload(ctx, sitemapURL, xmlBody, config, collected, visited, diagnostics)
	}
	return collected
}

// extractFromSitemapPayload collects page URLs from one sitemap body and then
// recurses into its child sitemap entries. Page URLs are emitted before any
// child sitemap, which is the source's depth-first order.
func (s *Service) extractFromSitemapPayload(
	ctx context.Context,
	sitemapURL string,
	xmlBody string,
	config normalizedConfig,
	collected *orderedURLSet,
	visited map[string]bool,
	diagnostics *SitemapDiscoveryDiagnostics,
) {
	payload, ok := s.parseSitemapPayload(ctx, sitemapURL, xmlBody)
	if !ok {
		return
	}
	// One parsed document, one parsedSitemaps increment. A fetched but malformed
	// sitemap stays in fetchedSitemaps without being counted here, exactly like
	// the source's `if (!parsed) return; diagnostics.parsedSitemaps += 1`.
	if diagnostics != nil {
		diagnostics.ParsedSitemaps++
	}
	// One crawl timestamp per sitemap document, exactly like the source's
	// `const crawledAtTs = Date.now()` right after the payload is parsed. The
	// candidate merge keeps the larger value, so a URL repeated across
	// documents ends up with the timestamp of the last document that listed it.
	crawledAtTs := nowMillis()

	for _, entry := range payload.URLs {
		if collected.len() >= config.maxURLs {
			break
		}
		normalized, ok := normalizeURL(entry.Loc)
		if !ok {
			// The source keeps the raw loc when it cannot be normalized.
			normalized = entry.Loc
		}
		if config.patternMatcher != nil && !config.patternMatcher(normalized) {
			continue
		}
		if config.freshnessCutoffTs != nil {
			publishedAt := resolveSitemapEntryPublishedAt(entry)
			if publishedAt != nil && *publishedAt < *config.freshnessCutoffTs {
				continue
			}
		}
		collected.addWithTimestamps(normalized, resolveSitemapEntryPublishedAt(entry), &crawledAtTs)
	}

	for _, child := range payload.ChildSitemaps {
		if collected.len() >= config.maxURLs {
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
		// A child sitemap is only recorded as attempted+fetched once its fetch
		// succeeds. This matches the source, which pushes both lists inside the
		// `if (xmlChild)` branch rather than before the request.
		if diagnostics != nil {
			diagnostics.AttemptedSitemaps = append(diagnostics.AttemptedSitemaps, normalized)
			diagnostics.FetchedSitemaps = append(diagnostics.FetchedSitemaps, normalized)
		}
		s.extractFromSitemapPayload(ctx, normalized, xmlChild, config, collected, visited, diagnostics)
	}
}

// resolveSitemapSeedURLs mirrors resolveSitemapSeedUrls. "robots" and
// "sitemap_only" both read robots.txt and fall back to the ordered common paths
// when robots declares no sitemap; "common_paths" skips the robots probe
// entirely (it still reports the robots URL in the diagnostics, as the source
// does); "disabled" returns no seed at all. A later fetch failure never appends
// the common paths to an already discovered list.
func (s *Service) resolveSitemapSeedURLs(
	ctx context.Context,
	origin string,
	timeoutMs int,
	mode SitemapDiscoveryMode,
	diagnostics *SitemapDiscoveryDiagnostics,
) []string {
	if mode == SitemapDiscoveryModeDisabled {
		return nil
	}
	robotsURL := joinURL(origin, "robots.txt")
	if diagnostics != nil {
		diagnostics.RobotsURL = robotsURL
	}
	var discovered []string
	if mode == SitemapDiscoveryModeRobots || mode == SitemapDiscoveryModeSitemapOnly {
		discovered = s.discoverRobotsSitemapURLs(ctx, robotsURL, timeoutMs)
	}
	if len(discovered) > 0 {
		if diagnostics != nil {
			diagnostics.SeedMethod = SitemapSeedMethodRobots
			diagnostics.RobotsDiscoveredSitemaps = append(diagnostics.RobotsDiscoveredSitemaps, discovered...)
		}
		return discovered
	}
	if diagnostics != nil {
		diagnostics.SeedMethod = SitemapSeedMethodCommonPaths
	}
	seeds := make([]string, 0, len(defaultSitemapSeeds))
	for _, seed := range defaultSitemapSeeds {
		seeds = append(seeds, joinURL(origin, seed))
	}
	return seeds
}

// discoverRobotsSitemapURLs collects the case-insensitive `Sitemap:` lines in
// document order, normalizes each target, drops duplicates and stops at 256.
func (s *Service) discoverRobotsSitemapURLs(ctx context.Context, robotsURL string, timeoutMs int) []string {
	body, ok := s.fetchMaybe(ctx, robotsURL, timeoutMs)
	if !ok || strings.TrimSpace(body) == "" {
		return nil
	}
	discovered := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		match := robotsSitemapLinePattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		normalized, ok := normalizeURL(match[1])
		if !ok || seen[normalized] {
			continue
		}
		seen[normalized] = true
		discovered = append(discovered, normalized)
		if len(discovered) >= 256 {
			break
		}
	}
	return discovered
}

var robotsSitemapLinePattern = regexp.MustCompile(`(?i)^\s*Sitemap:\s*(\S+)\s*$`)

// parseSitemapPayload reuses the parsed payload from the shared cache whenever
// the cached body is byte-identical, otherwise it parses the XML and writes the
// refreshed state back.
func (s *Service) parseSitemapPayload(ctx context.Context, sitemapURL, xmlBody string) (parsedSitemapPayload, bool) {
	state := s.readDiscoveryHTTPState(ctx, sitemapURL)
	if state != nil {
		if cached := normalizeParsedSitemapPayload(state.ParsedSitemapPayload); cached != nil {
			if body, ok := state.cachedBody(); ok && body == xmlBody {
				return *cached, true
			}
		}
	}

	parsed, ok := parseSitemapXML(xmlBody)
	if !ok {
		return parsedSitemapPayload{}, false
	}
	body := xmlBody
	updated := discoveryHTTPState{
		Body:                 &body,
		ParsedSitemapPayload: &parsed,
		UpdatedAt:            time.Now().UnixMilli(),
	}
	if state != nil {
		updated.ETag = state.ETag
		updated.LastModified = state.LastModified
	}
	s.writeDiscoveryHTTPState(ctx, sitemapURL, updated)
	return parsed, true
}

// normalizeParsedSitemapPayload validates a payload read back from the shared
// cache. Nil means "not a usable payload" and forces a re-parse.
func normalizeParsedSitemapPayload(value *parsedSitemapPayload) *parsedSitemapPayload {
	if value == nil {
		return nil
	}
	urls := []parsedSitemapURL{}
	for _, entry := range value.URLs {
		loc := strings.TrimSpace(entry.Loc)
		if loc == "" {
			continue
		}
		urls = append(urls, parsedSitemapURL{
			Loc:               loc,
			LastmodTs:         normalizeTimestamp(entry.LastmodTs),
			NewsPublishedAtTs: normalizeTimestamp(entry.NewsPublishedAtTs),
		})
	}
	children := []parsedSitemapIndexEntry{}
	for _, entry := range value.ChildSitemaps {
		loc := strings.TrimSpace(entry.Loc)
		if loc == "" {
			continue
		}
		children = append(children, parsedSitemapIndexEntry{
			Loc:       loc,
			LastmodTs: normalizeTimestamp(entry.LastmodTs),
		})
	}
	return &parsedSitemapPayload{URLs: urls, ChildSitemaps: children}
}

// normalizeTimestamp mirrors the source normalization: positive finite values
// are floored, future values are clamped to now, everything else is dropped.
func normalizeTimestamp(value *int64) *int64 {
	if value == nil || *value <= 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	normalized := *value
	if normalized > now {
		normalized = now
	}
	return &normalized
}

// resolveSitemapEntryPublishedAt prefers the news publication date over
// lastmod.
func resolveSitemapEntryPublishedAt(entry parsedSitemapURL) *int64 {
	if entry.NewsPublishedAtTs != nil {
		return entry.NewsPublishedAtTs
	}
	return entry.LastmodTs
}

// parseSitemapXML parses urlset/url and sitemapindex/sitemap entries. Namespace
// prefixes are ignored (the local name is matched), CDATA and plain text are
// both accepted, and the document order of the entries is preserved. A parse
// failure reports not-ok, which makes the caller skip this document exactly like
// the source's caught parse error.
func parseSitemapXML(xmlBody string) (parsedSitemapPayload, bool) {
	payload := parsedSitemapPayload{URLs: []parsedSitemapURL{}, ChildSitemaps: []parsedSitemapIndexEntry{}}
	decoder := xml.NewDecoder(strings.NewReader(xmlBody))
	decoder.Strict = false

	root := ""
	var currentURL *parsedSitemapURL
	var currentIndex *parsedSitemapIndexEntry
	var text strings.Builder

	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return parsedSitemapPayload{}, false
		}
		switch typed := token.(type) {
		case xml.StartElement:
			name := typed.Name.Local
			text.Reset()
			switch {
			case root == "" && name == "urlset":
				root = "urlset"
			case root == "" && name == "sitemapindex":
				root = "sitemapindex"
			case root == "urlset" && name == "url":
				currentURL = &parsedSitemapURL{}
			case root == "sitemapindex" && name == "sitemap":
				currentIndex = &parsedSitemapIndexEntry{}
			}
		case xml.CharData:
			text.Write(typed)
		case xml.EndElement:
			name := typed.Name.Local
			value := strings.TrimSpace(text.String())
			text.Reset()
			switch {
			case currentURL != nil && name == "loc" && currentURL.Loc == "":
				currentURL.Loc = value
			case currentURL != nil && name == "lastmod" && currentURL.LastmodTs == nil:
				currentURL.LastmodTs = parseSitemapTimestamp(value)
			case currentURL != nil && isNewsPublicationDateElement(name) && currentURL.NewsPublishedAtTs == nil:
				currentURL.NewsPublishedAtTs = parseSitemapTimestamp(value)
			case currentIndex != nil && name == "loc" && currentIndex.Loc == "":
				currentIndex.Loc = value
			case currentIndex != nil && name == "lastmod" && currentIndex.LastmodTs == nil:
				currentIndex.LastmodTs = parseSitemapTimestamp(value)
			case name == "url" && currentURL != nil:
				if currentURL.Loc != "" {
					payload.URLs = append(payload.URLs, *currentURL)
				}
				currentURL = nil
			case name == "sitemap" && currentIndex != nil:
				if currentIndex.Loc != "" {
					payload.ChildSitemaps = append(payload.ChildSitemaps, *currentIndex)
				}
				currentIndex = nil
			}
		}
	}
	return payload, true
}

// isNewsPublicationDateElement matches the three spellings the source looks for
// below a news:news node.
func isNewsPublicationDateElement(name string) bool {
	lowered := strings.ToLower(name)
	return lowered == "publication_date" || lowered == "publicationdate"
}

var sitemapTimestampLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
	"2006/01/02",
	time.RFC1123,
	time.RFC1123Z,
	time.RFC850,
	time.ANSIC,
}

// parseSitemapTimestamp mirrors Date.parse for the timestamp spellings found in
// real sitemaps: an explicit offset is honored, a bare date/time is local time
// and a date-only value is UTC midnight.
func parseSitemapTimestamp(value string) *int64 {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	for _, layout := range sitemapTimestampLayouts {
		var (
			parsed time.Time
			err    error
		)
		switch layout {
		case time.RFC3339Nano, time.RFC3339, "2006-01-02", time.RFC1123, time.RFC1123Z, time.RFC850, time.ANSIC:
			parsed, err = time.Parse(layout, trimmed)
		default:
			parsed, err = time.ParseInLocation(layout, trimmed, time.Local)
		}
		if err == nil {
			millis := parsed.UnixMilli()
			return &millis
		}
	}
	return nil
}

// orderedURLSet keeps first-seen insertion order while dropping duplicates and
// merging the timestamps of a repeated URL, which is what the source's
// Map + mergeDiscoveryCandidates pair does: a URL listed in two sitemaps keeps
// the larger publishedAtTs and the larger crawledAtTs.
type orderedURLSet struct {
	seen    map[string]bool
	values  []string
	entries map[string]discoveredURLTimestamps
}

// discoveredURLTimestamps is the per-URL signal pair mergeDiscoveryCandidates
// keeps for the callers that need CrawlDiscoveryCandidate parity.
type discoveredURLTimestamps struct {
	publishedAtTs *int64
	crawledAtTs   *int64
}

func newOrderedURLSet() *orderedURLSet {
	return &orderedURLSet{seen: map[string]bool{}}
}

func (s *orderedURLSet) addWithTimestamps(value string, publishedAtTs, crawledAtTs *int64) {
	if s.seen[value] {
		existing := s.entries[value]
		existing.publishedAtTs = resolveBetterTimestamp(existing.publishedAtTs, publishedAtTs)
		existing.crawledAtTs = resolveBetterTimestamp(existing.crawledAtTs, crawledAtTs)
		if s.entries == nil {
			s.entries = map[string]discoveredURLTimestamps{}
		}
		s.entries[value] = existing
		return
	}
	s.seen[value] = true
	s.values = append(s.values, value)
	if publishedAtTs != nil || crawledAtTs != nil {
		if s.entries == nil {
			s.entries = map[string]discoveredURLTimestamps{}
		}
		s.entries[value] = discoveredURLTimestamps{
			publishedAtTs: publishedAtTs,
			crawledAtTs:   crawledAtTs,
		}
	}
}

// timestamps returns the merged publish/crawl timestamps for one discovered URL.
func (s *orderedURLSet) timestamps(value string) (*int64, *int64) {
	if s.entries == nil {
		return nil, nil
	}
	entry := s.entries[value]
	return entry.publishedAtTs, entry.crawledAtTs
}

func (s *orderedURLSet) len() int { return len(s.values) }

func (s *orderedURLSet) slice(limit int) []string {
	return sliceUpTo(s.values, limit)
}

// sliceUpTo returns at most limit entries; a non-positive limit is a no-op.
func sliceUpTo[T any](values []T, limit int) []T {
	if limit >= 0 && len(values) > limit {
		return values[:limit]
	}
	return values
}
