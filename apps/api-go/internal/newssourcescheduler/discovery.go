package newssourcescheduler

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
)

// This file ports resolveSeedCandidates, discoverSeedCandidates and the cached
// candidate normalization. The cache value is the JSON array of
// CrawlDiscoveryCandidate objects NestJS writes, so either implementation can
// read the other's entry; a process-local singleflight (O8) collapses concurrent
// loads for the same key before the Redis cache.wrap lock is taken.

// scoredSeedCandidate is CrawlDiscoveryCandidate after scoring with the
// effective timestamp.
type scoredSeedCandidate struct {
	URL               string
	RelevanceScore    *float64
	PublishedAtTs     *int64
	CrawledAtTs       *int64
	EffectiveTs       *int64
	TimestampSource   string
	PrefetchedArticle *prefetchedArticle
}

// resolveSeedCandidates is resolveSeedCandidates.
func (s *Service) resolveSeedCandidates(
	ctx context.Context,
	source *source,
	seed *seedConfig,
	freshnessWindowDays int,
	overlay *workflowOverlay,
	cacheTTLOverride *int,
) ([]scoredSeedCandidate, error) {
	if seed.Mode == seedModeSitemap && seed.Domain == nil {
		return []scoredSeedCandidate{}, nil
	}
	cacheTTLSeconds := seed.CacheTTLSeconds
	if cacheTTLOverride != nil {
		cacheTTLSeconds = *cacheTTLOverride
	}
	cacheKey := buildSeedDiscoveryCacheKey(source.ID, source.URL, seed, cacheTTLSeconds)

	freshnessDays := freshnessWindowDays
	if freshnessDays < 1 {
		freshnessDays = 1
	}
	if freshnessDays > maxSeedFreshnessWindowDays {
		freshnessDays = maxSeedFreshnessWindowDays
	}
	freshnessCutoffTs := s.now().UnixMilli() - int64(freshnessDays)*24*60*60*1000

	discovered, err := s.resolveDiscoverySingleflight(ctx, cacheKey, func() ([]json.RawMessage, error) {
		return s.wrapCache(ctx, cacheKey, time.Duration(cacheTTLSeconds)*time.Second, func(ctx context.Context) ([]json.RawMessage, error) {
			return s.discoverSeedCandidates(ctx, source, seed, freshnessCutoffTs, overlay)
		})
	})
	if err != nil {
		return nil, err
	}

	merged := map[string]discoveredCandidate{}
	order := make([]string, 0, len(discovered))
	for _, entry := range discovered {
		incoming, ok := normalizeCachedSeedDiscoveryCandidate(entry)
		if !ok {
			continue
		}
		existing, seen := merged[incoming.URL]
		if !seen {
			order = append(order, incoming.URL)
		}
		merged[incoming.URL] = mergeSeedDiscoveryCandidate(existing, incoming)
	}

	scored := make([]scoredSeedCandidate, 0, len(order))
	for _, key := range order {
		entry := merged[key]
		candidate := scoredSeedCandidate{
			URL:               entry.URL,
			RelevanceScore:    entry.RelevanceScore,
			PublishedAtTs:     resolveTimestamp(entry.PublishedAtTs),
			CrawledAtTs:       resolveTimestamp(entry.CrawledAtTs),
			PrefetchedArticle: entry.PrefetchedArticle,
			TimestampSource:   "none",
		}
		if candidate.RelevanceScore == nil {
			candidate.RelevanceScore = scoreURL(entry.URL, seed.QueryTokens)
		}
		candidate.EffectiveTs = resolveEffectiveSeedTimestamp(candidate.PublishedAtTs, candidate.CrawledAtTs)
		candidate.TimestampSource = resolveSeedTimestampSource(candidate.PublishedAtTs, candidate.CrawledAtTs)
		if seed.ScoreThreshold > 0 {
			score := 0.0
			if candidate.RelevanceScore != nil {
				score = *candidate.RelevanceScore
			}
			if score < seed.ScoreThreshold {
				continue
			}
		}
		if candidate.EffectiveTs != nil && *candidate.EffectiveTs < freshnessCutoffTs {
			continue
		}
		scored = append(scored, candidate)
	}

	collator := rootCollator()
	sort.SliceStable(scored, func(left, right int) bool {
		leftTs := int64(-1)
		if scored[left].EffectiveTs != nil {
			leftTs = *scored[left].EffectiveTs
		}
		rightTs := int64(-1)
		if scored[right].EffectiveTs != nil {
			rightTs = *scored[right].EffectiveTs
		}
		if leftTs != rightTs {
			return leftTs > rightTs
		}
		leftScore := 0.0
		if scored[left].RelevanceScore != nil {
			leftScore = *scored[left].RelevanceScore
		}
		rightScore := 0.0
		if scored[right].RelevanceScore != nil {
			rightScore = *scored[right].RelevanceScore
		}
		if leftScore != rightScore {
			return leftScore > rightScore
		}
		return collator.CompareString(scored[left].URL, scored[right].URL) < 0
	})
	if len(scored) > seed.MaxURLs {
		scored = scored[:seed.MaxURLs]
	}
	return scored, nil
}

