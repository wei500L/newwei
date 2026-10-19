package crawlmetadata

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// This file ports NewsSourceService.preview and the helpers it owns
// (apps/api/src/modules/crawl/news-source.service.ts:631-882, :1166-1388,
// :1582-1660 and :968-1100).
//
// The entry is read-only: it reads NewsSource, CrawlTemplate, CrawlStrategyWorkflow
// (through the workflow overlay), PipelineJob and Article rows plus the deep
// discovery failure stats in Redis, and performs the discovery + metadata extract
// requests. It never writes a row and never enqueues a job.
//
// Request rhythm: one discovery pass (RSS fetch, list pages or deep crawl with
// the ported caps) followed by at most `maxUrls` metadata fetches at
// `concurrency` parallelism. The deep mode replaces a discovery failure with the
// SEED_DEEP_* error object and returns an empty candidate list instead of failing
// the request, exactly like the source's try/catch.

// PipelineJobStatus is the Prisma PipelineJobStatus enum subset the preview reads.
type PipelineJobStatus string

// Active pipeline job statuses (ACTIVE_PIPELINE_JOB_STATUSES).
const (
	PipelineJobPending PipelineJobStatus = "pending"
	PipelineJobQueued  PipelineJobStatus = "queued"
	PipelineJobRunning PipelineJobStatus = "running"
	PipelineJobDelayed PipelineJobStatus = "delayed"
)

// Seed modes (NewsSourceSeedConfig["mode"]).
const (
	SeedModeSitemap = "sitemap"
	SeedModeRSS     = "rss"
	SeedModeList    = "list"
	SeedModeDeep    = "deep"
)

// legacyRSSSeedCacheTTLSeconds is LEGACY_RSS_SEED_CACHE_TTL_SECONDS.
const legacyRSSSeedCacheTTLSeconds = 600

// PreviewService is the news-source preview entry.
type PreviewService struct {
	metadata  *Service
	discovery *Discovery
	workflow  *crawlworkflow.Service
	// inFlightLookbackMs is newsSourceSchedulerConfig.inFlightLookbackMs.
	inFlightLookbackMs int64
}

// PreviewOptions configures the preview service. Discovery carries the shared
// crawl4ai-backed discovery chain; a nil value makes deep discovery report
// SEED_DEEP_CRAWL4AI_UNAVAILABLE and list discovery fall back to raw HTML.
type PreviewOptions struct {
	Metadata           *Service
	Discovery          *Discovery
	Workflows          *crawlworkflow.Service
	InFlightLookbackMs int64
}

// NewPreviewService builds the preview entry. A nil workflow service means no
// workflow overlay is compiled (the source's optional binding).
func NewPreviewService(options PreviewOptions) *PreviewService {
	lookback := options.InFlightLookbackMs
	if lookback <= 0 {
		lookback = 1_800_000
	}
	discovery := options.Discovery
	if discovery == nil {
		// Without a crawl4ai client the chain still serves RSS/sitemap/list (one
		// HTML fallback) and reports deep discovery as unavailable.
		discovery = NewDiscovery(options.Metadata, nil, nil)
	}
	return &PreviewService{
		metadata:           options.Metadata,
		discovery:          discovery,
		workflow:           options.Workflows,
		inFlightLookbackMs: lookback,
	}
}

// PreviewDocument is one of the two preview response shapes.
type PreviewDocument interface {
	isPreviewDocument()
}

// PreviewCandidateSingle is the single-page mode candidate.
type PreviewCandidateSingle struct {
	URL            string             `json:"url"`
	Status         string             `json:"status"`
	AlreadyCrawled bool               `json:"alreadyCrawled"`
	AlreadyQueued  bool               `json:"alreadyQueued"`
	InFlightStatus *PipelineJobStatus `json:"inFlightStatus"`
}

// PreviewSingleResponse is the single-page mode response.
type PreviewSingleResponse struct {
	Mode          string                         `json:"mode"`
	SourceID      string                         `json:"sourceId"`
	URL           string                         `json:"url"`
	Name          string                         `json:"name"`
	Candidates    []PreviewCandidateSingle       `json:"candidates"`
	InFlightCount int                            `json:"inFlightCount"`
	InFlightLimit int                            `json:"inFlightLimit"`
	ScheduleCount int                            `json:"scheduleCount"`
	SkippedCount  int                            `json:"skippedCount"`
	Seed          *SeedConfig                    `json:"seed"`
	Workflow      *crawlworkflow.WorkflowSummary `json:"workflow"`
}

func (PreviewSingleResponse) isPreviewDocument() {}

