package crawltaskwrite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
)

// Permission names enforced by the three write routes.
const (
	permissionCrawlWrite = "crawl.write"
	permissionItemsWrite = "items.write"
)

// Config carries the environment values the service needs.
type Config struct {
	// DefaultConcurrency is CRAWL4AI_MAX_CONCURRENCY.
	DefaultConcurrency int
	// CrawlBaseURL is CRAWL4AI_BASE_URL (proxy localhost translation).
	CrawlBaseURL string
	// RateLimitFailOpen is RATE_LIMIT_REDIS_FAIL_OPEN.
	RateLimitFailOpen bool
	// RateLimitCrawlTaskCreate and ...Window are the environment fallback of
	// the crawlCreate rate limit bucket.
	RateLimitCrawlTaskCreate       int
	RateLimitCrawlTaskCreateWindow int
}

// Options wires the service.
type Options struct {
	DB     *sql.DB
	Redis  *redis.Client
	Queue  *crawlqueue.Producer
	Config Config
	// Validator performs the IsSafeUrl DNS check. A nil validator skips it.
	Validator *crawloptions.URLValidator
	// Now overrides the clock; tests only.
	Now func() time.Time
}

// Service implements createTask, deleteTask and retryTask.
type Service struct {
	db        *sql.DB
	redis     *redis.Client
	queue     *crawlqueue.Producer
	cfg       Config
	validator *crawloptions.URLValidator
	normalize *crawloptions.Normalizer
	now       func() time.Time
}

// NewService builds the write service.
func NewService(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		db:        options.DB,
		redis:     options.Redis,
		queue:     options.Queue,
		cfg:       options.Config,
		validator: options.Validator,
		normalize: crawloptions.NewNormalizer(options.Config.CrawlBaseURL),
		now:       now,
	}
}

// Validator exposes the URL validator to the handler's DTO step.
func (s *Service) Validator() *crawloptions.URLValidator {
	if s == nil {
		return nil
	}
	return s.validator
}

// CreateTask is CrawlTaskService.createTask. The DTO has already passed the
// REST validator (or the GraphQL input mapping).
func (s *Service) CreateTask(ctx context.Context, caller *authhttp.Identity, input crawloptions.CreateTaskInput, ip *string) (crawlreadtelemetry.CrawlTaskView, error) {
	if s == nil || s.db == nil {
		return crawlreadtelemetry.CrawlTaskView{}, errDatabase
	}
	ingestToItems := input.IngestToItems != nil && *input.IngestToItems
	if ingestToItems && !caller.HasPermission(permissionItemsWrite) {
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusForbidden,
			"items.write permission is required to ingest crawl results into Items")
	}
	if err := s.enforceCrawlTaskCreate(ctx, caller.OrgID, caller.UserID, ip); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}

	stripped := s.normalizeActorOptions(ctx, caller, input.Options)
	if err := crawloptions.AssertNoUnsupportedProxy(input.RawOptions, "options"); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	// The LLM guard runs on the typed options after JS stripping, which is the
	// same document NestJS checks (the DTO whitelist already removed keys the
	// typed form cannot carry).
	strippedJSON, err := json.Marshal(stripped)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	if err := crawloptions.AssertNoCrawl4aiLlmOptions(strippedJSON, "options"); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}

	keywords := crawloptions.NormalizeKeywords(input.Keywords)
	timeRangeFrom := crawloptions.CoerceDate(stringValue(input.TimeRangeFrom))
	timeRangeTo := crawloptions.CoerceDate(stringValue(input.TimeRangeTo))
	if timeRangeFrom != nil && timeRangeTo != nil && timeRangeFrom.After(*timeRangeTo) {
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusBadRequest,
			"timeRangeFrom must be earlier than timeRangeTo")
	}

	if stripped != nil {
		stripped.MarkdownFilter = crawloptions.NormalizeMarkdownFilterForTask(stripped.MarkdownFilter)
	}
	normalized := s.normalize.Normalize(stripped)

	defaultConcurrency := s.cfg.DefaultConcurrency
	if defaultConcurrency < 1 {
		defaultConcurrency = 3
	}
	concurrency := defaultConcurrency
	if input.Concurrency != nil && *input.Concurrency < defaultConcurrency {
		concurrency = *input.Concurrency
	}

	configJSON, err := marshalStoredConfig(normalized, ingestToItems)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	keywordsJSON, err := json.Marshal(keywords)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}

	taskID, err := newRowID()
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	now := nowMillis()
	if _, err := s.db.ExecContext(ctx,
		"INSERT INTO CrawlTask (id, orgId, createdById, targetUrl, displayName, status, config, timeRangeFrom, timeRangeTo, concurrency, keywords, runCount, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, ?)",
		taskID, caller.OrgID, caller.UserID, input.URL, nullableStringPtr(input.DisplayName),
		configJSON, nullableTimePtr(timeRangeFrom), nullableTimePtr(timeRangeTo),
		concurrency, keywordsJSON, now, now); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, fmt.Errorf("%w: %v", errDatabase, err)
	}

	auditMetadata, err := json.Marshal(createAuditMetadata{
		TargetURL:     input.URL,
		Keywords:      keywords,
		Concurrency:   concurrency,
		IngestToItems: ingestToItems,
	})
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	if err := writeAuditLogBestEffort(ctx, s.db, auditEntry{
		OrgID:    caller.OrgID,
		ActorID:  caller.UserID,
		Resource: "crawlTask",
		Action:   "create",
		Metadata: auditMetadata,
	}); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}

	if _, err := s.queue.EnqueueTask(ctx, taskID, caller.OrgID, crawlqueue.EnqueueOptions{
		TriggeredByID: &caller.UserID,
		TraceID:       traceFromContext(ctx),
	}); err != nil {
		log.Printf("crawltaskwrite: enqueue failed for task %s: %v", taskID, err)
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusInternalServerError, "Internal server error")
	}
	if _, err := s.db.ExecContext(ctx,
		"UPDATE CrawlTask SET status = 'queued', updatedAt = ? WHERE id = ? AND status = 'pending'",
		nowMillis(), taskID); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, fmt.Errorf("%w: %v", errDatabase, err)
	}

	view, found, err := s.taskView(ctx, caller.OrgID, taskID)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	if !found {
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusInternalServerError, "Internal server error")
	}
	return view, nil
}