// discoverSeedCandidates is discoverSeedCandidates. The loader result is the
// raw JSON array so the Redis entry is the CrawlDiscoveryCandidate array NestJS
// caches.
func (s *Service) discoverSeedCandidates(
	ctx context.Context,
	source *source,
	seed *seedConfig,
	freshnessCutoffTs int64,
	overlay *workflowOverlay,
) ([]json.RawMessage, error) {
	if s.discovery == nil {
		return nil, nil
	}
	switch seed.Mode {
	case seedModeRSS:
		input := crawlmetadata.RSSDiscoveryInput{
			FeedURL:  source.URL,
			MaxURLs:  intPtr(seed.MaxURLs),
			RSSFetch: rssFetchOptions(seed),
		}
		if seed.FeedURL != nil {
			input.FeedURL = *seed.FeedURL
		}
		candidates, err := s.discovery.DiscoverRSSCandidates(ctx, input)
		if err != nil {
			return nil, err
		}
		return encodeDiscoveryCandidates(candidates), nil

	case seedModeList, seedModeDeep:
		crawlOptions := s.seedCrawlOptions(source, overlay, seed.Mode)
		domain := ""
		if seed.Domain != nil {
			domain = *seed.Domain
		}
		pattern := ""
		if seed.Pattern != nil {
			pattern = *seed.Pattern
		}
		if seed.Mode == seedModeList {
			candidates, err := s.discovery.DiscoverListCandidates(ctx, crawlmetadata.ListDiscoveryInput{
				URL:                 source.URL,
				Domain:              domain,
				Pattern:             pattern,
				MaxURLs:             intPtr(seed.MaxURLs),
				ListMaxPages:        intPtr(seed.ListMaxPages),
				ListPageConcurrency: intPtr(seed.ListPageConcurrency),
				FollowPagination:    boolPtr(seed.FollowPagination),
				CrawlOptions:        crawlOptions,
			})
			if err != nil {
				return nil, err
			}
			return encodeDiscoveryCandidates(candidates), nil
		}
		deepOptions := json.RawMessage(nil)
		if seed.Deep != nil {
			deepOptions = mustJSON(seedDeepOptionsInput{
				MaxPages:            seed.Deep.MaxPages,
				MaxDepth:            seed.Deep.MaxDepth,
				TimeBudgetSeconds:   seed.Deep.TimeBudgetSeconds,
				PageConcurrency:     seed.Deep.PageConcurrency,
				ScoreThreshold:      seed.Deep.ScoreThreshold,
				CandidatePoolSize:   seed.Deep.CandidatePoolSize,
				HeadFetchTopK:       seed.Deep.HeadFetchTopK,
				PreferPathDate:      seed.Deep.PreferPathDate,
				EnableSecondaryHubs: seed.Deep.EnableSecondaryHubs,
				IgnoreRobotsTxt:     seed.Deep.IgnoreRobotsTxt,
			})
		}
		candidates, err := s.discovery.DiscoverDeepCandidates(ctx, crawlmetadata.DeepDiscoveryInput{
			URL:          source.URL,
			Domain:       domain,
			Pattern:      pattern,
			Query:        strings.Join(seed.QueryTokens, " "),
			MaxURLs:      intPtr(seed.MaxURLs),
			CrawlOptions: crawlOptions,
			Deep:         deepOptions,
		})
		if err != nil {
			return nil, err
		}
		return encodeDiscoveryCandidates(candidates), nil

	default:
		domain := ""
		if seed.Domain != nil {
			domain = *seed.Domain
		}
		pattern := ""
		if seed.Pattern != nil {
			pattern = *seed.Pattern
		}
		candidates, err := s.discovery.DiscoverSitemapSeedCandidates(ctx, domain, pattern, intPtr(seed.MaxURLs), &freshnessCutoffTs)
		if err != nil {
			return nil, err
		}
		return encodeDiscoveryCandidates(candidates), nil
	}
}

