package crawlstrategyruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// This file ports NewsSourceService.preview (news-source.service.ts:631-918)
// and the helpers it calls: mergeWorkflowSourceConfig (:1166),
// normalizeSeedConfig (:1252), normalizeSeedDomain/FeedUrl/RssFetchConfig
// (:1390-1477), readDeepDiscoveryFailureStats (:968) with the shared
// deep-discovery-failure normalization, findRecentCrawls (:1582),
// findActivePipelineJobs (:1607) and countActivePipelineJobs (:1644).
//
// The preview is read-only: it never writes a row or enqueues work. The only
// outbound work is the discovery + extract chain (SSRF-guarded, timed out).

// PreviewService serves GET /api/admin/news-sources/:id/preview.
type PreviewService struct {
	db                 *sql.DB
	redis              *redis.Client
	discovery          *crawlmetadata.Discovery
	workflows          *crawlworkflow.Service
	inFlightLookbackMs int
}

// NewPreviewService builds the preview service. inFlightLookbackMs is
// NEWS_SOURCE_SCHEDULER_INFLIGHT_LOOKBACK_MS (default 21_600_000).
func NewPreviewService(db *sql.DB, redisClient *redis.Client, discovery *crawlmetadata.Discovery, workflows *crawlworkflow.Service, inFlightLookbackMs int) *PreviewService {
	if inFlightLookbackMs <= 0 {
		inFlightLookbackMs = 21_600_000
	}
	return &PreviewService{
		db:                 db,
		redis:              redisClient,
		discovery:          discovery,
		workflows:          workflows,
		inFlightLookbackMs: inFlightLookbackMs,
	}
}

// NewsSourceRSSFetchConfig is NewsSourceRssFetchConfig.
type NewsSourceRSSFetchConfig struct {
	Enabled            bool   `json:"enabled"`
	RequestTimeoutMs   int    `json:"requestTimeoutMs"`
	BodySourceStrategy string `json:"bodySourceStrategy"`
	NoBodyPolicy       string `json:"noBodyPolicy"`
}