// DeleteTask is CrawlTaskService.deleteTask.
func (s *Service) DeleteTask(ctx context.Context, caller *authhttp.Identity, taskID string) error {
	if s == nil || s.db == nil {
		return errDatabase
	}
	var status string
	var resultCount int64
	err := s.db.QueryRowContext(ctx,
		"SELECT status, (SELECT COUNT(*) FROM CrawlResult r WHERE r.taskId = t.id) FROM CrawlTask t WHERE t.id = ? AND t.orgId = ?",
		taskID, caller.OrgID).Scan(&status, &resultCount)
	if errors.Is(err, sql.ErrNoRows) {
		return newStatus(http.StatusNotFound, "Crawl task not found")
	}
	if err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	if status == string(crawlreadtelemetry.CrawlTaskStatusRunning) {
		return newStatus(http.StatusConflict, "Cannot delete a crawl task that is currently running")
	}

	if _, err := s.queue.RemoveQueuedJobs(ctx, taskID); err != nil {
		log.Printf("crawltaskwrite: remove queued jobs failed for task %s: %v", taskID, err)
		return newStatus(http.StatusInternalServerError, "Internal server error")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlResult WHERE taskId = ?", taskID); err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM CrawlTask WHERE id = ? AND orgId = ?", taskID, caller.OrgID); err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	outboxID, err := newRowID()
	if err != nil {
		return err
	}
	now := nowMillis()
	payload, err := json.Marshal(cleanupOutboxPayload{
		Type:   "cleanup_crawl_results",
		TaskID: taskID,
		OrgID:  caller.OrgID,
	})
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO MongoOutbox (id, orgId, type, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, 'cleanup_crawl_results', ?, 'pending', 0, ?, ?, ?)",
		outboxID, caller.OrgID, payload, now, now, now); err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	auditMetadata, err := json.Marshal(deleteAuditMetadata{TaskID: taskID, DeletedResultCount: int(resultCount)})
	if err != nil {
		return err
	}
	if err := writeAuditLogBestEffort(ctx, tx, auditEntry{
		OrgID:    caller.OrgID,
		ActorID:  caller.UserID,
		Resource: "crawlTask",
		Action:   "delete",
		Metadata: auditMetadata,
	}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%w: %v", errDatabase, err)
	}
	return nil
}

