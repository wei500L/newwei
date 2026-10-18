package settingswrite

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// permissionSettingsManage is the only root permission the thirteen settings
// mutations require, matching the SettingsResolver @HasPermission decorator.
const permissionSettingsManage = "settings.manage"

// Options configures Register.
type Options struct {
	// RateLimitSettingsCacheTTLSeconds mirrors
	// RATE_LIMIT_SETTINGS_CACHE_TTL_SECONDS. It is the TTL of the shared
	// rate_limit:settings key; a non-positive value falls back to 60 seconds,
	// which is the NestJS EnvService default.
	RateLimitSettingsCacheTTLSeconds int
}

// Register adds the thirteen settings center mutations and their root
// permission.
//
// It registers no object type on purpose: the mutation results project the
// shared settings models, whose registration must happen exactly once. The
// caller registers them through settingscrawl.Register or
// settingscrawl.RegisterSettingsModelTypes and then calls Register here.
func Register(reg *contract.Registry, db *sql.DB, redisClient *redis.Client, options Options) {
	if reg == nil {
		panic("graphqlread: settingswrite.Register requires a registry")
	}
	svc := &service{
		db:                db,
		redis:             redisClient,
		rateLimitCacheTTL: options.RateLimitSettingsCacheTTLSeconds,
	}
	reg.RegisterMutation(contract.Root{Name: "updateRateLimitSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateRateLimitSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateAuthCacheSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateAuthCacheSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateCrawlClientSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateCrawlClientSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateAuditLogRetention", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateAuditLogRetentionResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateEntityImpactGraphSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateEntityImpactGraphSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateKnowledgeGraphSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateKnowledgeGraphSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateNewsEventSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateNewsEventSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateNewsIndicatorSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateNewsIndicatorSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateNewsClassificationSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateNewsClassificationSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateClassificationQualitySettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateClassificationQualitySettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateNewsDedupeSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateNewsDedupeSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateNewsExtractionSettings", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateNewsExtractionSettingsResolver)})
	reg.RegisterMutation(contract.Root{Name: "updateNewsPromptConfig", Permission: permissionSettingsManage, Resolve: contract.Bind(svc.updateNewsPromptConfigResolver)})
}

// RegisteredMutations lists the mutation names Register adds. The startup log
// uses it.
var RegisteredMutations = []string{
	"updateRateLimitSettings",
	"updateAuthCacheSettings",
	"updateCrawlClientSettings",
	"updateAuditLogRetention",
	"updateEntityImpactGraphSettings",
	"updateKnowledgeGraphSettings",
	"updateNewsEventSettings",
	"updateNewsIndicatorSettings",
	"updateNewsClassificationSettings",
	"updateClassificationQualitySettings",
	"updateNewsDedupeSettings",
	"updateNewsExtractionSettings",
	"updateNewsPromptConfig",
}

// assertAdmin re-derives the SettingsResolver.assertAdmin gate.
func (s *service) assertAdmin(ctx context.Context, identity contract.Identity) error {
	if s == nil || s.db == nil {
		return errDatabaseUnavailable
	}
	return settingscrawl.AssertSystemAdmin(ctx, s.db, identity)
}

// rateLimitCacheTTLOrDefault resolves the shared rate_limit:settings TTL.
func (s *service) rateLimitCacheTTLOrDefault() int {
	if s != nil && s.rateLimitCacheTTL > 0 {
		return s.rateLimitCacheTTL
	}
	return defaultRateLimitCacheTTLSeconds
}

// ---- resolver adapters ----

func (s *service) updateRateLimitSettingsResolver(ctx contract.Context) (settingscrawl.RateLimitSettingsModel, error) {
	input, err := parseUpdateRateLimitSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.RateLimitSettingsModel
		if model, err = s.updateRateLimitSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.RateLimitSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateAuthCacheSettingsResolver(ctx contract.Context) (settingscrawl.AuthCacheSettingsModel, error) {
	input, err := parseUpdateAuthCacheSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.AuthCacheSettingsModel
		if model, err = s.updateAuthCacheSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.AuthCacheSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateCrawlClientSettingsResolver(ctx contract.Context) (settingscrawl.CrawlClientSettingsModel, error) {
	input, err := parseUpdateCrawlClientSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.CrawlClientSettingsModel
		if model, err = s.updateCrawlClientSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.CrawlClientSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateAuditLogRetentionResolver(ctx contract.Context) (settingscrawl.AuditLogRetentionModel, error) {
	input, err := parseUpdateAuditLogRetentionInput(ctx.Args)
	if err == nil {
		var model settingscrawl.AuditLogRetentionModel
		if model, err = s.updateAuditLogRetention(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.AuditLogRetentionModel{}, graphqlFailure(err)
}

// normalizeRateLimitBucket feeds one submitted bucket through the shared
// normalizer, so the persisted and cached values are byte-identical to what a
// subsequent NestJS or Go read returns.
func normalizeRateLimitBucket(input rateLimitBucketInput, fallback settingscrawl.RateLimitBucketModel) (settingscrawl.RateLimitBucketModel, error) {
	candidate, err := json.Marshal(rateLimitBucketCandidate{Limit: input.Limit, WindowSeconds: input.WindowSeconds})
	if err != nil {
		return fallback, err
	}
	return settingscrawl.NormalizeRateLimitBucket(candidate, fallback), nil
}

// updateRateLimitSettings mirrors RateLimitConfigService.updateRateLimitSettings:
// normalize the three buckets, upsert them in one transaction, write the audit
// row and refresh the shared cache.
func (s *service) updateRateLimitSettings(ctx context.Context, identity contract.Identity, input updateRateLimitSettingsInput) (settingscrawl.RateLimitSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.RateLimitSettingsModel{}, err
	}
	if s.db == nil {
		return settingscrawl.RateLimitSettingsModel{}, errDatabaseUnavailable
	}
	defaults := settingscrawl.DefaultRateLimitSettings()
	login, err := normalizeRateLimitBucket(input.Login, defaults.Login)
	if err != nil {
		return settingscrawl.RateLimitSettingsModel{}, err
	}
	crawlCreate, err := normalizeRateLimitBucket(input.CrawlCreate, defaults.CrawlCreate)
	if err != nil {
		return settingscrawl.RateLimitSettingsModel{}, err
	}
	rbacWrite, err := normalizeRateLimitBucket(input.RbacWrite, defaults.RbacWrite)
	if err != nil {
		return settingscrawl.RateLimitSettingsModel{}, err
	}
	normalized := settingscrawl.RateLimitSettingsModel{Login: login, CrawlCreate: crawlCreate, RbacWrite: rbacWrite}

	updatedByID := nullableActorID(identity.UserID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return settingscrawl.RateLimitSettingsModel{}, err
	}
	buckets := []struct {
		key         string
		description string
		value       rateLimitBucketDocument
	}{
		{settingKeyRateLimitLogin, "login rate limit", rateLimitBucketDocumentOf(normalized.Login)},
		{settingKeyRateLimitCrawlCreate, "crawlCreate rate limit", rateLimitBucketDocumentOf(normalized.CrawlCreate)},
		{settingKeyRateLimitRbacWrite, "rbacWrite rate limit", rateLimitBucketDocumentOf(normalized.RbacWrite)},
	}
	for _, bucket := range buckets {
		encoded, encodeErr := json.Marshal(bucket.value)
		if encodeErr != nil {
			_ = tx.Rollback()
			return settingscrawl.RateLimitSettingsModel{}, encodeErr
		}
		if execErr := upsertSettingTx(ctx, tx, bucket.key, encoded, bucket.description, updatedByID); execErr != nil {
			_ = tx.Rollback()
			return settingscrawl.RateLimitSettingsModel{}, execErr
		}
	}
	if err := tx.Commit(); err != nil {
		return settingscrawl.RateLimitSettingsModel{}, err
	}

	payload := mustJSON(newRateLimitSettingsDocument(normalized))
	s.auditSettingsChange(ctx, identity, "rate_limit_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyRateLimitSettings, payload, s.rateLimitCacheTTLOrDefault())
	return normalized, nil
}

// updateAuthCacheSettings mirrors AuthCacheSettingsService.updateSettings.
func (s *service) updateAuthCacheSettings(ctx context.Context, identity contract.Identity, input updateAuthCacheSettingsInput) (settingscrawl.AuthCacheSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.AuthCacheSettingsModel{}, err
	}
	defaults := settingscrawl.DefaultAuthCacheSettings()
	candidate, err := json.Marshal(authCacheCandidate{
		ProfileTTLSeconds: input.ProfileTTLSeconds,
		LockTTLMs:         input.LockTTLMs,
		MaxWaitMs:         input.MaxWaitMs,
		RetryDelayMs:      input.RetryDelayMs,
	})
	if err != nil {
		return settingscrawl.AuthCacheSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeAuthCacheSettings(candidate, defaults)
	payload := mustJSON(newAuthCacheSettingsDocument(normalized))
	if err := s.upsertSetting(ctx, settingKeyAuthCacheSettings, payload, "Auth profile cache settings", nullableActorID(identity.UserID)); err != nil {
		return settingscrawl.AuthCacheSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "auth_cache_settings_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyAuthCacheSettings, payload, authCacheSettingsCacheTTLSeconds)
	return normalized, nil
}

// loadCrawlClient returns the stored crawl client setting, or the environment
// defaults when the row is absent.
func (s *service) loadCrawlClient(ctx context.Context) (settingscrawl.CrawlClientNormalized, error) {
	defaults := settingscrawl.DefaultCrawlClientNormalized()
	raw, found, err := s.selectSetting(ctx, settingKeyCrawlClientSettings)
	if err != nil {
		return defaults, err
	}
	if !found {
		return defaults, nil
	}
	return settingscrawl.NormalizeCrawlClientSettingsDocument(raw, defaults), nil
}

// updateCrawlClientSettings mirrors CrawlSettingsService.updateSettings: the
// service (not the resolver) merges the submitted fields over the stored
// setting, so an omitted optional field keeps its current value.
func (s *service) updateCrawlClientSettings(ctx context.Context, identity contract.Identity, input updateCrawlClientSettingsInput) (settingscrawl.CrawlClientSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.CrawlClientSettingsModel{}, err
	}
	current, err := s.loadCrawlClient(ctx)
	if err != nil {
		return settingscrawl.CrawlClientSettingsModel{}, err
	}
	candidate, err := json.Marshal(crawlClientCandidate{
		HealthCheckTtlMs:                         input.HealthCheckTTLMs,
		MaxRetries:                               input.MaxRetries,
		RetryBackoffMs:                           input.RetryBackoffMs,
		QueueOverloadCooldownMs:                  input.QueueOverloadCooldownMs,
		RequestTimeoutMs:                         input.RequestTimeoutMs,
		RequestTimeoutHotMs:                      input.RequestTimeoutHotMs,
		RequestTimeoutNormalMs:                   input.RequestTimeoutNormalMs,
		ConditionalRequestEnabled:                input.ConditionalRequestEnabled,
		ConditionalRequestTimeoutMs:              input.ConditionalRequestTimeoutMs,
		ConditionalRequestMaxRetries:             input.ConditionalRequestMaxRetries,
		DetailPublishSignalHeadFetchTimeoutMs:    input.DetailPublishSignalHeadFetchTimeoutMs,
		DetailPublishSignalHeadFetchConcurrency:  input.DetailPublishSignalHeadFetchConcurrency,
		DetailPublishSignalHeadFetchMaxReadBytes: input.DetailPublishSignalHeadFetchMaxReadBytes,
		AdaptiveConcurrencyEnabled:               input.AdaptiveConcurrencyEnabled,
		AdaptiveWindowMinutes:                    input.AdaptiveWindowMinutes,
		AdaptiveCooldownMinutes:                  input.AdaptiveCooldownMinutes,
		AdaptiveLatencyThresholdRatio:            input.AdaptiveLatencyThresholdRatio,
		AdaptiveErrorRateThreshold:               input.AdaptiveErrorRateThreshold,
		AdaptiveMemoryHeadroomThreshold:          input.AdaptiveMemoryHeadroomThreshold,
	})
	if err != nil {
		return settingscrawl.CrawlClientSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeCrawlClientSettingsDocument(candidate, current)
	payload := mustJSON(newCrawlClientDocument(normalized))
	if err := s.upsertSettingForceDescription(ctx, settingKeyCrawlClientSettings, payload, "Crawl client runtime settings", nullableActorID(identity.UserID)); err != nil {
		return settingscrawl.CrawlClientSettingsModel{}, err
	}
	if metadata, ok := buildCrawlClientAuditMetadata(current, normalized, input); ok {
		s.auditSettingsChange(ctx, identity, "crawl_client_settings_update", mustJSON(metadata))
	}
	s.cacheSettingsDocument(ctx, cacheKeyCrawlClientSettings, payload, crawlClientCacheTTLSeconds)
	return normalized.Settings, nil
}

// updateAuditLogRetention mirrors AuditLogSettingsService.updateRetentionDays:
// the row keeps a bare JSON number, the audit metadata keeps the object form and
// the shared cache keeps the bare number too.
func (s *service) updateAuditLogRetention(ctx context.Context, identity contract.Identity, input updateAuditLogRetentionInput) (settingscrawl.AuditLogRetentionModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.AuditLogRetentionModel{}, err
	}
	normalized := settingscrawl.NormalizeAuditLogRetentionDays(float64(input.RetentionDays))
	encoded := json.RawMessage(strconv.Itoa(normalized))
	if err := s.upsertSetting(ctx, settingKeyAuditLogRetention, encoded, "Audit log retention in days", nullableActorID(identity.UserID)); err != nil {
		return settingscrawl.AuditLogRetentionModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "audit_log_retention_update", mustJSON(auditLogRetentionMetadata{RetentionDays: normalized}))
	s.cacheSettingsDocument(ctx, cacheKeyAuditLogRetention, encoded, auditLogRetentionCacheTTLSeconds)
	return settingscrawl.AuditLogRetentionModel{RetentionDays: normalized}, nil
}

// ---- audit helpers ----

// auditSettingsChange writes the best-effort system_settings audit row shared by
// every settings mutation except the prompt config (which has its own resource).
func (s *service) auditSettingsChange(ctx context.Context, identity contract.Identity, action string, metadata json.RawMessage) {
	writeAuditLogBestEffort(s.db, ctx, identity.OrgID, identity.UserID, "system_settings", action, metadata)
}

// auditLogRetentionMetadata is the AuditLog.metadata of
// updateAuditLogRetention.
type auditLogRetentionMetadata struct {
	RetentionDays int `json:"retentionDays"`
}

// crawlClientAuditSnapshot is the before/after snapshot of the audit metadata:
// the nineteen fields CRAWL_CLIENT_SETTINGS_AUDIT_FIELDS lists, in order.
type crawlClientAuditSnapshot struct {
	HealthCheckTtlMs                         int     `json:"healthCheckTtlMs"`
	RequestTimeoutHotMs                      int     `json:"requestTimeoutHotMs"`
	RequestTimeoutNormalMs                   int     `json:"requestTimeoutNormalMs"`
	ConditionalRequestEnabled                bool    `json:"conditionalRequestEnabled"`
	ConditionalRequestTimeoutMs              int     `json:"conditionalRequestTimeoutMs"`
	ConditionalRequestMaxRetries             int     `json:"conditionalRequestMaxRetries"`
	DetailPublishSignalHeadFetchTimeoutMs    int     `json:"detailPublishSignalHeadFetchTimeoutMs"`
	DetailPublishSignalHeadFetchConcurrency  int     `json:"detailPublishSignalHeadFetchConcurrency"`
	DetailPublishSignalHeadFetchMaxReadBytes int     `json:"detailPublishSignalHeadFetchMaxReadBytes"`
	MaxRetries                               int     `json:"maxRetries"`
	RetryBackoffMs                           int     `json:"retryBackoffMs"`
	QueueOverloadCooldownMs                  int     `json:"queueOverloadCooldownMs"`
	AdaptiveConcurrencyEnabled               bool    `json:"adaptiveConcurrencyEnabled"`
	AdaptiveWindowMinutes                    int     `json:"adaptiveWindowMinutes"`
	AdaptiveCooldownMinutes                  int     `json:"adaptiveCooldownMinutes"`
	AdaptiveLatencyThresholdRatio            float64 `json:"adaptiveLatencyThresholdRatio"`
	AdaptiveErrorRateThreshold               float64 `json:"adaptiveErrorRateThreshold"`
	AdaptiveMemoryHeadroomThreshold          float64 `json:"adaptiveMemoryHeadroomThreshold"`
	MaxConcurrency                           int     `json:"maxConcurrency"`
}

// crawlClientAuditMetadata is the AuditLog.metadata of
// updateCrawlClientSettings.
type crawlClientAuditMetadata struct {
	SettingsKey   string                   `json:"settingsKey"`
	ChangedFields []string                 `json:"changedFields"`
	ChangedCount  int                      `json:"changedCount"`
	InputFields   []string                 `json:"inputFields"`
	Before        crawlClientAuditSnapshot `json:"before"`
	After         crawlClientAuditSnapshot `json:"after"`
}

func crawlClientAuditSnapshotOf(settings settingscrawl.CrawlClientSettingsModel, maxConcurrency int) crawlClientAuditSnapshot {
	return crawlClientAuditSnapshot{
		HealthCheckTtlMs:                         settings.HealthCheckTTLMs,
		RequestTimeoutHotMs:                      settings.RequestTimeoutHotMs,
		RequestTimeoutNormalMs:                   settings.RequestTimeoutNormalMs,
		ConditionalRequestEnabled:                settings.ConditionalRequestEnabled,
		ConditionalRequestTimeoutMs:              settings.ConditionalRequestTimeoutMs,
		ConditionalRequestMaxRetries:             settings.ConditionalRequestMaxRetries,
		DetailPublishSignalHeadFetchTimeoutMs:    settings.DetailPublishSignalHeadFetchTimeoutMs,
		DetailPublishSignalHeadFetchConcurrency:  settings.DetailPublishSignalHeadFetchConcurrency,
		DetailPublishSignalHeadFetchMaxReadBytes: settings.DetailPublishSignalHeadFetchMaxReadBytes,
		MaxRetries:                               settings.MaxRetries,
		RetryBackoffMs:                           settings.RetryBackoffMs,
		QueueOverloadCooldownMs:                  settings.QueueOverloadCooldownMs,
		AdaptiveConcurrencyEnabled:               settings.AdaptiveConcurrencyEnabled,
		AdaptiveWindowMinutes:                    settings.AdaptiveWindowMinutes,
		AdaptiveCooldownMinutes:                  settings.AdaptiveCooldownMinutes,
		AdaptiveLatencyThresholdRatio:            settings.AdaptiveLatencyThresholdRatio,
		AdaptiveErrorRateThreshold:               settings.AdaptiveErrorRateThreshold,
		AdaptiveMemoryHeadroomThreshold:          settings.AdaptiveMemoryHeadroomThreshold,
		MaxConcurrency:                           maxConcurrency,
	}
}

// buildCrawlClientAuditMetadata mirrors CrawlSettingsService.buildAuditMetadata:
// no changed field means no audit row at all.
func buildCrawlClientAuditMetadata(current, next settingscrawl.CrawlClientNormalized, input updateCrawlClientSettingsInput) (crawlClientAuditMetadata, bool) {
	before := crawlClientAuditSnapshotOf(current.Settings, current.MaxConcurrency)
	after := crawlClientAuditSnapshotOf(next.Settings, next.MaxConcurrency)
	changed := changedCrawlClientFields(before, after)
	if len(changed) == 0 {
		return crawlClientAuditMetadata{}, false
	}
	return crawlClientAuditMetadata{
		SettingsKey:   settingKeyCrawlClientSettings,
		ChangedFields: changed,
		ChangedCount:  len(changed),
		InputFields:   crawlClientInputFields(input),
		Before:        before,
		After:         after,
	}, true
}

// crawlClientAuditFields is CRAWL_CLIENT_SETTINGS_AUDIT_FIELDS: the compared
// field names in declaration order. requestTimeoutMs is the legacy alias of
// requestTimeoutNormalMs and is deliberately absent.
var crawlClientAuditFields = []string{
	"healthCheckTtlMs",
	"requestTimeoutHotMs",
	"requestTimeoutNormalMs",
	"conditionalRequestEnabled",
	"conditionalRequestTimeoutMs",
	"conditionalRequestMaxRetries",
	"detailPublishSignalHeadFetchTimeoutMs",
	"detailPublishSignalHeadFetchConcurrency",
	"detailPublishSignalHeadFetchMaxReadBytes",
	"maxRetries",
	"retryBackoffMs",
	"queueOverloadCooldownMs",
	"adaptiveConcurrencyEnabled",
	"adaptiveWindowMinutes",
	"adaptiveCooldownMinutes",
	"adaptiveLatencyThresholdRatio",
	"adaptiveErrorRateThreshold",
	"adaptiveMemoryHeadroomThreshold",
	"maxConcurrency",
}

// changedCrawlClientFields compares the two snapshots field by field in
// CRAWL_CLIENT_SETTINGS_AUDIT_FIELDS order. The comparisons are written out so
// no untyped value ever carries business data.
func changedCrawlClientFields(before, after crawlClientAuditSnapshot) []string {
	changed := make([]string, 0, len(crawlClientAuditFields))
	if before.HealthCheckTtlMs != after.HealthCheckTtlMs {
		changed = append(changed, "healthCheckTtlMs")
	}
	if before.RequestTimeoutHotMs != after.RequestTimeoutHotMs {
		changed = append(changed, "requestTimeoutHotMs")
	}
	if before.RequestTimeoutNormalMs != after.RequestTimeoutNormalMs {
		changed = append(changed, "requestTimeoutNormalMs")
	}
	if before.ConditionalRequestEnabled != after.ConditionalRequestEnabled {
		changed = append(changed, "conditionalRequestEnabled")
	}
	if before.ConditionalRequestTimeoutMs != after.ConditionalRequestTimeoutMs {
		changed = append(changed, "conditionalRequestTimeoutMs")
	}
	if before.ConditionalRequestMaxRetries != after.ConditionalRequestMaxRetries {
		changed = append(changed, "conditionalRequestMaxRetries")
	}
	if before.DetailPublishSignalHeadFetchTimeoutMs != after.DetailPublishSignalHeadFetchTimeoutMs {
		changed = append(changed, "detailPublishSignalHeadFetchTimeoutMs")
	}
	if before.DetailPublishSignalHeadFetchConcurrency != after.DetailPublishSignalHeadFetchConcurrency {
		changed = append(changed, "detailPublishSignalHeadFetchConcurrency")
	}
	if before.DetailPublishSignalHeadFetchMaxReadBytes != after.DetailPublishSignalHeadFetchMaxReadBytes {
		changed = append(changed, "detailPublishSignalHeadFetchMaxReadBytes")
	}
	if before.MaxRetries != after.MaxRetries {
		changed = append(changed, "maxRetries")
	}
	if before.RetryBackoffMs != after.RetryBackoffMs {
		changed = append(changed, "retryBackoffMs")
	}
	if before.QueueOverloadCooldownMs != after.QueueOverloadCooldownMs {
		changed = append(changed, "queueOverloadCooldownMs")
	}
	if before.AdaptiveConcurrencyEnabled != after.AdaptiveConcurrencyEnabled {
		changed = append(changed, "adaptiveConcurrencyEnabled")
	}
	if before.AdaptiveWindowMinutes != after.AdaptiveWindowMinutes {
		changed = append(changed, "adaptiveWindowMinutes")
	}
	if before.AdaptiveCooldownMinutes != after.AdaptiveCooldownMinutes {
		changed = append(changed, "adaptiveCooldownMinutes")
	}
	if before.AdaptiveLatencyThresholdRatio != after.AdaptiveLatencyThresholdRatio {
		changed = append(changed, "adaptiveLatencyThresholdRatio")
	}
	if before.AdaptiveErrorRateThreshold != after.AdaptiveErrorRateThreshold {
		changed = append(changed, "adaptiveErrorRateThreshold")
	}
	if before.AdaptiveMemoryHeadroomThreshold != after.AdaptiveMemoryHeadroomThreshold {
		changed = append(changed, "adaptiveMemoryHeadroomThreshold")
	}
	if before.MaxConcurrency != after.MaxConcurrency {
		changed = append(changed, "maxConcurrency")
	}
	return changed
}

// crawlClientInputFields lists the properties the caller actually supplied,
// in the DTO declaration order (the executor's argument map is unordered).
func crawlClientInputFields(input updateCrawlClientSettingsInput) []string {
	fields := make([]string, 0, len(crawlClientAuditFields))
	appendField := func(name string, present bool) {
		if present {
			fields = append(fields, name)
		}
	}
	appendField("healthCheckTtlMs", true)
	appendField("requestTimeoutMs", input.RequestTimeoutMs != nil)
	appendField("requestTimeoutHotMs", input.RequestTimeoutHotMs != nil)
	appendField("requestTimeoutNormalMs", input.RequestTimeoutNormalMs != nil)
	appendField("conditionalRequestEnabled", input.ConditionalRequestEnabled != nil)
	appendField("conditionalRequestTimeoutMs", input.ConditionalRequestTimeoutMs != nil)
	appendField("conditionalRequestMaxRetries", input.ConditionalRequestMaxRetries != nil)
	appendField("detailPublishSignalHeadFetchTimeoutMs", input.DetailPublishSignalHeadFetchTimeoutMs != nil)
	appendField("detailPublishSignalHeadFetchConcurrency", input.DetailPublishSignalHeadFetchConcurrency != nil)
	appendField("detailPublishSignalHeadFetchMaxReadBytes", input.DetailPublishSignalHeadFetchMaxReadBytes != nil)
	appendField("maxRetries", true)
	appendField("retryBackoffMs", true)
	appendField("queueOverloadCooldownMs", true)
	appendField("adaptiveConcurrencyEnabled", input.AdaptiveConcurrencyEnabled != nil)
	appendField("adaptiveWindowMinutes", input.AdaptiveWindowMinutes != nil)
	appendField("adaptiveCooldownMinutes", input.AdaptiveCooldownMinutes != nil)
	appendField("adaptiveLatencyThresholdRatio", input.AdaptiveLatencyThresholdRatio != nil)
	appendField("adaptiveErrorRateThreshold", input.AdaptiveErrorRateThreshold != nil)
	appendField("adaptiveMemoryHeadroomThreshold", input.AdaptiveMemoryHeadroomThreshold != nil)
	return fields
}

// cacheSettingsDocument marshals a named document and refreshes one shared
// cache key. A marshal failure is logged by cacheSet's caller path: the
// document types are closed structs, so it cannot happen in practice.
func (s *service) cacheSettingsDocument(ctx context.Context, key string, payload json.RawMessage, ttlSeconds int) {
	s.cacheSet(ctx, key, payload, ttlSeconds)
}

// mustJSON marshals a named document for the write, audit and cache paths. The
// document types are closed structs, so the fallback is unreachable in practice.
func mustJSON[T any](value T) json.RawMessage {
	payload, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return payload
}