// seedCrawlOptions merges the active template options, the source config merged
// with the workflow overlay, and the automatic quality defaults.
func (s *Service) seedCrawlOptions(source *source, overlay *workflowOverlay, mode seedMode) json.RawMessage {
	config, _ := decodeObject(source.Config)
	merged := mergeWorkflowSourceConfig(config, overlay)
	var templateOptions jsonObject
	if source.CrawlTemplateActive {
		templateOptions, _ = decodeObject(source.CrawlTemplateOptions)
	}
	var sourceOptions jsonObject
	if merged != nil {
		sourceOptions, _ = merged.objectField("crawlOptions")
	}
	return mustJSON(s.withAutoCrawlQualityDefaults(mergeObjects(templateOptions, sourceOptions), mode))
}

// seedDeepOptionsInput is the deep object DeepDiscoveryInput accepts.
type seedDeepOptionsInput struct {
	MaxPages            int     `json:"maxPages"`
	MaxDepth            int     `json:"maxDepth"`
	TimeBudgetSeconds   int     `json:"timeBudgetSeconds"`
	PageConcurrency     int     `json:"pageConcurrency"`
	ScoreThreshold      float64 `json:"scoreThreshold"`
	CandidatePoolSize   int     `json:"candidatePoolSize"`
	HeadFetchTopK       int     `json:"headFetchTopK"`
	PreferPathDate      bool    `json:"preferPathDate"`
	EnableSecondaryHubs bool    `json:"enableSecondaryHubs"`
	IgnoreRobotsTxt     bool    `json:"ignoreRobotsTxt"`
}

// rssFetchOptions projects the resolved RSS fetch policy onto the discovery
// input.
func rssFetchOptions(seed *seedConfig) *crawlmetadata.RSSFetchOptions {
	if seed.RSSFetch == nil {
		return nil
	}
	timeout := seed.RSSFetch.RequestTimeoutMs
	return &crawlmetadata.RSSFetchOptions{
		RequestTimeoutMs:   &timeout,
		BodySourceStrategy: seed.RSSFetch.BodySourceStrategy,
		NoBodyPolicy:       seed.RSSFetch.NoBodyPolicy,
	}
}

// encodeDiscoveryCandidates renders the cache entries with the NestJS key
// names.
func encodeDiscoveryCandidates(candidates []crawlmetadata.DiscoveryCandidate) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(candidates))
	for _, candidate := range candidates {
		entry := cachedDiscoveryCandidate{
			URL:            candidate.URL,
			RelevanceScore: candidate.RelevanceScore,
			PublishedAtTs:  candidate.PublishedAtTs,
			CrawledAtTs:    candidate.CrawledAtTs,
		}
		if candidate.PrefetchedArticle != nil {
			entry.PrefetchedArticle = &prefetchedArticle{
				Title:       candidate.PrefetchedArticle.Title,
				Description: candidate.PrefetchedArticle.Description,
				Author:      candidate.PrefetchedArticle.Author,
				Markdown:    candidate.PrefetchedArticle.Markdown,
				PublishedAt: candidate.PrefetchedArticle.PublishedAt,
				Metadata:    candidate.PrefetchedArticle.Metadata,
			}
		}
		out = append(out, mustJSON(entry))
	}
	return out
}

// cachedDiscoveryCandidate is the CrawlDiscoveryCandidate JSON shape.
type cachedDiscoveryCandidate struct {
	URL               string             `json:"url"`
	RelevanceScore    *float64           `json:"relevanceScore,omitempty"`
	PublishedAtTs     *int64             `json:"publishedAtTs,omitempty"`
	CrawledAtTs       *int64             `json:"crawledAtTs,omitempty"`
	PrefetchedArticle *prefetchedArticle `json:"prefetchedArticle,omitempty"`
}

// cachedCandidateRecord is the lenient view of one cache entry: a legacy string
// URL or an object with unknown-typed fields.
type cachedCandidateRecord struct {
	URL               json.RawMessage `json:"url"`
	RelevanceScore    json.RawMessage `json:"relevanceScore"`
	PublishedAtTs     json.RawMessage `json:"publishedAtTs"`
	CrawledAtTs       json.RawMessage `json:"crawledAtTs"`
	PrefetchedArticle json.RawMessage `json:"prefetchedArticle"`
}