// NewsSourceDeepSeedConfig is NewsSourceDeepSeedConfig.
type NewsSourceDeepSeedConfig struct {
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

// NewsSourceSeedConfig is NewsSourceSeedConfig.
type NewsSourceSeedConfig struct {
	Enabled             bool                      `json:"enabled"`
	Mode                string                    `json:"mode"`
	Domain              *string                   `json:"domain,omitempty"`
	Pattern             *string                   `json:"pattern,omitempty"`
	FeedURL             *string                   `json:"feedUrl,omitempty"`
	RSSFetch            *NewsSourceRSSFetchConfig `json:"rssFetch,omitempty"`
	MaxURLs             int                       `json:"maxUrls"`
	MaxNewURLsPerRun    int                       `json:"maxNewUrlsPerRun"`
	ListMaxPages        int                       `json:"listMaxPages"`
	ListPageConcurrency int                       `json:"listPageConcurrency"`
	FollowPagination    bool                      `json:"followPagination"`
	Query               *string                   `json:"query,omitempty"`
	ScoreThreshold      float64                   `json:"scoreThreshold"`
	Concurrency         int                       `json:"concurrency"`
	DedupeWindowHours   int                       `json:"dedupeWindowHours"`
	QueryParamAllowlist []string                  `json:"queryParamAllowlist"`
	Deep                *NewsSourceDeepSeedConfig `json:"deep,omitempty"`
}

// NewsSourcePreviewDeepError is NewsSourcePreviewDeepError.
type NewsSourcePreviewDeepError struct {
	Code    string  `json:"code"`
	Message string  `json:"message"`
	Detail  *string `json:"detail,omitempty"`
}

// NewsSourcePreviewCodeCount is one byCode entry.
type NewsSourcePreviewCodeCount struct {
	Code  string `json:"code"`
	Count int    `json:"count"`
}

// NewsSourcePreviewDeepFailureStats is NewsSourcePreviewDeepFailureStats.
type NewsSourcePreviewDeepFailureStats struct {
	Total24h         int                          `json:"total24h"`
	Streak           int                          `json:"streak"`
	ByCode           []NewsSourcePreviewCodeCount `json:"byCode"`
	LastFailureAt    *string                      `json:"lastFailureAt"`
	LastCode         *string                      `json:"lastCode"`
	LastMessage      *string                      `json:"lastMessage"`
	LastDetail       *string                      `json:"lastDetail"`
	NextRetryAt      *string                      `json:"nextRetryAt"`
	CircuitOpenUntil *string                      `json:"circuitOpenUntil"`
}

type singlePreviewCandidate struct {
	URL            string  `json:"url"`
	Status         string  `json:"status"`
	AlreadyCrawled bool    `json:"alreadyCrawled"`
	AlreadyQueued  bool    `json:"alreadyQueued"`
	InFlightStatus *string `json:"inFlightStatus"`
}

type seedPreviewCandidate struct {
	URL                string   `json:"url"`
	Status             string   `json:"status"`
	Title              *string  `json:"title,omitempty"`
	Description        *string  `json:"description,omitempty"`
	Author             *string  `json:"author,omitempty"`
	RelevanceScore     *float64 `json:"relevanceScore,omitempty"`
	PublishedAt        *string  `json:"publishedAt"`
	CrawledAt          *string  `json:"crawledAt"`
	EffectiveAt        *string  `json:"effectiveAt"`
	TimestampSource    string   `json:"timestampSource"`
	PublishDateMissing bool     `json:"publishDateMissing"`
	AlreadyCrawled     bool     `json:"alreadyCrawled"`
	LastCrawlAt        *string  `json:"lastCrawlAt"`
	AlreadyQueued      bool     `json:"alreadyQueued"`
	InFlightStatus     *string  `json:"inFlightStatus"`
	Error              *string  `json:"error,omitempty"`
}

type singlePreviewResponse struct {
	Mode          string                         `json:"mode"`
	SourceID      string                         `json:"sourceId"`
	URL           string                         `json:"url"`
	Name          string                         `json:"name"`
	Candidates    []singlePreviewCandidate       `json:"candidates"`
	InFlightCount int                            `json:"inFlightCount"`
	InFlightLimit int                            `json:"inFlightLimit"`
	ScheduleCount int                            `json:"scheduleCount"`
	SkippedCount  int                            `json:"skippedCount"`
	Seed          *NewsSourceSeedConfig          `json:"seed"`
	Workflow      *crawlworkflow.WorkflowSummary `json:"workflow"`
}

type seedPreviewResponse struct {
	Mode                string                             `json:"mode"`
	SourceID            string                             `json:"sourceId"`
	URL                 string                             `json:"url"`
	Name                string                             `json:"name"`
	Seed                *NewsSourceSeedConfig              `json:"seed"`
	Candidates          []seedPreviewCandidate             `json:"candidates"`
	AvailableToSchedule int                                `json:"availableToSchedule"`
	InFlightCount       int                                `json:"inFlightCount"`
	InFlightLimit       int                                `json:"inFlightLimit"`
	ScheduleCount       int                                `json:"scheduleCount"`
	SkippedCount        int                                `json:"skippedCount"`
	DeepPreviewError    *NewsSourcePreviewDeepError        `json:"deepPreviewError,omitempty"`
	DeepFailureStats    *NewsSourcePreviewDeepFailureStats `json:"deepFailureStats,omitempty"`
	Workflow            *crawlworkflow.WorkflowSummary     `json:"workflow"`
}

type previewSourceRow struct {
	ID                  string
	OrgID               string
	Name                string
	URL                 string
	Config              []byte
	CrawlTemplateID     sql.NullString
	WorkflowID          sql.NullString
	WorkflowVersionID   sql.NullString
	WorkflowBindingMode string
}

// Preview ports preview. The returned value is one of the two response shapes.
func (s *PreviewService) Preview(ctx context.Context, orgID, sourceID string) (any, error) {
	source, err := s.loadSource(ctx, sourceID)
	if err != nil {
		return nil, err
	}
	if source.OrgID != orgID {
		return nil, newStatus(404, "News source not found")
	}

	activeCutoff := time.Now().Add(-time.Duration(s.inFlightLookbackMs) * time.Millisecond)

	config := decodeConfigObject(source.Config)

	// O7: the workflow overlay compile and the template read are independent.
	var (
		overlay      *crawlworkflow.CompiledNewsSourceOverlay
		overlayErr   error
		templateOpts map[string]json.RawMessage
		templateErr  error
		templateOK   bool
		waitGroup    sync.WaitGroup
	)
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		overlay, overlayErr = s.workflows.CompileNewsSourceOverlay(ctx, orgID, nullStringValue(source.WorkflowID), nullStringValue(source.WorkflowVersionID))
	}()
	go func() {
		defer waitGroup.Done()
		templateOpts, templateOK, templateErr = s.loadTemplateCrawlOptions(ctx, nullStringValue(source.CrawlTemplateID))
	}()
	waitGroup.Wait()
	// Error precedence follows the original sequential order.
	if overlayErr != nil {
		return nil, overlayErr
	}
	if templateErr != nil {
		return nil, templateErr
	}

	effectiveConfig := mergeWorkflowSourceConfig(config, overlay)

	var sourceCrawlOptions map[string]json.RawMessage
	if record, ok := objectOfRaw(effectiveConfig["crawlOptions"]); ok {
		sourceCrawlOptions = record
	}
	var templateCrawlOptions map[string]json.RawMessage
	if templateOK {
		templateCrawlOptions = templateOpts
	}
	crawlOptions := mergeCrawlOptions(templateCrawlOptions, sourceCrawlOptions)
	if len(crawlOptions) > 0 {
		if err := crawlprofile.AssertNoUnsupportedProxy(rawOfObject(crawlOptions), "crawlOptions"); err != nil {
			return nil, err
		}
	}

	seedConfig := normalizeSeedConfig(effectiveConfig, source.URL)
	inFlightLimit := 1
	if seedConfig != nil && seedConfig.Enabled {
		inFlightLimit = seedConfig.MaxNewURLsPerRun
	}
	inFlightCount, err := s.countActivePipelineJobs(ctx, source.ID, activeCutoff, inFlightLimit)
	if err != nil {
		return nil, err
	}
	capacity := inFlightLimit - inFlightCount
	if capacity < 0 {
		capacity = 0
	}
	var workflowSummary *crawlworkflow.WorkflowSummary
	if overlay != nil {
		summary := overlay.WorkflowSummary
		workflowSummary = &summary
	}

	if seedConfig == nil || !seedConfig.Enabled {
		active, err := s.findActivePipelineJobs(ctx, source.ID, []string{source.URL}, activeCutoff)
		if err != nil {
			return nil, err
		}
		inFlightStatus := active[source.URL]
		scheduleCount := 0
		skippedCount := 1
		if capacity > 0 {
			scheduleCount = 1
			skippedCount = 0
		}
		return singlePreviewResponse{
			Mode:          "single",
			SourceID:      source.ID,
			URL:           source.URL,
			Name:          source.Name,
			Candidates:    []singlePreviewCandidate{{URL: source.URL, Status: "success", AlreadyCrawled: false, AlreadyQueued: inFlightStatus != nil, InFlightStatus: inFlightStatus}},
			InFlightCount: inFlightCount,
			InFlightLimit: inFlightLimit,
			ScheduleCount: scheduleCount,
			SkippedCount:  skippedCount,
			Seed:          seedConfig,
			Workflow:      workflowSummary,
		}, nil
	}

	var deepFailureStats *NewsSourcePreviewDeepFailureStats
	if seedConfig.Mode == "deep" {
		deepFailureStats, err = s.readDeepDiscoveryFailureStats(ctx, source.ID)
		if err != nil {
			return nil, err
		}
	}
	var deepPreviewError *NewsSourcePreviewDeepError
	discovery := []crawlmetadata.DiscoveryCandidate{}

	switch seedConfig.Mode {
	case "rss":
		feedURL := source.URL
		if seedConfig.FeedURL != nil && *seedConfig.FeedURL != "" {
			feedURL = *seedConfig.FeedURL
		}
		discovery, err = s.discovery.DiscoverRSSCandidates(ctx, crawlmetadata.RSSDiscoveryInput{
			FeedURL:  feedURL,
			MaxURLs:  intPointer(seedConfig.MaxURLs),
			RSSFetch: rssFetchOptions(seedConfig.RSSFetch),
		})
	case "list":
		discovery, err = s.discovery.DiscoverListCandidates(ctx, crawlmetadata.ListDiscoveryInput{
			URL:                 source.URL,
			Domain:              stringValue(seedConfig.Domain),
			Pattern:             stringValue(seedConfig.Pattern),
			MaxURLs:             intPointer(seedConfig.MaxURLs),
			ListMaxPages:        intPointer(seedConfig.ListMaxPages),
			ListPageConcurrency: intPointer(seedConfig.ListPageConcurrency),
			FollowPagination:    boolPointer(seedConfig.FollowPagination),
			CrawlOptions:        rawOfObject(crawlOptions),
		})
	case "deep":
		discovery, err = s.discovery.DiscoverDeepCandidates(ctx, crawlmetadata.DeepDiscoveryInput{
			URL:          source.URL,
			Domain:       stringValue(seedConfig.Domain),
			Pattern:      stringValue(seedConfig.Pattern),
			Query:        stringValue(seedConfig.Query),
			MaxURLs:      intPointer(seedConfig.MaxURLs),
			Deep:         rawOfObject(deepOptions(seedConfig.Deep)),
			CrawlOptions: rawOfObject(crawlOptions),
		})
		if err != nil {
			parsed, ok := crawlmetadata.ParseDeepDiscoveryError(err)
			if !ok {
				return nil, err
			}
			deepPreviewError = &NewsSourcePreviewDeepError{Code: parsed.Code, Message: parsed.Message}
			if parsed.Detail != "" {
				detail := parsed.Detail
				deepPreviewError.Detail = &detail
			}
			discovery = []crawlmetadata.DiscoveryCandidate{}
			err = nil
		}
	default:
		discovery, err = s.discovery.DiscoverSitemapCandidates(ctx, stringValue(seedConfig.Domain), stringValue(seedConfig.Pattern), intPointer(seedConfig.MaxURLs))
	}
	if err != nil {
		return nil, err
	}

	discoveryURLs := make([]string, 0, len(discovery))
	for _, entry := range discovery {
		discoveryURLs = append(discoveryURLs, entry.URL)
	}
	metadataResults := []crawlmetadata.Result{}
	if len(discoveryURLs) > 0 {
		falseValue := false
		metadataResults, err = s.discovery.Service().Extract(ctx, crawlmetadata.ExtractionInput{
			Source:              string(crawlmetadata.SourceURLs),
			URLs:                discoveryURLs,
			Query:               stringValue(seedConfig.Query),
			ScoreThreshold:      floatPointer(seedConfig.ScoreThreshold),
			Concurrency:         intPointer(seedConfig.Concurrency),
			ExtractJSONLd:       &falseValue,
			ExtractOpenGraph:    &falseValue,
			ExtractStandardMeta: &falseValue,
		})
		if err != nil {
			return nil, err
		}
	}

	discoverySignals := mergeDiscoverySignals(discovery)

	candidateURLs := make([]string, 0, len(metadataResults))
	for _, result := range metadataResults {
		candidateURLs = append(candidateURLs, result.URL)
	}
	// The two lookups are independent; the error precedence stays the original
	// order (recent crawls first, then in-flight jobs).
	var (
		crawlLookup    map[string]time.Time
		activeLookup   map[string]*string
		recentCrawlErr error
		activeJobErr   error
	)
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		crawlLookup, recentCrawlErr = s.findRecentCrawls(ctx, orgID, candidateURLs, seedConfig.DedupeWindowHours)
	}()
	go func() {
		defer waitGroup.Done()
		activeLookup, activeJobErr = s.findActivePipelineJobs(ctx, source.ID, candidateURLs, activeCutoff)
	}()
	waitGroup.Wait()
	if recentCrawlErr != nil {
		return nil, recentCrawlErr
	}
	if activeJobErr != nil {
		return nil, activeJobErr
	}

	candidates := make([]seedPreviewCandidate, 0, len(metadataResults))
	for _, result := range metadataResults {
		lastCrawlAt := timePointerISO(crawlLookup[result.URL])
		inFlightStatus := activeLookup[result.URL]
		signal := discoverySignals[result.URL]
		publishedAt := millisToISO(signal.publishedAtTs)
		crawledAt := millisToISO(signal.crawledAtTs)
		effectiveAt := publishedAt
		if effectiveAt == nil {
			effectiveAt = crawledAt
		}
		candidate := seedPreviewCandidate{
			URL:                result.URL,
			Status:             result.Status,
			Title:              result.Title,
			Description:        result.Description,
			Author:             result.Author,
			RelevanceScore:     result.RelevanceScore,
			PublishedAt:        publishedAt,
			CrawledAt:          crawledAt,
			EffectiveAt:        effectiveAt,
			TimestampSource:    previewTimestampSource(publishedAt, crawledAt),
			PublishDateMissing: publishedAt == nil,
			AlreadyCrawled:     lastCrawlAt != nil,
			LastCrawlAt:        lastCrawlAt,
			AlreadyQueued:      inFlightStatus != nil,
			InFlightStatus:     inFlightStatus,
		}
		if result.Status == "failed" {
			candidate.Error = result.Error
		}
		candidates = append(candidates, candidate)
	}

	availableToSchedule := 0
	for _, candidate := range candidates {
		if candidate.Status == "success" && !candidate.AlreadyCrawled && !candidate.AlreadyQueued {
			availableToSchedule++
		}
	}
	scheduleCount := availableToSchedule
	if scheduleCount > capacity {
		scheduleCount = capacity
	}

	return seedPreviewResponse{
		Mode:                seedConfig.Mode,
		SourceID:            source.ID,
		URL:                 source.URL,
		Name:                source.Name,
		Seed:                seedConfig,
		Candidates:          candidates,
		AvailableToSchedule: availableToSchedule,
		InFlightCount:       inFlightCount,
		InFlightLimit:       inFlightLimit,
		ScheduleCount:       scheduleCount,
		SkippedCount:        len(candidates) - scheduleCount,
		DeepPreviewError:    deepPreviewError,
		DeepFailureStats:    deepFailureStats,
		Workflow:            workflowSummary,
	}, nil
}

