package crawlexecution

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// Config carries the environment values the crawl execution path reads. They
// mirror the Crawl4aiSettings/CrawlSettingsService defaults plus the news source
// scheduler circuit-breaker values CrawlExecutionResultsService reads from
// EnvService.newsSourceSchedulerConfig.
type Config struct {
	// CrawlBaseURL is CRAWL4AI_BASE_URL (no trailing slash).
	CrawlBaseURL string
	// CrawlAPIKey is CRAWL4AI_API_KEY, forwarded as x-api-key.
	CrawlAPIKey string
	// CrawlTimeoutMs is CRAWL4AI_TIMEOUT_MS (transport ceiling).
	CrawlTimeoutMs int
	// CrawlHealthCheckTTLMs is CRAWL4AI_HEALTH_CHECK_TTL_MS.
	CrawlHealthCheckTTLMs int
	// CrawlSSRFProxyURL is CRAWL4AI_SSRF_PROXY_URL.
	CrawlSSRFProxyURL string
	// CrawlJSCodeEnabled is CRAWL4AI_JSCODE_ENABLED.
	CrawlJSCodeEnabled bool

	// Crawl media assets (CRAWL_MEDIA_*): download timeout, per-asset byte
	// ceiling and assets stored per crawl result. Zero values mirror the
	// NestJS "disabled" semantics.
	MediaFetchTimeoutMs int
	MediaMaxBytes       int
	MediaMaxPerResult   int

	// News source failure-recovery/circuit-breaker values
	// (NEWS_SOURCE_SCHEDULER_*); zero keeps the NestJS defaults.
	FailureRecoveryDelayMs    int
	FailureMaxDelayMs         int
	CircuitBreakerThreshold   int
	CircuitBreakerBaseDelayMs int
	CircuitBreakerMaxDelayMs  int
	// AutoDisableThreshold is NEWS_SOURCE_SCHEDULER_AUTO_DISABLE_THRESHOLD: the
	// consecutive-failure count that deactivates a source. Zero disables the
	// auto-disable branch together with its notification.
	AutoDisableThreshold int
}

// ItemIngestor is the ItemsService.createFromCrawlResultsBatch branch used by
// ingestToItems. *itemsingest.Service satisfies it.
type ItemIngestor interface {
	CreateFromCrawlResult(ctx context.Context, orgID, userID, crawlResultID string) (itemsreading.ItemMetaRow, error)
}

// Options wires the crawl execution service. DB, Mongo and Redis are the shared
// handles the go mode already owns; HTTPClient and Now are test seams.
type Options struct {
	DB         *sql.DB
	Mongo      *mongo.Database
	Redis      *redis.Client
	Config     Config
	HTTPClient *http.Client
	Now        func() time.Time

	// Settings optionally overrides the crawl_client:settings reader. Nil builds
	// the standard Redis-then-MySQL reader from DB/Redis.
	Settings *crawlqueue.SettingsReader
	// Items is required only for tasks whose config sets ingestToItems=true.
	Items ItemIngestor
	// Storage resolves the runtime storage configuration snapshot the media
	// branch signs and uploads with. Nil keeps media persistence disabled.
	Storage objectstorage.ConfigReader
	// Relay publishes the identifiers-only notification relay after a
	// Notification row commits (notification:events:v1). Nil writes the row and
	// skips the relay, which is the legacy socket mode contract.
	Relay NotificationRelayPublisher
	// Scheduler writes the org-wide circuit-open and auto-disable notifications
	// of the news source failure state (B2). A nil scheduler turns them into
	// no-ops; O2 never uses it.
	Scheduler SchedulerPort
}

// SchedulerPort is the newssourcescheduler surface the crawl execution path
// needs: the org-wide system notification writer with the generic relay (B2).
// *newssourcescheduler.Service implements it.
type SchedulerPort interface {
	// NotifySystemGeneric writes one org-wide system notification and publishes
	// the generic notification:events:v1 relay (never the legacy
	// news-source:notifications:v1 channel).
	NotifySystemGeneric(ctx context.Context, orgID, title, body string, data json.RawMessage, relay newssourcescheduler.NotificationRelayFunc)
}