// RetryTask is CrawlTaskService.retryTask with the C1 rollback on enqueue
// failure.
func (s *Service) RetryTask(ctx context.Context, caller *authhttp.Identity, taskID string, ip *string) (crawlreadtelemetry.CrawlTaskView, error) {
	if s == nil || s.db == nil {
		return crawlreadtelemetry.CrawlTaskView{}, errDatabase
	}
	if err := s.enforceCrawlTaskCreate(ctx, caller.OrgID, caller.UserID, ip); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	original, found, err := s.taskView(ctx, caller.OrgID, taskID)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	if !found {
		// Lowercase message matches NestJS exactly for retry.
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusNotFound, "crawl task not found")
	}
	var configRaw []byte
	var lastError sql.NullString
	err = s.db.QueryRowContext(ctx,
		"SELECT config, lastError FROM CrawlTask WHERE id = ? AND orgId = ?",
		taskID, caller.OrgID).Scan(&configRaw, &lastError)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, fmt.Errorf("%w: %v", errDatabase, err)
	}
	if err := crawloptions.AssertNoUnsupportedProxy(configRaw, "task.config"); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	if configIngestToItems(configRaw) && !caller.HasPermission(permissionItemsWrite) {
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusForbidden,
			"items.write permission is required to ingest crawl results into Items")
	}
	enqueueOptions := crawlqueue.EnqueueOptions{}
	if extracted := extractEnqueueOptions(configRaw); extracted != nil {
		enqueueOptions = *extracted
	}

	status := string(original.Status)
	if status == string(crawlreadtelemetry.CrawlTaskStatusRunning) || status == string(crawlreadtelemetry.CrawlTaskStatusQueued) {
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusConflict,
			"Cannot retry a task that is currently "+status)
	}

	if _, err := s.db.ExecContext(ctx,
		"UPDATE CrawlTask SET status = 'queued', lastError = NULL, updatedAt = ? WHERE id = ? AND orgId = ?",
		nowMillis(), taskID, caller.OrgID); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, fmt.Errorf("%w: %v", errDatabase, err)
	}
	// C1: when the enqueue fails, roll the status back so the operator can
	// retry immediately instead of waiting for the NestJS janitor.
	if _, err := s.queue.EnqueueTask(ctx, taskID, caller.OrgID, enqueueOptions); err != nil {
		log.Printf("crawltaskwrite: retry enqueue failed for task %s: %v", taskID, err)
		rollback := "UPDATE CrawlTask SET status = ?, lastError = ?, updatedAt = ? WHERE id = ? AND orgId = ? AND status = 'queued'"
		if _, rollbackErr := s.db.ExecContext(ctx, rollback, status, nullableStringValue(lastError), nowMillis(), taskID, caller.OrgID); rollbackErr != nil {
			log.Printf("crawltaskwrite: failed to roll back retry status for task %s: %v", taskID, rollbackErr)
		}
		return crawlreadtelemetry.CrawlTaskView{}, newStatus(http.StatusInternalServerError, "Internal server error")
	}

	auditMetadata, err := json.Marshal(retryAuditMetadata{ID: taskID})
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	if err := writeAuditLogBestEffort(ctx, s.db, auditEntry{
		OrgID:    caller.OrgID,
		ActorID:  caller.UserID,
		Resource: "crawlTask",
		Action:   "retry",
		Metadata: auditMetadata,
	}); err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}

	refreshed, found, err := s.taskView(ctx, caller.OrgID, taskID)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, err
	}
	if !found {
		return original, nil
	}
	return refreshed, nil
}

// taskView reads one org-scoped task through the shared REST projection.
func (s *Service) taskView(ctx context.Context, orgID, taskID string) (crawlreadtelemetry.CrawlTaskView, bool, error) {
	rows, err := s.db.QueryContext(ctx,
		crawlreadtelemetry.CrawlTaskViewSelectSQL+" WHERE t.id = ? AND t.orgId = ?",
		taskID, orgID)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, false, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()
	views, err := crawlreadtelemetry.ScanCrawlTaskViews(rows)
	if err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, false, err
	}
	if len(views) == 0 {
		return crawlreadtelemetry.CrawlTaskView{}, false, nil
	}
	return views[0], true, nil
}