// ---------------------------------------------------------------------------
// store reads

func (s *PreviewService) loadSource(ctx context.Context, id string) (previewSourceRow, error) {
	if s == nil || s.db == nil {
		return previewSourceRow{}, errors.New("news source preview: no database")
	}
	var row previewSourceRow
	err := s.db.QueryRowContext(ctx, `
SELECT id, orgId, name, url, config, crawlTemplateId, workflowId, workflowVersionId, workflowBindingMode
FROM NewsSource WHERE id = ?`, id).Scan(
		&row.ID, &row.OrgID, &row.Name, &row.URL, &row.Config,
		&row.CrawlTemplateID, &row.WorkflowID, &row.WorkflowVersionID, &row.WorkflowBindingMode,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return previewSourceRow{}, newStatus(404, "News source not found")
	}
	if err != nil {
		return previewSourceRow{}, err
	}
	return row, nil
}

func (s *PreviewService) loadTemplateCrawlOptions(ctx context.Context, templateID string) (map[string]json.RawMessage, bool, error) {
	if strings.TrimSpace(templateID) == "" {
		return nil, false, nil
	}
	var (
		isActive     bool
		crawlOptions []byte
	)
	err := s.db.QueryRowContext(ctx, "SELECT isActive, crawlOptions FROM CrawlTemplate WHERE id = ?", templateID).
		Scan(&isActive, &crawlOptions)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !isActive {
		return nil, false, nil
	}
	record, ok := objectOfRaw(crawlOptions)
	if !ok {
		return nil, false, nil
	}
	return record, true, nil
}