// Service runs one CrawlTask in process. The three crawl BullMQ queues stay on
// NestJS; this service never enqueues crawl work.
type Service struct {
	db        *sql.DB
	mongo     *mongo.Database
	redis     *redis.Client
	cfg       Config
	client    *crawl4ai.Client
	http      *http.Client
	settings  *crawlqueue.SettingsReader
	items     ItemIngestor
	storage   objectstorage.ConfigReader
	relay     NotificationRelayPublisher
	scheduler SchedulerPort
	now       func() time.Time
	// sleep is the notification retry delay, overridable in tests.
	sleep func(ctx context.Context, delay time.Duration)
	// snapshots coalesces the per-source ops snapshot refresh (O2).
	snapshots *snapshotCoalescer
	// publishSignalFetch overrides the SSRF-guarded outbound fetch of the
	// publish-signal probes in tests.
	publishSignalFetch func(ctx context.Context, targetURL string, timeoutMs int) (*http.Response, bool)
}

// New builds the service. A nil HTTPClient uses a redirect-disabled client so
// the conditional preflight can validate every redirect hop itself.
func New(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	settings := options.Settings
	if settings == nil {
		settings = crawlqueue.NewSettingsReader(options.DB, options.Redis, nil)
	}
	service := &Service{
		db:        options.DB,
		mongo:     options.Mongo,
		redis:     options.Redis,
		cfg:       options.Config,
		http:      httpClient,
		settings:  settings,
		items:     options.Items,
		storage:   options.Storage,
		relay:     options.Relay,
		scheduler: options.Scheduler,
		now:       now,
		sleep:     sleepWithContext,
	}
	service.snapshots = newSnapshotCoalescer(snapshotRefresherFunc(service.refreshSourceQueueCounts), snapshotCoalesceWindow, now)
	service.client = crawl4ai.New(crawl4ai.Options{
		BaseURL:          options.Config.CrawlBaseURL,
		APIKey:           options.Config.CrawlAPIKey,
		TimeoutMs:        options.Config.CrawlTimeoutMs,
		HealthCheckTTLMs: options.Config.CrawlHealthCheckTTLMs,
		SSRFProxyURL:     options.Config.CrawlSSRFProxyURL,
		JSCodeEnabled:    options.Config.CrawlJSCodeEnabled,
		HTTPClient:       httpClient,
		Now:              func() int64 { return service.now().UnixMilli() },
	})
	return service
}

// RunTask, RunQueuedTask and the shared runTask entry point live in queued.go.