// PreviewCandidate is the seed mode candidate.
type PreviewCandidate struct {
	URL                string             `json:"url"`
	Status             string             `json:"status"`
	Title              *string            `json:"title,omitempty"`
	Description        *string            `json:"description,omitempty"`
	Author             *string            `json:"author,omitempty"`
	RelevanceScore     *float64           `json:"relevanceScore,omitempty"`
	PublishedAt        *string            `json:"publishedAt"`
	CrawledAt          *string            `json:"crawledAt"`
	EffectiveAt        *string            `json:"effectiveAt"`
	TimestampSource    TimestampSource    `json:"timestampSource"`
	PublishDateMissing bool               `json:"publishDateMissing"`
	AlreadyCrawled     bool               `json:"alreadyCrawled"`
	LastCrawlAt        *string            `json:"lastCrawlAt"`
	AlreadyQueued      bool               `json:"alreadyQueued"`
	InFlightStatus     *PipelineJobStatus `json:"inFlightStatus"`
	Error              *string            `json:"error,omitempty"`
}

// DeepPreviewError is NewsSourcePreviewDeepError.
type DeepPreviewError struct {
	Code    string  `json:"code"`
	Message string  `json:"message"`
	Detail  *string `json:"detail,omitempty"`
}

// PreviewSeedResponse is the seed mode response.
type PreviewSeedResponse struct {
	Mode                string                         `json:"mode"`
	SourceID            string                         `json:"sourceId"`
	URL                 string                         `json:"url"`
	Name                string                         `json:"name"`
	Seed                *SeedConfig                    `json:"seed"`
	Candidates          []PreviewCandidate             `json:"candidates"`
	AvailableToSchedule int                            `json:"availableToSchedule"`
	InFlightCount       int                            `json:"inFlightCount"`
	InFlightLimit       int                            `json:"inFlightLimit"`
	ScheduleCount       int                            `json:"scheduleCount"`
	SkippedCount        int                            `json:"skippedCount"`
	DeepPreviewError    *DeepPreviewError              `json:"deepPreviewError,omitempty"`
	DeepFailureStats    *DeepFailureStats              `json:"deepFailureStats,omitempty"`
	Workflow            *crawlworkflow.WorkflowSummary `json:"workflow"`
}

func (PreviewSeedResponse) isPreviewDocument() {}

// SeedConfig is NewsSourceSeedConfig.
type SeedConfig struct {
	Enabled             bool                `json:"enabled"`
	Mode                string              `json:"mode"`
	Domain              *string             `json:"domain,omitempty"`
	Pattern             *string             `json:"pattern,omitempty"`
	FeedURL             *string             `json:"feedUrl,omitempty"`
	RSSFetch            *SeedRSSFetchConfig `json:"rssFetch,omitempty"`
	MaxURLs             int                 `json:"maxUrls"`
	MaxNewURLsPerRun    int                 `json:"maxNewUrlsPerRun"`
	ListMaxPages        int                 `json:"listMaxPages"`
	ListPageConcurrency int                 `json:"listPageConcurrency"`
	FollowPagination    bool                `json:"followPagination"`
	Query               *string             `json:"query,omitempty"`
	ScoreThreshold      float64             `json:"scoreThreshold"`
	Concurrency         int                 `json:"concurrency"`
	DedupeWindowHours   int                 `json:"dedupeWindowHours"`
	QueryParamAllowlist []string            `json:"queryParamAllowlist"`
	Deep                *SeedDeepConfig     `json:"deep,omitempty"`
}

// SeedRSSFetchConfig is NewsSourceRssFetchConfig.
type SeedRSSFetchConfig struct {
	Enabled            bool   `json:"enabled"`
	RequestTimeoutMs   int    `json:"requestTimeoutMs"`
	BodySourceStrategy string `json:"bodySourceStrategy"`
	NoBodyPolicy       string `json:"noBodyPolicy"`
}