func (s *PreviewService) findRecentCrawls(ctx context.Context, orgID string, urls []string, dedupeWindowHours int) (map[string]time.Time, error) {
	hours := dedupeWindowHours
	if hours < 0 {
		hours = 0
	}
	if hours > 24*30 {
		hours = 24 * 30
	}
	if hours == 0 || len(urls) == 0 {
		return map[string]time.Time{}, nil
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)
	query := "SELECT url, crawlAt FROM Article WHERE orgId = ? AND url IN (" + placeholders(len(urls)) + ") AND crawlAt >= ?"
	args := make([]any, 0, len(urls)+2)
	args = append(args, orgID)
	for _, value := range urls {
		args = append(args, value)
	}
	args = append(args, since)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byURL := map[string]time.Time{}
	for rows.Next() {
		var (
			rawURL  string
			crawlAt time.Time
		)
		if err := rows.Scan(&rawURL, &crawlAt); err != nil {
			return nil, err
		}
		existing, ok := byURL[rawURL]
		if !ok || crawlAt.After(existing) {
			byURL[rawURL] = crawlAt
		}
	}
	return byURL, rows.Err()
}

var activePipelineJobStatuses = []string{"pending", "queued", "running", "delayed"}

func (s *PreviewService) findActivePipelineJobs(ctx context.Context, sourceID string, urls []string, cutoff time.Time) (map[string]*string, error) {
	if len(urls) == 0 {
		return map[string]*string{}, nil
	}
	query := "SELECT url, status, createdAt FROM PipelineJob WHERE sourceId = ? AND url IN (" + placeholders(len(urls)) +
		") AND status IN (" + placeholders(len(activePipelineJobStatuses)) + ") AND createdAt >= ?"
	args := make([]any, 0, len(urls)+len(activePipelineJobStatuses)+2)
	args = append(args, sourceID)
	for _, value := range urls {
		args = append(args, value)
	}
	for _, value := range activePipelineJobStatuses {
		args = append(args, value)
	}
	args = append(args, cutoff)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type jobEntry struct {
		status    string
		createdAt time.Time
	}
	byURL := map[string]jobEntry{}
	for rows.Next() {
		var (
			rawURL    string
			status    string
			createdAt time.Time
		)
		if err := rows.Scan(&rawURL, &status, &createdAt); err != nil {
			return nil, err
		}
		existing, ok := byURL[rawURL]
		if !ok || createdAt.After(existing.createdAt) {
			byURL[rawURL] = jobEntry{status: status, createdAt: createdAt}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := map[string]*string{}
	for rawURL, entry := range byURL {
		status := entry.status
		out[rawURL] = &status
	}
	return out, nil
}

// countActivePipelineJobs ports countActivePipelineJobs with O5: a bounded
// COUNT instead of findMany + take + length.
func (s *PreviewService) countActivePipelineJobs(ctx context.Context, sourceID string, cutoff time.Time, limit int) (int, error) {
	capped := limit
	if capped < 1 {
		capped = 1
	}
	if capped > 50 {
		capped = 50
	}
	query := "SELECT COUNT(*) FROM (SELECT 1 FROM PipelineJob WHERE sourceId = ? AND status IN (" +
		placeholders(len(activePipelineJobStatuses)) + ") AND createdAt >= ? LIMIT ?) t"
	args := []any{sourceID}
	for _, value := range activePipelineJobStatuses {
		args = append(args, value)
	}
	args = append(args, cutoff, capped)
	var count int
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// ---------------------------------------------------------------------------
// deep discovery failure statistics

func (s *PreviewService) readDeepDiscoveryFailureStats(ctx context.Context, sourceID string) (*NewsSourcePreviewDeepFailureStats, error) {
	if s.redis == nil {
		return nil, nil
	}
	stateRaw, stateErr := s.redis.Get(ctx, crawlmetadata.DeepDiscoveryFailureStateCacheKey(sourceID)).Result()
	if stateErr != nil && !errors.Is(stateErr, redis.Nil) {
		return nil, stateErr
	}
	statsRaw, statsErr := s.redis.Get(ctx, crawlmetadata.DeepDiscoveryFailureStatsCacheKey(sourceID)).Result()
	if statsErr != nil && !errors.Is(statsErr, redis.Nil) {
		return nil, statsErr
	}
	state := normalizeDeepDiscoveryFailureState(decodeCacheValue(stateRaw))
	stats := normalizeDeepDiscoveryFailureStats24h(decodeCacheValue(statsRaw))

	hasState := state != nil && (state.Streak > 0 || state.LastCode != "" || state.LastFailureAt != "")
	hasStats := stats.Total > 0 || len(stats.ByCode) > 0
	if !hasState && !hasStats {
		return nil, nil
	}
	out := &NewsSourcePreviewDeepFailureStats{
		Total24h: stats.Total,
		ByCode:   stats.ByCode,
	}
	if state != nil {
		out.Streak = state.Streak
		lastFailureAt := state.LastFailureAt
		lastCode := state.LastCode
		lastMessage := state.LastMessage
		nextRetryAt := state.RetryAt
		out.LastFailureAt = &lastFailureAt
		out.LastCode = &lastCode
		out.LastMessage = &lastMessage
		out.NextRetryAt = &nextRetryAt
		out.LastDetail = state.LastDetail
		out.CircuitOpenUntil = state.CircuitOpenUntil
	}
	return out, nil
}

type normalizedFailureState struct {
	Streak           int
	LastFailureAt    string
	LastCode         string
	LastMessage      string
	LastDetail       *string
	RetryAt          string
	NextRunAt        string
	CircuitOpenUntil *string
}

type normalizedFailureStats struct {
	Total     int
	ByCode    []NewsSourcePreviewCodeCount
	UpdatedAt string
}

func normalizeDeepDiscoveryFailureState(value map[string]json.RawMessage) *normalizedFailureState {
	if value == nil {
		return nil
	}
	streak := 0
	if number, ok := numberValue(value["streak"]); ok {
		streak = int(math.Max(0, math.Floor(number)))
	}
	lastFailureAt := stringValueRaw(value["lastFailureAt"])
	lastCode := stringValueRaw(value["lastCode"])
	lastMessage := stringValueRaw(value["lastMessage"])
	retryAt := stringValueRaw(value["retryAt"])
	nextRunAt := stringValueRaw(value["nextRunAt"])
	if nextRunAt == "" {
		nextRunAt = retryAt
	}
	circuitOpenUntil := optionalStringValueRaw(value["circuitOpenUntil"])
	lastDetail := optionalStringValueRaw(value["lastDetail"])

	if streak <= 0 && lastCode == "" && lastFailureAt == "" {
		return nil
	}
	epoch := time.UnixMilli(0).UTC().Format("2006-01-02T15:04:05.000Z")
	if lastFailureAt == "" {
		lastFailureAt = epoch
	}
	if lastCode == "" {
		lastCode = "SEED_DEEP_UNKNOWN"
	}
	if lastMessage == "" {
		lastMessage = "Deep discovery failed"
	}
	if retryAt == "" {
		retryAt = nextRunAt
	}
	if retryAt == "" {
		retryAt = epoch
	}
	if nextRunAt == "" {
		nextRunAt = retryAt
	}
	return &normalizedFailureState{
		Streak:           streak,
		LastFailureAt:    lastFailureAt,
		LastCode:         lastCode,
		LastMessage:      lastMessage,
		LastDetail:       lastDetail,
		RetryAt:          retryAt,
		NextRunAt:        nextRunAt,
		CircuitOpenUntil: circuitOpenUntil,
	}
}

func normalizeDeepDiscoveryFailureStats24h(value map[string]json.RawMessage) normalizedFailureStats {
	stats := normalizedFailureStats{Total: 0, ByCode: []NewsSourcePreviewCodeCount{}, UpdatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	if value == nil {
		return stats
	}
	byCode := map[string]int{}
	order := []string{}
	if record, ok := objectOfRaw(value["byCode"]); ok {
		for _, key := range orderedKeys(value["byCode"]) {
			if !strings.HasPrefix(key, "SEED_DEEP_") {
				continue
			}
			number, ok := numberValue(record[key])
			if !ok {
				continue
			}
			count := int(math.Max(0, math.Floor(number)))
			if count <= 0 {
				continue
			}
			byCode[key] = count
			order = append(order, key)
		}
	}
	entries := make([]NewsSourcePreviewCodeCount, 0, len(order))
	for _, key := range order {
		entries = append(entries, NewsSourcePreviewCodeCount{Code: key, Count: byCode[key]})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Count > entries[j].Count })
	total := 0
	if number, ok := numberValue(value["total"]); ok {
		total = int(math.Max(0, math.Floor(number)))
	} else {
		for _, entry := range entries {
			total += entry.Count
		}
	}
	updatedAt := stringValueRaw(value["updatedAt"])
	if updatedAt == "" {
		updatedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return normalizedFailureStats{Total: total, ByCode: entries, UpdatedAt: updatedAt}
}

func decodeCacheValue(raw string) map[string]json.RawMessage {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	record, ok := objectOfRaw([]byte(raw))
	if !ok {
		return nil
	}
	return record
}

// ---------------------------------------------------------------------------
// config normalization

func mergeWorkflowSourceConfig(config map[string]json.RawMessage, overlay *crawlworkflow.CompiledNewsSourceOverlay) map[string]json.RawMessage {
	if overlay == nil {
		return config
	}
	merged := map[string]json.RawMessage{}
	for key, value := range config {
		merged[key] = value
	}
	if len(overlay.Keywords) > 0 {
		merged["keywords"] = rawOfAny(overlay.Keywords)
	}
	baseCrawlOptions, _ := objectOfRaw(config["crawlOptions"])
	overlayCrawlOptions, _ := objectOfRaw(overlay.CrawlOptions)
	mergedCrawlOptions := map[string]json.RawMessage{}
	for key, value := range baseCrawlOptions {
		mergedCrawlOptions[key] = value
	}
	for key, value := range overlayCrawlOptions {
		mergedCrawlOptions[key] = value
	}
	merged["crawlOptions"] = rawOfObject(mergedCrawlOptions)

	baseSeed, _ := objectOfRaw(config["seed"])
	overlaySeed, _ := objectOfRaw(overlay.Seed)
	mergedSeed := map[string]json.RawMessage{}
	for key, value := range baseSeed {
		mergedSeed[key] = value
	}
	for key, value := range overlaySeed {
		mergedSeed[key] = value
	}
	merged["seed"] = rawOfObject(mergedSeed)
	return merged
}

func mergeCrawlOptions(template, source map[string]json.RawMessage) map[string]json.RawMessage {
	if template == nil && source == nil {
		return nil
	}
	merged := map[string]json.RawMessage{}
	for key, value := range template {
		merged[key] = value
	}
	for key, value := range source {
		merged[key] = value
	}
	return merged
}

// normalizeSeedConfig ports normalizeSeedConfig.
func normalizeSeedConfig(config map[string]json.RawMessage, sourceURL string) *NewsSourceSeedConfig {
	if config == nil {
		return nil
	}
	rawSeed, _ := objectOfRaw(config["seed"])
	if rawSeed == nil || stringValueRaw(rawSeed["enabled"]) != "true" {
		return nil
	}
	modeRaw := strings.ToLower(strings.TrimSpace(stringValueRaw(rawSeed["mode"])))
	mode := "sitemap"
	switch modeRaw {
	case "rss", "list", "deep":
		mode = modeRaw
	}

	var domain *string
	if mode == "sitemap" || mode == "list" || mode == "deep" {
		domain = normalizeSeedDomain(rawSeed["domain"], sourceURL)
	}
	pattern := strings.TrimSpace(stringValueRaw(rawSeed["pattern"]))
	var feedURL *string
	var rssFetch *NewsSourceRSSFetchConfig
	if mode == "rss" {
		feedURL = normalizeSeedFeedURL(rawSeed["feedUrl"], sourceURL)
		rssFetch = normalizeSeedRSSFetchConfig(rawSeed["rssFetch"])
	}
	deepConfig, _ := objectOfRaw(rawSeed["deep"])
	query := strings.TrimSpace(stringValueRaw(rawSeed["query"]))
	keywords := normalizeStringList(config["keywords"])
	effectiveQuery := query
	if effectiveQuery == "" && len(keywords) > 0 {
		effectiveQuery = strings.Join(keywords, " ")
	}

	seed := &NewsSourceSeedConfig{
		Enabled:             true,
		Mode:                mode,
		Domain:              domain,
		MaxURLs:             clampIntValue(rawSeed["maxUrls"], 1, 2_000, 200),
		MaxNewURLsPerRun:    clampIntValue(rawSeed["maxNewUrlsPerRun"], 1, 500, 80),
		ListMaxPages:        clampIntValue(rawSeed["listMaxPages"], 1, 20, 6),
		ListPageConcurrency: clampIntValue(rawSeed["listPageConcurrency"], 1, 5, 2),
		FollowPagination:    stringValueRaw(rawSeed["followPagination"]) != "false",
		ScoreThreshold:      clampFloatValue(rawSeed["scoreThreshold"], 0, 1, 0),
		Concurrency:         clampIntValue(rawSeed["concurrency"], 1, 10, 5),
		DedupeWindowHours:   clampIntValue(rawSeed["dedupeWindowHours"], 0, 24*30, 24),
		QueryParamAllowlist: newssources.NormalizeURLQueryParamAllowlist(jsonValueOf(rawSeed["queryParamAllowlist"]), newssources.DefaultURLQueryParamAllowlist),
		FeedURL:             feedURL,
		RSSFetch:            rssFetch,
	}
	if (mode == "sitemap" || mode == "list" || mode == "deep") && pattern != "" {
		seed.Pattern = &pattern
	}
	if effectiveQuery != "" {
		seed.Query = &effectiveQuery
	}
	if mode == "deep" {
		seed.Deep = &NewsSourceDeepSeedConfig{
			MaxPages:            clampIntValue(deepConfig["maxPages"], 5, 300, 80),
			MaxDepth:            clampIntValue(deepConfig["maxDepth"], 1, 4, 2),
			TimeBudgetSeconds:   clampIntValue(deepConfig["timeBudgetSeconds"], 10, 180, 60),
			PageConcurrency:     clampIntValue(deepConfig["pageConcurrency"], 1, 6, 2),
			ScoreThreshold:      clampFloatValue(deepConfig["scoreThreshold"], 0, 1, 0.2),
			CandidatePoolSize:   clampIntValue(deepConfig["candidatePoolSize"], 20, 400, 120),
			HeadFetchTopK:       clampIntValue(deepConfig["headFetchTopK"], 10, 120, 40),
			PreferPathDate:      boolValueOrDefault(deepConfig["preferPathDate"], true),
			EnableSecondaryHubs: boolValueOrDefault(deepConfig["enableSecondaryHubs"], true),
			IgnoreRobotsTxt:     true,
		}
	}
	return seed
}

func normalizeSeedDomain(raw json.RawMessage, sourceURL string) *string {
	value := strings.TrimSpace(stringValueRaw(raw))
	candidate := value
	if candidate == "" {
		candidate = sourceURL
	}
	withProtocol := candidate
	if !strings.HasPrefix(strings.ToLower(candidate), "http://") && !strings.HasPrefix(strings.ToLower(candidate), "https://") {
		withProtocol = "https://" + candidate
	}
	if parsed, err := url.Parse(withProtocol); err == nil && parsed.Scheme != "" {
		origin := parsed.Scheme + "://" + parsed.Host
		return &origin
	}
	if parsed, err := url.Parse(sourceURL); err == nil && parsed.Scheme != "" {
		origin := parsed.Scheme + "://" + parsed.Host
		return &origin
	}
	return nil
}

func normalizeSeedFeedURL(raw json.RawMessage, sourceURL string) *string {
	value := strings.TrimSpace(stringValueRaw(raw))
	candidate := value
	if candidate == "" {
		candidate = sourceURL
	}
	withProtocol := candidate
	if !strings.HasPrefix(strings.ToLower(candidate), "http://") && !strings.HasPrefix(strings.ToLower(candidate), "https://") {
		withProtocol = "https://" + candidate
	}
	if parsed, err := url.Parse(withProtocol); err == nil && parsed.Scheme != "" {
		result := parsed.String()
		return &result
	}
	if parsed, err := url.Parse(sourceURL); err == nil && parsed.Scheme != "" {
		result := parsed.String()
		return &result
	}
	return nil
}

func normalizeSeedRSSFetchConfig(raw json.RawMessage) *NewsSourceRSSFetchConfig {
	record, _ := objectOfRaw(raw)
	hasCustomFields := record != nil && (record["requestTimeoutMs"] != nil || record["bodySourceStrategy"] != nil || record["noBodyPolicy"] != nil)
	enabled := record != nil && (stringValueRaw(record["enabled"]) == "true" || (stringValueRaw(record["enabled"]) != "false" && hasCustomFields))
	if !enabled {
		return &NewsSourceRSSFetchConfig{Enabled: false, RequestTimeoutMs: 15_000, BodySourceStrategy: "content_first", NoBodyPolicy: "skip"}
	}
	bodySourceStrategy := strings.ToLower(strings.TrimSpace(stringValueRaw(record["bodySourceStrategy"])))
	if bodySourceStrategy != "content_only" && bodySourceStrategy != "summary_only" {
		bodySourceStrategy = "content_first"
	}
	noBodyPolicy := "skip"
	if strings.ToLower(strings.TrimSpace(stringValueRaw(record["noBodyPolicy"]))) == "title_description_stub" {
		noBodyPolicy = "title_description_stub"
	}
	return &NewsSourceRSSFetchConfig{
		Enabled:            true,
		RequestTimeoutMs:   clampIntValue(record["requestTimeoutMs"], 1_000, 120_000, 15_000),
		BodySourceStrategy: bodySourceStrategy,
		NoBodyPolicy:       noBodyPolicy,
	}
}

func rssFetchOptions(config *NewsSourceRSSFetchConfig) *crawlmetadata.RSSFetchOptions {
	if config == nil {
		return nil
	}
	timeout := config.RequestTimeoutMs
	return &crawlmetadata.RSSFetchOptions{
		RequestTimeoutMs:   &timeout,
		BodySourceStrategy: config.BodySourceStrategy,
		NoBodyPolicy:       config.NoBodyPolicy,
	}
}

func deepOptions(config *NewsSourceDeepSeedConfig) json.RawMessage {
	if config == nil {
		return nil
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return nil
	}
	return encoded
}

// ---------------------------------------------------------------------------
// helpers

func decodeConfigObject(raw []byte) map[string]json.RawMessage {
	record, ok := objectOfRaw(raw)
	if !ok {
		return nil
	}
	return record
}

func objectOfRaw(raw []byte) (map[string]json.RawMessage, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return nil, false
	}
	record := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return nil, false
	}
	return record, true
}

// orderedKeys preserves the JSON object key order for byCode iteration.
func orderedKeys(raw json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	if _, err := decoder.Token(); err != nil {
		return nil
	}
	keys := []string{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil
		}
		key, ok := token.(string)
		if !ok {
			return nil
		}
		keys = append(keys, key)
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			return nil
		}
	}
	return keys
}