// runTaskBody is the try block of runTask.
func (s *Service) runTaskBody(ctx context.Context, scope *runTaskContext) (FullSummary, error) {
	task := scope.Task
	orgID := scope.OrgID
	sourceID := scope.SourceID
	// requestTimeoutMs is the normalized retryContext.requestTimeoutMs; the
	// pipeline path has no retry context and normalizes zero.
	requestTimeoutMs := scope.RequestTimeoutMs
	configRecord := decodeConfigObject(task.Config)

	if err := assertNoUnsupportedProxy(task.Config, "task.config"); err != nil {
		return FullSummary{}, err
	}
	options := extractOptions(configRecord)
	urlQueryParamAllowlist := extractURLQueryParamAllowlistFromTaskConfig(task.Config)
	conditionalSettings := s.getConditionalRequestSettings(ctx)
	marshaledOptions, marshalErr := marshalOptions(options)
	if marshalErr != nil {
		return FullSummary{}, marshalErr
	}
	if err := assertNoCrawl4aiLLMOptions(marshaledOptions, "task.config.options"); err != nil {
		return FullSummary{}, err
	}
	ingestToItems := configBool(configRecord, "ingestToItems")

	normalizer := crawloptions.NewNormalizer(s.cfg.CrawlBaseURL)
	effectiveOptions := ensureTaskSessionReuse(task.ID, normalizer.Normalize(options))
	payload := s.buildRequestPayload(task, normalizer, effectiveOptions)
	effectiveOptions = payload.Options
	payloadURLs := payload.URLs
	if len(payloadURLs) == 0 {
		payloadURLs = []string{task.TargetURL}
		payload.URLs = payloadURLs
	}
	isSingleURLPayload := len(payloadURLs) <= 1

	latestValidation, err := s.findLatestResultHTTPValidationState(ctx, task, urlQueryParamAllowlist)
	if err != nil {
		return FullSummary{}, err
	}
	var preflightResult *conditionalPreflightOutcome
	if conditionalSettings.Enabled {
		preflightResult = s.runConditionalPreflight(ctx, conditionalPreflightInput{
			TargetURL:        task.TargetURL,
			Options:          effectiveOptions,
			RequestTimeoutMs: requestTimeoutMs,
			ETag:             validationETag(latestValidation),
			LastModified:     validationLastModified(latestValidation),
			TimeoutMs:        conditionalSettings.TimeoutMs,
			MaxRetries:       conditionalSettings.MaxRetries,
		})
		if preflightResult != nil {
			hasConditionalHeaders := latestValidation != nil &&
				(latestValidation.ETag != nil || latestValidation.LastModified != nil)
			if preflightResult.Status == "completed" {
				s.writeTaskLog(ctx, taskLogEntry{
					Queue:   crawlQueueName,
					JobID:   task.ID,
					OrgID:   orgID,
					Stage:   "preflight",
					Status:  "completed",
					Message: stringPtr("HTTP validator preflight completed"),
					Data: map[string]any{
						"method":                preflightResult.Result.Method,
						"status":                preflightResult.Result.Status,
						"attempts":              preflightResult.Attempts,
						"failures":              preflightResult.Failures,
						"etag":                  nullableStringValue(preflightResult.Result.ETag),
						"lastModified":          nullableStringValue(preflightResult.Result.LastModified),
						"hasConditionalHeaders": hasConditionalHeaders,
					},
				})
			} else {
				s.writeTaskLog(ctx, taskLogEntry{
					Queue:   crawlQueueName,
					JobID:   task.ID,
					OrgID:   orgID,
					Stage:   "preflight",
					Status:  "failed",
					Message: stringPtr("HTTP validator preflight failed"),
					Data: map[string]any{
						"attempts":              preflightResult.Attempts,
						"failures":              preflightResult.Failures,
						"hasConditionalHeaders": hasConditionalHeaders,
					},
				})
			}
		}
	}

	if preflightResult != nil && preflightResult.Status == "completed" &&
		preflightResult.Result.Status == http.StatusNotModified &&
		isSingleURLPayload && latestValidation != nil && latestValidation.ResultID != "" {
		return s.completeFrom304Reuse(ctx, scope, preflightResult, latestValidation, ingestToItems)
	}

	preflightMetadata := buildHTTPValidationMetadata(preflightResult)

	initialRun, err := s.runCrawlWithHeadedFallback(ctx, crawlCall{
		Request:          payload,
		Options:          effectiveOptions,
		RequestTimeoutMs: requestTimeoutMs,
		TaskID:           task.ID,
		OrgID:            orgID,
		Stage:            "crawler",
		Reason:           "initial_request",
	})
	if err != nil {
		return FullSummary{}, err
	}
	run := initialRun
	effectiveOptions = initialRun.Options

	retryResult := s.retryForBotChallengeIfNeeded(ctx, botChallengeInput{
		Task:             task,
		OrgID:            orgID,
		Options:          effectiveOptions,
		Response:         run.Response,
		Successes:        run.Successes,
		Failures:         run.Failures,
		LowSignal:        run.LowSignal,
		RequestTimeoutMs: requestTimeoutMs,
	})
	if retryResult != nil {
		run = *retryResult
		effectiveOptions = ensureTaskSessionReuse(task.ID, run.Options)
	}

	if s.shouldAttemptEmptyMarkdownFallback(run.Successes, run.Failures) {
		fallbackRun, err := s.runEmptyMarkdownFallback(ctx, task, orgID, effectiveOptions, requestTimeoutMs)
		if err != nil {
			return FullSummary{}, err
		}
		if fallbackRun != nil {
			run = *fallbackRun
			effectiveOptions = ensureTaskSessionReuse(task.ID, run.Options)
		}
	}

	seedCandidates := buildExpansionSeedCandidates(run.Successes, run.LowSignal)
	seededFromLowSignal := len(run.Successes) == 0 && len(seedCandidates) > 0
	expansion, err := s.expandListLikeResultsIfNeeded(ctx, expansionInput{
		Task:                task,
		OrgID:               orgID,
		Keywords:            payload.Keywords,
		CrawlOptions:        ensureTaskSessionReuse(task.ID, effectiveOptions),
		Successes:           seedCandidates,
		SeededFromLowSignal: seededFromLowSignal,
		RequestTimeoutMs:    requestTimeoutMs,
	})
	if err != nil {
		return FullSummary{}, err
	}
	if expansion != nil {
		run.Successes = expansion.Successes
		if len(expansion.Failures) > 0 {
			run.Failures = append(run.Failures, expansion.Failures...)
		}
		if expansion.RunID != nil {
			run.Response.RunID = *expansion.RunID
		}
	}

	persistedSuccesses := attachHTTPValidationMetadata(run.Successes, preflightMetadata, task.TargetURL)
	failureRetryableCount := countRetryableFailures(run.Failures)

	s.writeTaskLog(ctx, taskLogEntry{
		Queue:   crawlQueueName,
		JobID:   task.ID,
		OrgID:   orgID,
		Stage:   "crawler",
		Status:  "completed",
		Message: stringPtr(crawlerLogMessage(run.Failures, run.Response.Warnings)),
		Data: map[string]any{
			"request": map[string]any{
				"urls":               len(payloadURLs),
				"scanFullPage":       effectiveOptions.ScanFullPage,
				"scrollDelayMs":      intPtrValue(effectiveOptions.ScrollDelayMs),
				"virtualScroll":      virtualScrollLogValue(effectiveOptions.VirtualScroll),
				"onlyMainContent":    effectiveOptions.OnlyMainContent,
				"wordCountThreshold": intPtrValue(effectiveOptions.WordCountThreshold),
				"includeImages":      effectiveOptions.IncludeImages,
				"storeMedia":         effectiveOptions.StoreMedia,
				"waitForImages":      effectiveOptions.WaitForImages,
			},
			"runId":             nullableRunID(run.Response.RunID),
			"nextCursor":        nullableStringValue(run.Response.NextCursor),
			"totalResults":      len(run.Response.Results),
			"successes":         len(persistedSuccesses),
			"failures":          len(run.Failures),
			"retryableFailures": failureRetryableCount,
			"warnings":          run.Response.Warnings,
			"warningCount":      len(run.Response.Warnings),
			"failureSamples":    failureSamples(run.Failures, 10),
		},
	})

	persisted, memory, err := s.persistResults(ctx, task, persistedSuccesses, effectiveOptions, run.Response, ingestToItems, orgID)
	if err != nil {
		return FullSummary{}, err
	}
	summary := fullSummaryFromPersisted(persisted, memory, ingestToItems)
	if len(run.Failures) > 0 {
		summary.Failures = run.Failures
		retryableFailures := failureRetryableCount
		summary.RetryableFailures = &retryableFailures
	}
	if summary.Inserted == 0 && summary.Skipped == 0 {
		return FullSummary{}, buildNoResultsError(run.Failures)
	}

	lastResultAt := summary.LastFetchedAt
	if lastResultAt == nil {
		lastResultAt = task.LastResultAt
	}
	nextCursor := task.LastCursor
	if run.Response.NextCursor != nil {
		nextCursor = run.Response.NextCursor
	}
	if err := s.markTaskCompleted(ctx, task, completedTaskUpdate{
		LastResultAt: lastResultAt,
		LastCursor:   nextCursor,
		Memory:       memory,
	}); err != nil {
		return FullSummary{}, err
	}
	s.syncSourceQueueCounts(ctx, orgID, sourceID)

	// The complete-stage TaskLog data IS the runTask summary, including the
	// memory block, the failure details and retryableFailures, in NestJS member
	// order.
	s.writeCompleteTaskLog(ctx, task.ID, orgID, summary)
	if scope.TriggeredByID != "" {
		s.safeNotifyCrawl(ctx, task, summary, scope.TriggeredByID, notificationStatusCompleted, "")
	}
	return summary, nil
}

