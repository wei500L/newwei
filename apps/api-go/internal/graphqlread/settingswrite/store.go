package settingswrite

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// errDatabaseUnavailable reports a missing MySQL handle. The executor maps it to
// the standard internal error response.
var errDatabaseUnavailable = errors.New("settingswrite: mysql is not configured")

// SystemSetting primary keys written by the thirteen mutations. The eight
// per-organization documents append the caller's orgId to the prefix.
const (
	settingKeyEntityImpactGraphSettingsPrefix  = "entity_impact_graph_settings:"
	settingKeyKnowledgeGraphSettingsPrefix     = "knowledge_graph_settings:"
	settingKeyNewsEventSettingsPrefix          = "news_event_settings:"
	settingKeyNewsIndicatorSettingsPrefix      = "news_indicator_association_settings:"
	settingKeyNewsClassificationSettingsPrefix = "news_classification_settings:"
	settingKeyClassificationQualityPrefix      = "classification_quality_settings:"
	settingKeyNewsDedupeSettingsPrefix         = "news_dedupe_settings:"
	settingKeyNewsExtractionSettingsPrefix     = "news_extraction_settings:"
	settingKeyRateLimitLogin                   = "rate_limit_login"
	settingKeyRateLimitCrawlCreate             = "rate_limit_crawl_create"
	settingKeyRateLimitRbacWrite               = "rate_limit_rbac_write"
	settingKeyAuthCacheSettings                = "auth_profile_cache_settings"
	settingKeyCrawlClientSettings              = "crawl_client_settings"
	settingKeyAuditLogRetention                = "audit_log_retention_days"
	settingKeyNewsPromptConfig                 = "news_pipeline_prompt_config"
)

// Redis cache keys. Every writer refreshes the same key the NestJS service
// reads, so a Nest reader and a Go reader observe the same document.
const (
	cacheKeyEntityImpactGraphPrefix  = "entityImpactGraph:settings:"
	cacheKeyKnowledgeGraphPrefix     = "knowledgeGraph:settings:"
	cacheKeyNewsEventsPrefix         = "newsEvents:settings:"
	cacheKeyNewsIndicatorPrefix      = "newsIndicator:settings:"
	cacheKeyNewsClassificationPrefix = "newsClassification:settings:"
	cacheKeyClassificationQuality    = "classificationQuality:settings:"
	cacheKeyNewsDedupePrefix         = "newsDedupe:settings:"
	cacheKeyNewsExtractionPrefix     = "newsExtraction:settings:"
	cacheKeyRateLimitSettings        = "rate_limit:settings"
	cacheKeyAuthCacheSettings        = "auth_cache:settings"
	cacheKeyCrawlClientSettings      = "crawl_client:settings"
	cacheKeyAuditLogRetention        = "audit_log:retention_days"
)

// Cache TTLs. The eight per-organization settings documents use the fixed 60
// seconds of their NestJS services; the crawl client and the audit retention
// use the fixed 30 seconds their NestJS services used to keep in process.
const (
	organizationSettingsCacheTTLSeconds = 60
	crawlClientCacheTTLSeconds          = 30
	auditLogRetentionCacheTTLSeconds    = 30
	authCacheSettingsCacheTTLSeconds    = 60
	defaultRateLimitCacheTTLSeconds     = 60
)

// service holds the two backends every mutation needs: MySQL for the
// SystemSetting row and the audit trail, Redis for the shared settings cache.
type service struct {
	db    *sql.DB
	redis *redis.Client
	// rateLimitCacheTTL mirrors RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS for the
	// shared rate_limit:settings key.
	rateLimitCacheTTL int
}

// selectSetting reads one SystemSetting row value. A missing row reports
// found=false with a nil error, mirroring Prisma findUnique returning null.
func (s *service) selectSetting(ctx context.Context, key string) ([]byte, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, errDatabaseUnavailable
	}
	var value []byte
	err := s.db.QueryRowContext(
		ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key,
	).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

// upsertSetting mirrors a Prisma upsert whose update block omits description:
// the description is written on the insert branch only, while value, updatedAt
// and updatedById are refreshed on both branches.
func (s *service) upsertSetting(ctx context.Context, key string, payload []byte, description string, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errDatabaseUnavailable
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt, updatedById) "+
			"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row "+
			"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById",
		key, payload, description, now, now, updatedByID)
	return err
}

// upsertSettingForceDescription mirrors a Prisma upsert that also lists
// description in its update block: every settings service except the three
// rate-limit buckets and the auth cache refreshes it.
func (s *service) upsertSettingForceDescription(ctx context.Context, key string, payload []byte, description string, updatedByID *string) error {
	if s == nil || s.db == nil {
		return errDatabaseUnavailable
	}
	now := nowMillis()
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt, updatedById) "+
			"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row "+
			"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById, description = new_row.description",
		key, payload, description, now, now, updatedByID)
	return err
}

// upsertSettingTx runs the description-omitting upsert on a transaction handle
// so the three rate-limit buckets commit atomically.
func upsertSettingTx(ctx context.Context, tx *sql.Tx, key string, payload []byte, description string, updatedByID *string) error {
	now := nowMillis()
	_, err := tx.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt, updatedById) "+
			"VALUES (?, ?, 0, ?, ?, ?, ?) AS new_row "+
			"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt, updatedById = new_row.updatedById",
		key, payload, description, now, now, updatedByID)
	return err
}

// ---- Redis cache ----