// normalizeCachedSeedDiscoveryCandidate is normalizeCachedSeedDiscoveryCandidate.
func normalizeCachedSeedDiscoveryCandidate(raw json.RawMessage) (discoveredCandidate, bool) {
	trimmed := trimJS(string(raw))
	if trimmed == "" {
		return discoveredCandidate{}, false
	}
	if trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return discoveredCandidate{}, false
		}
		urlValue := trimJS(value)
		if urlValue == "" {
			return discoveredCandidate{}, false
		}
		return discoveredCandidate{
			URL:           urlValue,
			PublishedAtTs: parsePublishedAtFromURL(urlValue),
		}, true
	}
	var record cachedCandidateRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return discoveredCandidate{}, false
	}
	urlValue := ""
	if len(record.URL) > 0 {
		var text string
		if err := json.Unmarshal(record.URL, &text); err == nil {
			urlValue = trimJS(text)
		}
	}
	if urlValue == "" {
		return discoveredCandidate{}, false
	}
	candidate := discoveredCandidate{URL: urlValue}
	if value, ok := readNumber(record.RelevanceScore); ok {
		candidate.RelevanceScore = &value
	}
	fallback := parsePublishedAtFromURL(urlValue)
	if value := resolveTimestampRaw(record.PublishedAtTs); value != nil {
		candidate.PublishedAtTs = value
	} else {
		candidate.PublishedAtTs = fallback
	}
	candidate.CrawledAtTs = resolveTimestampRaw(record.CrawledAtTs)
	candidate.PrefetchedArticle = normalizePrefetchedArticleRaw(record.PrefetchedArticle)
	return candidate, true
}

// mergeSeedDiscoveryCandidate is mergeSeedDiscoveryCandidate.
func mergeSeedDiscoveryCandidate(existing, incoming discoveredCandidate) discoveredCandidate {
	if existing.URL == "" {
		return incoming
	}
	var score *float64
	switch {
	case existing.RelevanceScore == nil && incoming.RelevanceScore == nil:
		score = nil
	case existing.RelevanceScore == nil:
		score = incoming.RelevanceScore
	case incoming.RelevanceScore == nil:
		score = existing.RelevanceScore
	case *incoming.RelevanceScore > *existing.RelevanceScore:
		score = incoming.RelevanceScore
	default:
		score = existing.RelevanceScore
	}
	return discoveredCandidate{
		URL:               incoming.URL,
		RelevanceScore:    score,
		PublishedAtTs:     resolveTimestampMax(existing.PublishedAtTs, incoming.PublishedAtTs),
		CrawledAtTs:       resolveTimestampMax(existing.CrawledAtTs, incoming.CrawledAtTs),
		PrefetchedArticle: mergePrefetchedArticle(existing.PrefetchedArticle, incoming.PrefetchedArticle),
	}
}

// resolveTimestamp is resolveTimestamp: positive integers only, capped at now.
func resolveTimestamp(value *int64) *int64 {
	return resolveTimestampAt(value, time.Now().UnixMilli())
}

// resolveTimestampAt is resolveTimestamp with an explicit clock.
func resolveTimestampAt(value *int64, now int64) *int64 {
	if value == nil || *value <= 0 {
		return nil
	}
	normalized := *value
	if normalized > now {
		normalized = now
	}
	return &normalized
}

// resolveTimestampMax is resolveTimestampMax.
func resolveTimestampMax(first, second *int64) *int64 {
	left := resolveTimestamp(first)
	right := resolveTimestamp(second)
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	if *right > *left {
		return right
	}
	return left
}

// resolveTimestampRaw reads a JSON number timestamp and applies resolveTimestamp.
func resolveTimestampRaw(raw json.RawMessage) *int64 {
	if len(raw) == 0 {
		return nil
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return nil
	}
	if number <= 0 {
		return nil
	}
	value := int64(floorFloat(number))
	return resolveTimestamp(&value)
}

// floorFloat is Math.floor.
func floorFloat(value float64) float64 {
	rounded := float64(int64(value))
	if rounded > value {
		return rounded - 1
	}
	return rounded
}

// resolveEffectiveSeedTimestamp is resolveEffectiveSeedTimestamp.
func resolveEffectiveSeedTimestamp(publishedAtTs, crawledAtTs *int64) *int64 {
	if value := resolveTimestamp(publishedAtTs); value != nil {
		return value
	}
	if value := resolveTimestamp(crawledAtTs); value != nil {
		return value
	}
	return nil
}