// completeFrom304Reuse is the "HTTP 304 reuse" success branch: no crawl body is
// extracted, the stored result is reused and ingestToItems is re-run because the
// reused result may predate the ingest switch.
func (s *Service) completeFrom304Reuse(
	ctx context.Context,
	scope *runTaskContext,
	preflightResult *conditionalPreflightOutcome,
	latest *httpValidationState,
	ingestToItems bool,
) (FullSummary, error) {
	task := scope.Task
	orgID := scope.OrgID
	reusedResultID := latest.ResultID
	fetchedAt := latest.FetchedAt
	summary := FullSummary{
		Inserted:       0,
		Skipped:        1,
		ReusedResultID: &reusedResultID,
		LastFetchedAt:  &fetchedAt,
	}
	s.writeTaskLog(ctx, taskLogEntry{
		Queue:   crawlQueueName,
		JobID:   task.ID,
		OrgID:   orgID,
		Stage:   "crawler",
		Status:  "completed",
		Message: stringPtr("Skipped crawl body extraction via HTTP 304 reuse"),
		Data: map[string]any{
			"reusedResultId": latest.ResultID,
			"status":         preflightResult.Result.Status,
			"etag":           firstStringPtr(preflightResult.Result.ETag, latest.ETag),
			"lastModified":   firstStringPtr(preflightResult.Result.LastModified, latest.LastModified),
		},
	})
	if err := s.markTaskCompleted(ctx, task, completedTaskUpdate{
		LastResultAt: &fetchedAt,
		LastCursor:   task.LastCursor,
		Memory:       memoryStats{},
	}); err != nil {
		return FullSummary{}, err
	}
	s.syncSourceQueueCounts(ctx, orgID, scope.SourceID)
	s.writeCompleteTaskLog(ctx, task.ID, orgID, summary)
	if scope.TriggeredByID != "" {
		s.safeNotifyCrawl(ctx, task, summary, scope.TriggeredByID, notificationStatusCompleted, "")
	}
	// 304 reuse skips persistResults entirely, so an ingestToItems task whose
	// reused result was never ingested (fresh switch, or a reuse of a pre-ingest
	// history run) would silently never reach the pipeline. The ingest is
	// idempotent, so re-running it is safe.
	if ingestToItems && latest.ResultID != "" {
		s.ingestReusedResult(ctx, orgID, task, latest.ResultID)
	}
	return summary, nil
}