// normalizeActorOptions is normalizeActorOptions: an actor who is not a system
// admin loses every JS execution option, including inside multiUrlConfigs.
func (s *Service) normalizeActorOptions(ctx context.Context, caller *authhttp.Identity, options *crawloptions.OptionsInput) *crawloptions.OptionsInput {
	if options == nil {
		return nil
	}
	if !shouldRestrictJSExecution(options) {
		return options
	}
	if s.isActorAdmin(ctx, caller.OrgID, caller.UserID) {
		return options
	}
	return stripJSExecutionOptions(options)
}

// shouldRestrictJsExecution is shouldRestrictJsExecution.
func shouldRestrictJSExecution(options *crawloptions.OptionsInput) bool {
	if options == nil {
		return false
	}
	if len(options.JSCode) > 0 || boolValue(options.JSOnly) {
		return true
	}
	for _, config := range options.MultiURLConfigs {
		if config.Options == nil {
			continue
		}
		if len(config.Options.JSCode) > 0 || boolValue(config.Options.JSOnly) {
			return true
		}
	}
	return false
}

// stripJSExecutionOptions is stripJsExecutionOptions.
func stripJSExecutionOptions(options *crawloptions.OptionsInput) *crawloptions.OptionsInput {
	if options == nil {
		return nil
	}
	sanitized := *options
	sanitized.JSCode = nil
	sanitized.JSOnly = nil
	if len(options.MultiURLConfigs) > 0 {
		configs := make([]crawloptions.MultiURLConfig, len(options.MultiURLConfigs))
		copy(configs, options.MultiURLConfigs)
		for index := range configs {
			if configs[index].Options == nil {
				continue
			}
			overrides := *configs[index].Options
			overrides.JSCode = nil
			overrides.JSOnly = nil
			configs[index].Options = &overrides
		}
		sanitized.MultiURLConfigs = configs
	}
	return &sanitized
}

// isActorAdmin is C3: only a role that belongs to the caller's organization,
// is a system role and is named "admin" (case-insensitively) qualifies. A
// custom role merely named "admin" must not keep jsCode.
func (s *Service) isActorAdmin(ctx context.Context, orgID, userID string) bool {
	if s == nil || s.db == nil {
		return false
	}
	var name string
	var isSystem bool
	err := s.db.QueryRowContext(ctx,
		"SELECT r.name, r.isSystem FROM Membership m "+
			"JOIN Role r ON r.id = m.roleId AND r.orgId = m.orgId "+
			"WHERE m.userId = ? AND m.orgId = ? LIMIT 1", userID, orgID).Scan(&name, &isSystem)
	if err == nil && isSystem && strings.EqualFold(name, "admin") {
		return true
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT r.name, r.isSystem FROM Membership m "+
			"JOIN MembershipRole mr ON mr.membershipId = m.id AND mr.orgId = m.orgId "+
			"JOIN Role r ON r.id = mr.roleId AND r.orgId = m.orgId "+
			"WHERE m.userId = ? AND m.orgId = ?", userID, orgID)
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		if err := rows.Scan(&name, &isSystem); err != nil {
			return false
		}
		if isSystem && strings.EqualFold(name, "admin") {
			return true
		}
	}
	return false
}