// resolveSeedTimestampSource is resolveSeedTimestampSource.
func resolveSeedTimestampSource(publishedAtTs, crawledAtTs *int64) string {
	if resolveTimestamp(publishedAtTs) != nil {
		return "published"
	}
	if resolveTimestamp(crawledAtTs) != nil {
		return "crawled"
	}
	return "none"
}

// normalizePrefetchedArticleRaw is normalizePrefetchedArticle.
func normalizePrefetchedArticleRaw(raw json.RawMessage) *prefetchedArticle {
	object, ok := decodeObject(raw)
	if !ok {
		return nil
	}
	markdown, _ := object.stringField("markdown")
	markdown = trimJS(markdown)
	if markdown == "" {
		return nil
	}
	article := &prefetchedArticle{Markdown: markdown}
	if value, ok := object.stringField("title"); ok {
		trimmed := trimJS(value)
		if trimmed != "" {
			article.Title = &trimmed
		}
	}
	if value, ok := object.stringField("description"); ok {
		trimmed := trimJS(value)
		if trimmed != "" {
			article.Description = &trimmed
		}
	}
	if value, ok := object.stringField("author"); ok {
		trimmed := trimJS(value)
		if trimmed != "" {
			article.Author = &trimmed
		}
	}
	if value, ok := object.stringField("publishedAt"); ok {
		trimmed := trimJS(value)
		if trimmed != "" {
			article.PublishedAt = &trimmed
		}
	}
	if metadata, ok := object.objectField("metadata"); ok {
		article.Metadata = mustJSON(metadata)
	}
	return article
}

// mergePrefetchedArticle is mergePrefetchedArticle: the longer markdown wins and
// the metadata objects merge with the primary one last.
func mergePrefetchedArticle(existing, incoming *prefetchedArticle) *prefetchedArticle {
	if existing == nil {
		return incoming
	}
	if incoming == nil {
		return existing
	}
	primary := incoming
	secondary := existing
	if len(existing.Markdown) > len(incoming.Markdown) {
		primary = existing
		secondary = incoming
	}
	primaryMetadata, _ := decodeObject(primary.Metadata)
	secondaryMetadata, _ := decodeObject(secondary.Metadata)
	var metadata json.RawMessage
	if primaryMetadata != nil || secondaryMetadata != nil {
		metadata = mustJSON(mergeObjects(secondaryMetadata, primaryMetadata))
	}
	return &prefetchedArticle{
		Title:       firstNonNilString(primary.Title, secondary.Title),
		Description: firstNonNilString(primary.Description, secondary.Description),
		Author:      firstNonNilString(primary.Author, secondary.Author),
		Markdown:    primary.Markdown,
		PublishedAt: firstNonNilString(primary.PublishedAt, secondary.PublishedAt),
		Metadata:    metadata,
	}
}

func firstNonNilString(first, second *string) *string {
	if first != nil {
		return first
	}
	return second
}

var (
	slashDatePattern  = regexp.MustCompile(`/(20\d{2})/([01]\d)/([0-3]\d)(?:/|$)`)
	dashedDatePattern = regexp.MustCompile(`(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)`)
)

// parsePublishedAtFromURL is parsePublishedAtFromUrl.
func parsePublishedAtFromURL(value string) *int64 {
	parsed, err := url.Parse(value)
	if err != nil {
		return nil
	}
	path := parsed.Path
	for _, pattern := range []*regexp.Regexp{slashDatePattern, dashedDatePattern} {
		match := pattern.FindStringSubmatch(path)
		if match == nil {
			continue
		}
		year, _ := strconv.Atoi(match[1])
		month, _ := strconv.Atoi(match[2])
		day, _ := strconv.Atoi(match[3])
		if timestamp := utcDateTimestamp(year, month, day); timestamp != nil {
			return timestamp
		}
	}
	return nil
}

// utcDateTimestamp is the Date.UTC + round-trip check of parsePublishedAtFromUrl.
func utcDateTimestamp(year, month, day int) *int64 {
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return nil
	}
	value := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC).UnixMilli()
	check := time.UnixMilli(value).UTC()
	if check.Year() != year || int(check.Month()) != month || check.Day() != day {
		return nil
	}
	return resolveTimestamp(&value)
}

func intPtr(value int) *int {
	return &value
}

func boolPtr(value bool) *bool {
	return &value
}