// ingestReusedResult re-runs the items ingest for a reused result. Failures are
// logged and swallowed, like the NestJS try/catch around
// createFromCrawlResultsBatch on the 304 path.
func (s *Service) ingestReusedResult(ctx context.Context, orgID string, task *taskRow, resultID string) {
	if s.items == nil {
		log.Printf("crawlexecution: items service unavailable; skipping reused crawl result ingest taskId=%s resultId=%s", task.ID, resultID)
		return
	}
	userID := task.CreatedByID
	if _, err := s.items.CreateFromCrawlResult(ctx, orgID, userID, resultID); err != nil {
		log.Printf("crawlexecution: failed to ingest reused crawl result taskId=%s resultId=%s: %v", task.ID, resultID, err)
	}
}

// ErrNotConfigured reports a missing shared handle.
type errNotConfigured string

func (e errNotConfigured) Error() string { return string(e) }

// crawlCall is one runCrawlWithHeadedFallback invocation.
type crawlCall struct {
	Request          requestPayload
	Options          normalizedOptions
	RequestTimeoutMs int
	TaskID           string
	OrgID            string
	Stage            string
	Reason           string
}

// completedTaskUpdate is the terminal CrawlTask update payload.
type completedTaskUpdate struct {
	LastResultAt *time.Time
	LastCursor   *string
	Memory       memoryStats
}