// extractEnqueueOptions is extractEnqueueOptions.
func extractEnqueueOptions(configRaw []byte) *crawlqueue.EnqueueOptions {
	if len(configRaw) == 0 {
		return nil
	}
	var config struct {
		SourcePriority     json.RawMessage `json:"sourcePriority"`
		CrawlPriorityClass json.RawMessage `json:"crawlPriorityClass"`
	}
	if err := json.Unmarshal(configRaw, &config); err != nil {
		return nil
	}
	var sourcePriority *int
	if value, ok := jsNumberStrict(config.SourcePriority); ok {
		// Math.round rounds halves toward positive infinity.
		rounded := int(math.Floor(value + 0.5))
		sourcePriority = &rounded
	}
	var configuredClass crawlqueue.PriorityClass
	if len(config.CrawlPriorityClass) > 0 {
		var raw string
		if json.Unmarshal(config.CrawlPriorityClass, &raw) == nil && (raw == "hot" || raw == "normal") {
			configuredClass = crawlqueue.PriorityClass(raw)
		}
	}
	var inferredClass crawlqueue.PriorityClass
	if sourcePriority != nil {
		if *sourcePriority >= crawlqueue.HotThreshold {
			inferredClass = crawlqueue.PriorityClassHot
		} else {
			inferredClass = crawlqueue.PriorityClassNormal
		}
	}
	priorityClass := configuredClass
	if priorityClass == "" {
		priorityClass = inferredClass
	}
	if priorityClass == "" && sourcePriority == nil {
		return nil
	}
	return &crawlqueue.EnqueueOptions{PriorityClass: priorityClass, SourcePriority: sourcePriority}
}

func jsNumberStrict(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || strings.HasPrefix(trimmed, `"`) || trimmed == "null" ||
		trimmed == "true" || trimmed == "false" || strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// configIngestToItems reports config.ingestToItems === true.
func configIngestToItems(configRaw []byte) bool {
	if len(configRaw) == 0 {
		return false
	}
	var config struct {
		IngestToItems json.RawMessage `json:"ingestToItems"`
	}
	if err := json.Unmarshal(configRaw, &config); err != nil {
		return false
	}
	var value bool
	return json.Unmarshal(config.IngestToItems, &value) == nil && value
}

// createAuditMetadata is the create AuditLog.metadata document.
type createAuditMetadata struct {
	TargetURL     string   `json:"targetUrl"`
	Keywords      []string `json:"keywords"`
	Concurrency   int      `json:"concurrency"`
	IngestToItems bool     `json:"ingestToItems"`
}

// deleteAuditMetadata is the delete AuditLog.metadata document.
type deleteAuditMetadata struct {
	TaskID             string `json:"taskId"`
	DeletedResultCount int    `json:"deletedResultCount"`
}

// retryAuditMetadata is the retry AuditLog.metadata document.
type retryAuditMetadata struct {
	ID string `json:"id"`
}

// cleanupOutboxPayload is the MongoOutbox payload of cleanup_crawl_results.
type cleanupOutboxPayload struct {
	Type   string `json:"type"`
	TaskID string `json:"taskId"`
	OrgID  string `json:"orgId"`
}

// marshalStoredConfig renders the CrawlTask.config document. The ingest flag is
// appended after the normalized options, matching the NestJS spread.
func marshalStoredConfig(options crawloptions.Options, ingestToItems bool) ([]byte, error) {
	if !ingestToItems {
		return json.Marshal(options)
	}
	return json.Marshal(struct {
		crawloptions.Options
		IngestToItems bool `json:"ingestToItems"`
	}{Options: options, IngestToItems: true})
}

func boolValue(value *bool) bool { return value != nil && *value }

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nullableStringPtr(value *string) *string {
	// An empty displayName is stored as an empty string, exactly like Prisma
	// writing dto.displayName; only an absent value becomes NULL.
	if value == nil {
		return nil
	}
	return value
}

func nullableTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	return value
}

func nullableStringValue(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

// errDatabase marks a MySQL failure so the handler answers 503.
var errDatabase = errors.New("crawltaskwrite: mysql failure")

// traceFromContext is replaced by the handler through contextWithTrace; the
// GraphQL path leaves it empty and the producer mints a fresh id.
func traceFromContext(ctx context.Context) string {
	if value, ok := ctx.Value(traceContextKey{}).(string); ok {
		return value
	}
	return ""
}

type traceContextKey struct{}

// WithTraceID stores the request trace id for the enqueued job data.
func WithTraceID(ctx context.Context, traceID string) context.Context {
	if traceID == "" {
		return ctx
	}
	return context.WithValue(ctx, traceContextKey{}, traceID)
}

// Producer exposes the shared queue producer for the GraphQL/REST wiring.
func (s *Service) Producer() *crawlqueue.Producer {
	if s == nil {
		return nil
	}
	return s.queue
}