func rawOfObject(record map[string]json.RawMessage) json.RawMessage {
	if record == nil {
		return nil
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return nil
	}
	return encoded
}

func rawOfAny(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

func jsonValueOf(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func stringValueRaw(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}

func optionalStringValueRaw(raw json.RawMessage) *string {
	value := stringValueRaw(raw)
	if value == "" {
		return nil
	}
	return &value
}

func numberValue(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	switch trimmed[0] {
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
	default:
		return 0, false
	}
	var value float64
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

func clampIntValue(raw json.RawMessage, min, max, fallback int) int {
	value, ok := numberValue(raw)
	if !ok {
		return fallback
	}
	rounded := int(math.Round(value))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

func clampFloatValue(raw json.RawMessage, min, max, fallback float64) float64 {
	value, ok := numberValue(raw)
	if !ok {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func boolValueOrDefault(raw json.RawMessage, fallback bool) bool {
	switch strings.TrimSpace(string(raw)) {
	case "true":
		return true
	case "false":
		return false
	}
	return fallback
}

func normalizeStringList(raw json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return []string{}
	}
	var values []json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &values); err != nil {
		return []string{}
	}
	out := []string{}
	for _, value := range values {
		text := strings.TrimSpace(stringValueRaw(value))
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func nullStringValue(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func intPointer(value int) *int { return &value }

func boolPointer(value bool) *bool { return &value }

func floatPointer(value float64) *float64 { return &value }

func millisToISO(millis *int64) *string {
	if millis == nil {
		return nil
	}
	value := time.UnixMilli(*millis).UTC().Format("2006-01-02T15:04:05.000Z")
	return &value
}

func timePointerISO(value time.Time) *string {
	if value.IsZero() {
		return nil
	}
	iso := value.UTC().Format("2006-01-02T15:04:05.000Z")
	return &iso
}

func previewTimestampSource(publishedAt, crawledAt *string) string {
	if publishedAt != nil {
		return "published"
	}
	if crawledAt != nil {
		return "crawled"
	}
	return "none"
}

type discoverySignal struct {
	relevanceScore *float64
	publishedAtTs  *int64
	crawledAtTs    *int64
}

func mergeDiscoverySignals(discovery []crawlmetadata.DiscoveryCandidate) map[string]discoverySignal {
	out := map[string]discoverySignal{}
	for _, candidate := range discovery {
		rawURL := strings.TrimSpace(candidate.URL)
		if rawURL == "" {
			continue
		}
		existing, found := out[rawURL]
		if !found {
			out[rawURL] = discoverySignal{
				relevanceScore: candidate.RelevanceScore,
				publishedAtTs:  candidate.PublishedAtTs,
				crawledAtTs:    candidate.CrawledAtTs,
			}
			continue
		}
		out[rawURL] = discoverySignal{
			relevanceScore: maxRelevanceScore(existing.relevanceScore, candidate.RelevanceScore),
			publishedAtTs:  maxTimestamp(existing.publishedAtTs, candidate.PublishedAtTs),
			crawledAtTs:    maxTimestamp(existing.crawledAtTs, candidate.CrawledAtTs),
		}
	}
	return out
}

func maxRelevanceScore(left, right *float64) *float64 {
	if left == nil && right == nil {
		return nil
	}
	leftValue := math.Inf(-1)
	if left != nil {
		leftValue = *left
	}
	rightValue := math.Inf(-1)
	if right != nil {
		rightValue = *right
	}
	value := math.Max(leftValue, rightValue)
	return &value
}

func maxTimestamp(left, right *int64) *int64 {
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

// placeholders renders `?,?,?` for an IN clause. callers guarantee count > 0.
func placeholders(count int) string {
	if count <= 0 {
		return "NULL"
	}
	parts := make([]string, 0, count)
	for index := 0; index < count; index++ {
		parts = append(parts, "?")
	}
	return strings.Join(parts, ",")
}