// SeedDeepConfig is NewsSourceDeepSeedConfig.
type SeedDeepConfig struct {
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

// previewSourceRow is the NewsSource read projection.
type previewSourceRow struct {
	ID                  string
	OrgID               string
	Name                string
	URL                 string
	Config              json.RawMessage
	CrawlTemplateID     *string
	WorkflowID          *string
	WorkflowVersionID   *string
	WorkflowBindingMode *string
}

// Preview ports NewsSourceService.preview.
func (p *PreviewService) Preview(ctx context.Context, orgID, sourceID string) (PreviewDocument, error) {
	if p.metadata == nil {
		return nil, errors.New("crawl metadata service is not configured")
	}
	source, err := p.loadSource(ctx, sourceID)
	if err != nil {
		return nil, err
	}
	if source.OrgID != orgID {
		return nil, errNewsSourceMissing
	}

	activeCutoff := nowMillis() - p.inFlightLookbackMs
	config := jsonObjectOrNil(source.Config)

	overlay, err := p.compileOverlay(ctx, orgID, source)
	if err != nil {
		return nil, err
	}
	effectiveConfig := mergeWorkflowSourceConfig(config, overlay)

	sourceCrawlOptions, ok := jsonObjectField(effectiveConfig, "crawlOptions")
	if !ok {
		sourceCrawlOptions = nil
	}
	templateCrawlOptions, err := p.loadTemplateCrawlOptions(ctx, source.CrawlTemplateID)
	if err != nil {
		return nil, err
	}
	var crawlOptions json.RawMessage
	if templateCrawlOptions != nil || sourceCrawlOptions != nil {
		crawlOptions = mergeCrawlOptions(templateCrawlOptions, sourceCrawlOptions)
	}
	if err := crawlworkflow.AssertNoUnsupportedProxy(crawlOptions, "crawlOptions"); err != nil {
		return nil, err
	}

	seedConfig := normalizeSeedConfig(effectiveConfig, source.URL)
	inFlightLimit := 1
	if seedConfig != nil && seedConfig.Enabled {
		inFlightLimit = seedConfig.MaxNewURLsPerRun
	}
	inFlightCount, err := p.countActivePipelineJobs(ctx, source.ID, activeCutoff, inFlightLimit)
	if err != nil {
		return nil, err
	}
	capacity := maxInt(0, inFlightLimit-inFlightCount)
	workflowSummary := workflowSummaryOf(overlay)

	if seedConfig == nil || !seedConfig.Enabled {
		inFlight, err := p.findActivePipelineJobs(ctx, source.ID, []string{source.URL}, activeCutoff)
		if err != nil {
			return nil, err
		}
		var inFlightStatus *PipelineJobStatus
		if status, ok := inFlight[source.URL]; ok {
			inFlightStatus = &status
		}
		scheduleCount := 0
		skippedCount := 1
		if capacity > 0 {
			scheduleCount = 1
			skippedCount = 0
		}
		return PreviewSingleResponse{
			Mode:     "single",
			SourceID: source.ID,
			URL:      source.URL,
			Name:     source.Name,
			Candidates: []PreviewCandidateSingle{{
				URL:            source.URL,
				Status:         string(StatusSuccess),
				AlreadyCrawled: false,
				AlreadyQueued:  inFlightStatus != nil,
				InFlightStatus: inFlightStatus,
			}},
			InFlightCount: inFlightCount,
			InFlightLimit: inFlightLimit,
			ScheduleCount: scheduleCount,
			SkippedCount:  skippedCount,
			Seed:          nil,
			Workflow:      workflowSummary,
		}, nil
	}

	var deepFailureStats *DeepFailureStats
	if seedConfig.Mode == SeedModeDeep {
		deepFailureStats = p.metadata.ReadDeepDiscoveryFailureStats(ctx, source.ID)
	}
	var deepPreviewError *DeepPreviewError
	discovery := []DiscoveryCandidate{}
	switch seedConfig.Mode {
	case SeedModeRSS:
		feedURL := source.URL
		if seedConfig.FeedURL != nil {
			feedURL = *seedConfig.FeedURL
		}
		discovery, err = p.discovery.DiscoverRSSCandidates(ctx, RSSDiscoveryInput{
			FeedURL:  feedURL,
			MaxURLs:  intPtrValue(seedConfig.MaxURLs),
			RSSFetch: rssFetchOptionsOf(seedConfig.RSSFetch),
		})
	case SeedModeList:
		discovery, err = p.discovery.DiscoverListCandidates(ctx, ListDiscoveryInput{
			URL:                 source.URL,
			Domain:              derefOrEmpty(seedConfig.Domain),
			Pattern:             derefOrEmpty(seedConfig.Pattern),
			MaxURLs:             intPtrValue(seedConfig.MaxURLs),
			ListMaxPages:        intPtrValue(seedConfig.ListMaxPages),
			ListPageConcurrency: intPtrValue(seedConfig.ListPageConcurrency),
			FollowPagination:    boolPtrValue(seedConfig.FollowPagination),
			CrawlOptions:        crawlOptions,
		})
	case SeedModeDeep:
		discovery, err = p.discovery.DiscoverDeepCandidates(ctx, DeepDiscoveryInput{
			URL:          source.URL,
			Domain:       derefOrEmpty(seedConfig.Domain),
			Pattern:      derefOrEmpty(seedConfig.Pattern),
			Query:        derefOrEmpty(seedConfig.Query),
			MaxURLs:      intPtrValue(seedConfig.MaxURLs),
			Deep:         deepOptionsOf(seedConfig.Deep),
			CrawlOptions: crawlOptions,
		})
		if err != nil {
			var discoveryErr *DiscoveryError
			if !errors.As(err, &discoveryErr) {
				return nil, err
			}
			deepPreviewError = &DeepPreviewError{
				Code:    discoveryErr.Code,
				Message: discoveryErr.Message,
				Detail:  stringOrNilPointer(discoveryErr.Detail),
			}
			discovery = []DiscoveryCandidate{}
			err = nil
		}
	default:
		discovery, err = p.discovery.DiscoverSitemapCandidates(ctx, derefOrEmpty(seedConfig.Domain), derefOrEmpty(seedConfig.Pattern), intPtrValue(seedConfig.MaxURLs))
	}
	if err != nil {
		return nil, err
	}

	discoveryURLs := make([]string, 0, len(discovery))
	for _, candidate := range discovery {
		discoveryURLs = append(discoveryURLs, candidate.URL)
	}
	results := []Result{}
	if len(discoveryURLs) > 0 {
		results, err = p.metadata.Extract(ctx, ExtractionInput{
			Source:              string(SourceURLs),
			URLs:                discoveryURLs,
			Query:               derefOrEmpty(seedConfig.Query),
			ScoreThreshold:      &seedConfig.ScoreThreshold,
			Concurrency:         intPtrValue(seedConfig.Concurrency),
			ExtractJSONLd:       boolPtrValue(false),
			ExtractOpenGraph:    boolPtrValue(false),
			ExtractStandardMeta: boolPtrValue(false),
		})
		if err != nil {
			return nil, err
		}
	}

	discoveryByURL := map[string]DiscoveryCandidate{}
	for _, candidate := range discovery {
		url := strings.TrimSpace(candidate.URL)
		if url == "" {
			continue
		}
		existing, ok := discoveryByURL[url]
		if !ok {
			discoveryByURL[url] = candidate
			continue
		}
		discoveryByURL[url] = mergeDiscoveryCandidates(existing, candidate)
	}

	candidateURLs := make([]string, 0, len(results))
	for _, result := range results {
		candidateURLs = append(candidateURLs, result.URL)
	}
	// The two lookups are independent reads, so they run concurrently like the
	// source's Promise.all (news-source.service.ts:817-820).
	var (
		recentCrawls    map[string]string
		activeLookup    map[string]PipelineJobStatus
		recentCrawlsErr error
		activeLookupErr error
		lookups         sync.WaitGroup
	)
	lookups.Add(2)
	go func() {
		defer lookups.Done()
		recentCrawls, recentCrawlsErr = p.findRecentCrawls(ctx, orgID, candidateURLs, seedConfig.DedupeWindowHours)
	}()
	go func() {
		defer lookups.Done()
		activeLookup, activeLookupErr = p.findActivePipelineJobs(ctx, source.ID, candidateURLs, activeCutoff)
	}()
	lookups.Wait()
	if recentCrawlsErr != nil {
		return nil, recentCrawlsErr
	}
	if activeLookupErr != nil {
		return nil, activeLookupErr
	}

	candidates := make([]PreviewCandidate, 0, len(results))
	for _, result := range results {
		lastCrawlAt := (*string)(nil)
		if crawlAt, ok := recentCrawls[result.URL]; ok {
			lastCrawlAt = &crawlAt
		}
		var inFlightStatus *PipelineJobStatus
		if status, ok := activeLookup[result.URL]; ok {
			inFlightStatus = &status
		}
		signal, hasSignal := discoveryByURL[result.URL]
		var publishedAt, crawledAt *string
		if hasSignal {
			publishedAt = isoFromMillis(signal.PublishedAtTs)
			crawledAt = isoFromMillis(signal.CrawledAtTs)
		}
		var effectiveAt *string
		if publishedAt != nil {
			effectiveAt = publishedAt
		} else if crawledAt != nil {
			effectiveAt = crawledAt
		}
		var errorText *string
		if result.Status == StatusFailed && result.Error != nil {
			errorText = result.Error
		}
		candidates = append(candidates, PreviewCandidate{
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
			Error:              errorText,
		})
	}

	availableToSchedule := 0
	for _, candidate := range candidates {
		if candidate.Status == StatusSuccess && !candidate.AlreadyCrawled && !candidate.AlreadyQueued {
			availableToSchedule++
		}
	}
	scheduleCount := minInt(availableToSchedule, capacity)

	return PreviewSeedResponse{
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

// errNewsSourceMissing is the preview 404.
var errNewsSourceMissing = newStatusError(404, "News source not found")

// loadSource reads the NewsSource row by primary key; the orgId comparison
// happens in Preview.
func (p *PreviewService) loadSource(ctx context.Context, sourceID string) (previewSourceRow, error) {
	var (
		row                 previewSourceRow
		config              []byte
		crawlTemplateID     sql.NullString
		workflowID          sql.NullString
		workflowVersionID   sql.NullString
		workflowBindingMode sql.NullString
	)
	err := p.metadata.db.QueryRowContext(ctx, `
SELECT id, orgId, name, url, config, crawlTemplateId, workflowId, workflowVersionId, workflowBindingMode
FROM NewsSource WHERE id = ?`, sourceID).Scan(
		&row.ID, &row.OrgID, &row.Name, &row.URL, &config, &crawlTemplateID,
		&workflowID, &workflowVersionID, &workflowBindingMode,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return previewSourceRow{}, errNewsSourceMissing
	}
	if err != nil {
		return previewSourceRow{}, err
	}
	row.Config = json.RawMessage(config)
	if crawlTemplateID.Valid {
		row.CrawlTemplateID = &crawlTemplateID.String
	}
	if workflowID.Valid {
		row.WorkflowID = &workflowID.String
	}
	if workflowVersionID.Valid {
		row.WorkflowVersionID = &workflowVersionID.String
	}
	if workflowBindingMode.Valid {
		row.WorkflowBindingMode = &workflowBindingMode.String
	}
	return row, nil
}

// compileOverlay compiles the bound workflow overlay, if any.
func (p *PreviewService) compileOverlay(ctx context.Context, orgID string, source previewSourceRow) (*crawlworkflow.CompiledNewsSourceOverlay, error) {
	if p.workflow == nil {
		return nil, nil
	}
	return p.workflow.CompileNewsSourceOverlay(ctx, orgID,
		derefOrEmpty(source.WorkflowID), derefOrEmpty(source.WorkflowVersionID))
}

// loadTemplateCrawlOptions returns the template's crawlOptions only when the
// template is active and the value is an object.
func (p *PreviewService) loadTemplateCrawlOptions(ctx context.Context, templateID *string) (json.RawMessage, error) {
	if templateID == nil || *templateID == "" {
		return nil, nil
	}
	var (
		isActive sql.NullBool
		options  []byte
	)
	err := p.metadata.db.QueryRowContext(ctx,
		"SELECT isActive, crawlOptions FROM CrawlTemplate WHERE id = ?", *templateID).Scan(&isActive, &options)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !isActive.Valid || !isActive.Bool {
		return nil, nil
	}
	raw := json.RawMessage(options)
	if _, ok := decodeRawObject(raw); !ok {
		return nil, nil
	}
	return raw, nil
}

// mergeCrawlOptions implements `{...template, ...source}`.
func mergeCrawlOptions(template, source json.RawMessage) json.RawMessage {
	merged := map[string]json.RawMessage{}
	if fields, ok := decodeRawObject(template); ok {
		for key, value := range fields {
			merged[key] = value
		}
	}
	if fields, ok := decodeRawObject(source); ok {
		for key, value := range fields {
			merged[key] = value
		}
	}
	return encodeRawObject(merged)
}

// mergeWorkflowSourceConfig implements mergeWorkflowSourceConfig.
func mergeWorkflowSourceConfig(config json.RawMessage, overlay *crawlworkflow.CompiledNewsSourceOverlay) json.RawMessage {
	if overlay == nil {
		return config
	}
	return crawlworkflow.MergeNewsSourceConfig(config, overlay)
}

// workflowSummaryOf returns the overlay's workflow summary.
func workflowSummaryOf(overlay *crawlworkflow.CompiledNewsSourceOverlay) *crawlworkflow.WorkflowSummary {
	if overlay == nil {
		return nil
	}
	summary := overlay.WorkflowSummary
	return &summary
}

// countActivePipelineJobs implements countActivePipelineJobs: the count is capped
// at the in-flight limit (1..50), which is all the preview needs.
func (p *PreviewService) countActivePipelineJobs(ctx context.Context, sourceID string, activeCutoff int64, limit int) (int, error) {
	capped := maxInt(1, minInt(50, limit))
	rows, err := p.metadata.db.QueryContext(ctx, `
SELECT id FROM PipelineJob
WHERE sourceId = ? AND status IN (?, ?, ?, ?) AND createdAt >= ?
LIMIT ?`,
		sourceID, PipelineJobPending, PipelineJobQueued, PipelineJobRunning, PipelineJobDelayed,
		cutoffTime(activeCutoff), capped)
	if err != nil {
		return 0, err
	}
	defer func() { _ = rows.Close() }()
	count := 0
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return 0, err
		}
		count++
	}
	return count, rows.Err()
}

// findActivePipelineJobs implements findActivePipelineJobs: the newest active job
// per URL.
func (p *PreviewService) findActivePipelineJobs(ctx context.Context, sourceID string, urls []string, activeCutoff int64) (map[string]PipelineJobStatus, error) {
	out := map[string]PipelineJobStatus{}
	if len(urls) == 0 {
		return out, nil
	}
	query := "SELECT url, status, createdAt FROM PipelineJob WHERE sourceId = ? AND status IN (?, ?, ?, ?) AND createdAt >= ? AND url IN (" +
		placeholders(len(urls)) + ")"
	args := []any{sourceID, PipelineJobPending, PipelineJobQueued, PipelineJobRunning, PipelineJobDelayed, cutoffTime(activeCutoff)}
	for _, url := range urls {
		args = append(args, url)
	}
	rows, err := p.metadata.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	latest := map[string]struct {
		status    PipelineJobStatus
		createdAt int64
	}{}
	for rows.Next() {
		var (
			url       string
			status    PipelineJobStatus
			createdAt sql.NullTime
		)
		if err := rows.Scan(&url, &status, &createdAt); err != nil {
			return nil, err
		}
		millis := int64(0)
		if createdAt.Valid {
			millis = createdAt.Time.UnixMilli()
		}
		existing, ok := latest[url]
		if !ok || millis > existing.createdAt {
			latest[url] = struct {
				status    PipelineJobStatus
				createdAt int64
			}{status: status, createdAt: millis}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for url, entry := range latest {
		out[url] = entry.status
	}
	return out, nil
}

// findRecentCrawls implements findRecentCrawls: the newest crawlAt per URL inside
// the dedupe window.
func (p *PreviewService) findRecentCrawls(ctx context.Context, orgID string, urls []string, dedupeWindowHours int) (map[string]string, error) {
	out := map[string]string{}
	hours := maxInt(0, minInt(24*30, dedupeWindowHours))
	if hours == 0 || len(urls) == 0 {
		return out, nil
	}
	since := nowMillis() - int64(hours)*60*60*1000
	query := "SELECT url, crawlAt FROM Article WHERE orgId = ? AND crawlAt >= ? AND url IN (" +
		placeholders(len(urls)) + ")"
	args := []any{orgID, cutoffTime(since)}
	for _, url := range urls {
		args = append(args, url)
	}
	rows, err := p.metadata.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	latest := map[string]int64{}
	for rows.Next() {
		var (
			url     string
			crawlAt sql.NullTime
		)
		if err := rows.Scan(&url, &crawlAt); err != nil {
			return nil, err
		}
		if !crawlAt.Valid {
			continue
		}
		millis := crawlAt.Time.UnixMilli()
		if existing, ok := latest[url]; !ok || millis > existing {
			latest[url] = millis
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for url, millis := range latest {
		out[url] = *isoFromMillis(&millis)
	}
	return out, nil
}

// normalizeSeedConfig ports normalizeSeedConfig.
func normalizeSeedConfig(config json.RawMessage, sourceURL string) *SeedConfig {
	fields, ok := decodeRawObject(config)
	if !ok {
		return nil
	}
	seed, ok := decodeRawObject(fields["seed"])
	if !ok || !isRawTrue(seed["enabled"]) {
		return nil
	}

	modeRaw := ""
	if text, ok := jsString(seed["mode"]); ok {
		modeRaw = strings.ToLower(strings.TrimSpace(text))
	}
	mode := SeedModeSitemap
	switch modeRaw {
	case "rss":
		mode = SeedModeRSS
	case "list":
		mode = SeedModeList
	case "deep":
		mode = SeedModeDeep
	}

	config2 := SeedConfig{
		Enabled:             true,
		Mode:                mode,
		MaxURLs:             clampIntRaw(seed["maxUrls"], 1, 2000, 200),
		MaxNewURLsPerRun:    clampIntRaw(seed["maxNewUrlsPerRun"], 1, 500, 80),
		ListMaxPages:        clampIntRaw(seed["listMaxPages"], 1, 20, 6),
		ListPageConcurrency: clampIntRaw(seed["listPageConcurrency"], 1, 5, 2),
		FollowPagination:    !isRawFalse(seed["followPagination"]),
		ScoreThreshold:      clampFloatRaw(seed["scoreThreshold"], 0, 1, 0),
		Concurrency:         clampIntRaw(seed["concurrency"], 1, 10, 5),
		DedupeWindowHours:   clampIntRaw(seed["dedupeWindowHours"], 0, 24*30, 24),
		QueryParamAllowlist: []string{},
	}
	if mode != SeedModeRSS {
		config2.Domain = normalizeSeedDomain(seed["domain"], sourceURL)
	}
	if mode == SeedModeSitemap || mode == SeedModeList || mode == SeedModeDeep {
		if pattern, ok := jsString(seed["pattern"]); ok {
			if trimmed := strings.TrimSpace(pattern); trimmed != "" {
				config2.Pattern = &trimmed
			}
		}
	}
	if mode == SeedModeRSS {
		config2.FeedURL = normalizeSeedFeedURL(seed["feedUrl"], sourceURL)
		config2.RSSFetch = normalizeSeedRSSFetchConfig(seed["rssFetch"])
	}
	query := ""
	if text, ok := jsString(seed["query"]); ok {
		query = strings.TrimSpace(text)
	}
	keywords := normalizeStringList(fields["keywords"])
	effectiveQuery := ""
	switch {
	case query != "":
		effectiveQuery = query
	case len(keywords) > 0:
		effectiveQuery = strings.Join(keywords, " ")
	}
	if effectiveQuery != "" {
		config2.Query = &effectiveQuery
	}
	if mode == SeedModeDeep {
		deep := map[string]json.RawMessage{}
		if value, ok := decodeRawObject(seed["deep"]); ok {
			deep = value
		}
		config2.Deep = &SeedDeepConfig{
			MaxPages:            clampIntRaw(deep["maxPages"], 5, 300, 80),
			MaxDepth:            clampIntRaw(deep["maxDepth"], 1, 4, 2),
			TimeBudgetSeconds:   clampIntRaw(deep["timeBudgetSeconds"], 10, 180, 60),
			PageConcurrency:     clampIntRaw(deep["pageConcurrency"], 1, 6, 2),
			ScoreThreshold:      clampFloatRaw(deep["scoreThreshold"], 0, 1, 0.2),
			CandidatePoolSize:   clampIntRaw(deep["candidatePoolSize"], 20, 400, 120),
			HeadFetchTopK:       clampIntRaw(deep["headFetchTopK"], 10, 120, 40),
			PreferPathDate:      rawBoolOrTrue(deep["preferPathDate"]),
			EnableSecondaryHubs: rawBoolOrTrue(deep["enableSecondaryHubs"]),
			IgnoreRobotsTxt:     true,
		}
	}
	return &config2
}

// normalizeSeedDomain implements normalizeSeedDomain.
func normalizeSeedDomain(raw json.RawMessage, sourceURL string) *string {
	candidate := ""
	if text, ok := jsString(raw); ok {
		candidate = strings.TrimSpace(text)
	}
	if candidate == "" {
		candidate = sourceURL
	}
	withProtocol := candidate
	if !hasHTTPScheme(candidate) {
		withProtocol = "https://" + candidate
	}
	if parsed, err := parseURL(withProtocol); err == nil && parsed.Host != "" {
		value := parsed.Scheme + "://" + parsed.Host
		return &value
	}
	if parsed, err := parseURL(sourceURL); err == nil && parsed.Host != "" {
		value := parsed.Scheme + "://" + parsed.Host
		return &value
	}
	return nil
}

// normalizeSeedFeedURL implements normalizeSeedFeedUrl.
func normalizeSeedFeedURL(raw json.RawMessage, sourceURL string) *string {
	candidate := ""
	if text, ok := jsString(raw); ok {
		candidate = strings.TrimSpace(text)
	}
	if candidate == "" {
		candidate = sourceURL
	}
	withProtocol := candidate
	if !hasHTTPScheme(candidate) {
		withProtocol = "https://" + candidate
	}
	if parsed, err := parseURL(withProtocol); err == nil && parsed.Host != "" {
		value := parsed.String()
		return &value
	}
	if parsed, err := parseURL(sourceURL); err == nil && parsed.Host != "" {
		value := parsed.String()
		return &value
	}
	return nil
}

// normalizeSeedRSSFetchConfig implements normalizeSeedRssFetchConfig.
func normalizeSeedRSSFetchConfig(raw json.RawMessage) *SeedRSSFetchConfig {
	record, ok := decodeRawObject(raw)
	hasCustomFields := ok && (hasKey(record, "requestTimeoutMs") ||
		hasKey(record, "bodySourceStrategy") || hasKey(record, "noBodyPolicy"))
	enabled := isRawTrue(rawFromFields(record, "enabled")) ||
		(isRawFalse(rawFromFields(record, "enabled")) == false && hasCustomFields)
	if !enabled {
		return &SeedRSSFetchConfig{
			Enabled:            false,
			RequestTimeoutMs:   15_000,
			BodySourceStrategy: RSSBodySourceContentFirst,
			NoBodyPolicy:       RSSNoBodyPolicySkip,
		}
	}
	bodySourceStrategy := RSSBodySourceContentFirst
	if text, ok := jsString(rawFromFields(record, "bodySourceStrategy")); ok {
		switch strings.ToLower(strings.TrimSpace(text)) {
		case RSSBodySourceContentOnly, RSSBodySourceSummaryOnly:
			bodySourceStrategy = strings.ToLower(strings.TrimSpace(text))
		}
	}
	noBodyPolicy := RSSNoBodyPolicySkip
	if text, ok := jsString(rawFromFields(record, "noBodyPolicy")); ok {
		if strings.ToLower(strings.TrimSpace(text)) == RSSNoBodyPolicyTitleDescriptionStub {
			noBodyPolicy = RSSNoBodyPolicyTitleDescriptionStub
		}
	}
	return &SeedRSSFetchConfig{
		Enabled:            true,
		RequestTimeoutMs:   clampIntRaw(rawFromFields(record, "requestTimeoutMs"), 1000, 120000, 15000),
		BodySourceStrategy: bodySourceStrategy,
		NoBodyPolicy:       noBodyPolicy,
	}
}

// normalizeStringList implements normalizeStringList (no dedupe).
func normalizeStringList(raw json.RawMessage) []string {
	if len(raw) == 0 || !jsonIsArrayRaw(raw) {
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
	}
	out := []string{}
	for _, item := range items {
		text, ok := jsString(item)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

// clampIntRaw implements clampInt.
func clampIntRaw(raw json.RawMessage, min, max, fallback int) int {
	var value float64
	if len(raw) == 0 {
		return fallback
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	if value != value {
		return fallback
	}
	rounded := int(jsRoundHalfUp(value))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

// clampFloatRaw implements clampFloat.
func clampFloatRaw(raw json.RawMessage, min, max, fallback float64) float64 {
	var value float64
	if len(raw) == 0 {
		return fallback
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	if value != value {
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

func jsRoundHalfUp(value float64) float64 {
	if value < 0 {
		return -jsRoundHalfUp(-value)
	}
	return float64(int64(value + 0.5))
}

// previewTimestampSource implements resolvePreviewTimestampSource.
func previewTimestampSource(publishedAt, crawledAt *string) TimestampSource {
	if publishedAt != nil && *publishedAt != "" {
		return TimestampSourcePublished
	}
	if crawledAt != nil && *crawledAt != "" {
		return TimestampSourceCrawled
	}
	return TimestampSourceNone
}

// rssFetchOptionsOf converts the normalized seed RSS options to the discovery
// input.
func rssFetchOptionsOf(config *SeedRSSFetchConfig) *RSSFetchOptions {
	if config == nil {
		return nil
	}
	return &RSSFetchOptions{
		RequestTimeoutMs:   intPtrValue(config.RequestTimeoutMs),
		BodySourceStrategy: config.BodySourceStrategy,
		NoBodyPolicy:       config.NoBodyPolicy,
	}
}

// deepOptionsOf converts the normalized seed deep options to the discovery input.
func deepOptionsOf(config *SeedDeepConfig) *DeepOptions {
	if config == nil {
		return nil
	}
	return &DeepOptions{
		MaxPages:            config.MaxPages,
		MaxDepth:            config.MaxDepth,
		TimeBudgetSeconds:   config.TimeBudgetSeconds,
		PageConcurrency:     config.PageConcurrency,
		ScoreThreshold:      config.ScoreThreshold,
		CandidatePoolSize:   config.CandidatePoolSize,
		HeadFetchTopK:       config.HeadFetchTopK,
		PreferPathDate:      config.PreferPathDate,
		EnableSecondaryHubs: config.EnableSecondaryHubs,
		IgnoreRobotsTxt:     config.IgnoreRobotsTxt,
	}
}

// cutoffTime converts a millisecond instant to the time value MySQL compares.
func cutoffTime(millis int64) any {
	return time.UnixMilli(millis).UTC()
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	parts := make([]string, count)
	for index := range parts {
		parts[index] = "?"
	}
	return strings.Join(parts, ", ")
}

func hasKey(fields map[string]json.RawMessage, key string) bool {
	if fields == nil {
		return false
	}
	_, ok := fields[key]
	return ok
}

func rawFromFields(fields map[string]json.RawMessage, key string) json.RawMessage {
	if fields == nil {
		return nil
	}
	return fields[key]
}

func jsonObjectField(raw json.RawMessage, key string) (json.RawMessage, bool) {
	fields, ok := decodeRawObject(raw)
	if !ok {
		return nil, false
	}
	value, ok := fields[key]
	if !ok || !jsonIsObjectRaw(value) {
		return nil, false
	}
	return value, true
}

func jsonObjectOrNil(raw json.RawMessage) json.RawMessage {
	if _, ok := decodeRawObject(raw); !ok {
		return nil
	}
	return raw
}

func isRawTrue(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "true"
}

func isRawFalse(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "false"
}

func rawBoolOrTrue(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return true
	}
	return value
}

func derefOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func boolPtrValue(value bool) *bool { return &value }

func stringOrNilPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