// cacheSet writes the shared settings document with an expiry, mirroring
// CacheService.set (SET key value EX ttl). A Redis failure is logged and never
// turns an already committed settings write into an error.
func (s *service) cacheSet(ctx context.Context, key string, payload []byte, ttlSeconds int) {
	if s == nil || s.redis == nil {
		return
	}
	if ttlSeconds <= 0 {
		ttlSeconds = 1
	}
	if err := s.redis.Set(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Err(); err != nil {
		log.Printf("settingswrite: failed to refresh cache key %q: %v", key, err)
	}
}

// ---- AuditLog ----

// auditOutboxPayload is the JSON document enqueued when the direct AuditLog
// insert fails. Its field set matches writeAuditLogBestEffort in
// modules/audit/audit-log.writer.ts so the existing retry worker can replay it.
type auditOutboxPayload struct {
	OrgID     string          `json:"orgId"`
	ActorID   *string         `json:"actorId"`
	Resource  string          `json:"resource"`
	Action    string          `json:"action"`
	Metadata  json.RawMessage `json:"metadata"`
	IPAddress *string         `json:"ipAddress"`
	CreatedAt string          `json:"createdAt"`
}

// writeAuditLogBestEffort mirrors writeAuditLogBestEffort in
// modules/audit/audit-log.writer.ts: insert the AuditLog row first, fall back to
// an AuditLogOutbox entry on failure, and never turn a successfully persisted
// settings change into an HTTP error. metadata is always a named struct; the
// type parameter is only the serialization boundary, exactly like the
// organization write batch.
func writeAuditLogBestEffort[T any](db *sql.DB, ctx context.Context, orgID, actorID, resource, action string, metadata T) {
	if db == nil {
		return
	}
	metaRaw, marshalErr := json.Marshal(metadata)
	if marshalErr != nil {
		metaRaw = []byte("null")
	}
	actor := nullableActorID(actorID)
	now := nowMillis()

	if id, idErr := newRowID(); idErr == nil {
		_, err := db.ExecContext(ctx,
			"INSERT INTO AuditLog (id, orgId, actorId, resource, action, metadata, ipAddress, createdAt) "+
				"VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
			id, orgID, actor, resource, action, metaRaw, now)
		if err == nil {
			return
		}
	}

	payload, payloadErr := json.Marshal(auditOutboxPayload{
		OrgID:     orgID,
		ActorID:   actor,
		Resource:  resource,
		Action:    action,
		Metadata:  metaRaw,
		IPAddress: nil,
		CreatedAt: now.Format("2006-01-02T15:04:05.000Z"),
	})
	outboxID, outboxIDErr := newRowID()
	if payloadErr != nil || outboxIDErr != nil {
		log.Printf("settingswrite: failed to build audit outbox payload for %s: %v", action, payloadErr)
		return
	}
	if _, err := db.ExecContext(ctx,
		"INSERT INTO AuditLogOutbox (id, orgId, payload, status, attempts, availableAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
		outboxID, orgID, payload, now, now, now); err != nil {
		log.Printf("settingswrite: failed to write audit log and enqueue outbox for %s: %v", action, err)
	}
}

// ---- small helpers ----

// newRowID writes a Prisma cuid column ('c' plus 24 hex characters).
func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// nowMillis returns the current UTC time truncated to milliseconds, matching
// the DATETIME(3) columns Prisma writes.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// nullableActorID converts an actor id into the value written to the nullable
// User foreign keys: an empty id (machine tokens never reach the GraphQL entry)
// becomes SQL NULL.
func nullableActorID(actorID string) *string {
	if actorID == "" || strings.HasPrefix(actorID, "machine:") {
		return nil
	}
	return &actorID
}

// inputFailure is the class-validator / BadRequestException equivalent. Its
// message joins the constraint messages with "; ", the same way
// GlobalExceptionFilter joins the ValidationPipe array.
type inputFailure struct{ message string }

func (e *inputFailure) Error() string { return e.message }

func newInputFailure(messages []string) error {
	return &inputFailure{message: strings.Join(messages, "; ")}
}

// serviceFailure is an HttpException equivalent with an explicit status.
type serviceFailure struct {
	status  int
	message string
}

func (e *serviceFailure) Error() string { return e.message }

// badRequest builds the NestJS BadRequestException shape (HTTP 400).
func badRequest(message string) error {
	return &serviceFailure{status: http.StatusBadRequest, message: message}
}

// graphqlFailure converts a write error to the GraphQL field failure shape.
func graphqlFailure(err error) error {
	if err == nil {
		return nil
	}
	var input *inputFailure
	if errors.As(err, &input) {
		return &contract.Failure{Message: input.message, Status: http.StatusBadRequest}
	}
	var service *serviceFailure
	if errors.As(err, &service) {
		return &contract.Failure{Message: service.message, Status: service.status}
	}
	return &contract.Failure{Message: err.Error(), Status: http.StatusInternalServerError}
}

// callContext guards against a nil call context.
func callContext(ctx contract.Context) context.Context {
	if ctx.Ctx != nil {
		return ctx.Ctx
	}
	return context.Background()
}

// jsonInt renders an integer for a constraint message without a decimal part.
func jsonInt(value int) string {
	return strconv.Itoa(value)
}

// jsonFloat renders a float the way class-validator interpolates $constraint1
// (JavaScript String(number)): 0, 1, 0.01 and 0.99 keep their shortest form.
func jsonFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// fmtRangeMax and fmtRangeMin render the two class-validator range messages.
func fmtRangeMax(field string, max int) string {
	return fmt.Sprintf("%s must not be greater than %d", field, max)
}

func fmtRangeMin(field string, min int) string {
	return fmt.Sprintf("%s must not be less than %d", field, min)
}
