package platformgovernance

// SettingsSource reports where a settings payload came from. The assistant
// quota and assistant safety services use "env"|"db"; the task-log and
// llm-request-log services use "default"|"db" because their fallback is a
// compiled-in constant rather than an environment value. It is one named string
// type with a closed value set so callers cannot pass arbitrary text.
type SettingsSource string

const (
	// SettingsSourceDefault is returned when no SystemSetting row exists and the
	// fallback is a compiled-in default (task logs, llm request logs).
	SettingsSourceDefault SettingsSource = "default"
	// SettingsSourceEnv is returned when no SystemSetting row exists and the
	// fallback is an environment-derived value (assistant quota, safety).
	SettingsSourceEnv SettingsSource = "env"
	// SettingsSourceDB is returned when a SystemSetting row exists and was used.
	SettingsSourceDB SettingsSource = "db"
)

// MfaPolicy is the platform-wide MFA policy stored in the system_security row.
// Any other stored value resolves to MfaPolicyOff, exactly like
// SystemSecuritySettingsService.asMfaPolicy.
type MfaPolicy string

const (
	// MfaPolicyOff disables the platform-wide MFA challenge.
	MfaPolicyOff MfaPolicy = "off"
	// MfaPolicyAdminsOnly requires MFA for platform administrators.
	MfaPolicyAdminsOnly MfaPolicy = "admins_only"
	// MfaPolicyAllUsers requires MFA for every user.
	MfaPolicyAllUsers MfaPolicy = "all_users"
)

// RunStatus is the AssistantRun.status value set declared by the Mongoose
// schema (packages/mongo/src/models/assistant-run.ts).
type RunStatus string

const (
	// RunStatusPending is a run that has been queued but not started.
	RunStatusPending RunStatus = "pending"
	// RunStatusRunning is a run currently executing.
	RunStatusRunning RunStatus = "running"
	// RunStatusCompleted is a successfully finished run.
	RunStatusCompleted RunStatus = "completed"
	// RunStatusFailed is a run that ended in an error.
	RunStatusFailed RunStatus = "failed"
)

// TtlReconcileStatus reports the outcome of one managed TTL index
// reconciliation, mirroring the TtlReconcileStatus union in both NestJS
// services.
type TtlReconcileStatus string

const (
	// TtlReconcileUnchanged means the desired managed TTL index already exists.
	TtlReconcileUnchanged TtlReconcileStatus = "unchanged"
	// TtlReconcileUpdated means the reconciliation created or replaced indexes.
	TtlReconcileUpdated TtlReconcileStatus = "updated"
)

// SystemSetting primary keys. Each domain owns exactly one global row; there is
// no org dimension on SystemSetting.
const (
	settingKeySecurity        = "system_security"
	settingKeyAssistantQuota  = "assistant_quota"
	settingKeyAssistantSafety = "assistant_safety"
	settingKeyTaskLog         = "task_log_settings"
	settingKeyLlmRequestLog   = "llm_request_log_settings"
)

// SystemSetting.description values, copied verbatim from the NestJS services.
const (
	descriptionSecurity        = "System security settings (secret encryption toggle)."
	descriptionAssistantQuota  = "AI Assistant per-organization submit rate and monthly token budget."
	descriptionAssistantSafety = "AI Assistant content safety (LiteLLM guardrails) configuration."
	descriptionTaskLog         = "Task log retention settings."
	descriptionLlmRequestLog   = "LLM request log retention and metadata whitelist settings."
)

// Redis keys and TTLs. The NestJS CacheService writes JSON with no key prefix
// and an EX expiry, so the Go side must use the same keys and TTLs.
const (
	cacheKeySecurity        = "system_security:settings"
	cacheKeyAssistantQuota  = "assistant_quota:settings"
	cacheKeyAssistantSafety = "assistant_safety:settings"
	// authSecurityCacheKey is AuthSecurityService's own MFA cache. A security
	// write must invalidate it as well, otherwise the platform MFA policy stays
	// stale for up to 60 seconds.
	authSecurityCacheKey = "auth:system-security"

	cacheTTLSecondsSecurity  = 60
	cacheTTLSecondsAssistant = 30
)

// Mongo collections and managed TTL index names.
const (
	collectionAssistantRuns  = "assistantruns"
	collectionLlmRequestLogs = "llmrequestlogs"
	collectionTaskLogs       = "tasklogs"

	taskLogTTLIndexName       = "task_log_created_at_ttl"
	llmRequestLogTTLIndexName = "llm_request_log_created_at_ttl"

	secondsPerDay           = 24 * 60 * 60
	ttlReconcileMaxAttempts = 3
	ttlReconcileBaseDelayMs = 150
)

// Retention bounds. The task-log and llm-request-log Mongoose schemas declare
// the same 1..3650 window, with 14 and 30 day defaults respectively.
const (
	minTaskLogRetentionDays     = 1
	maxTaskLogRetentionDays     = 3650
	defaultTaskLogRetentionDays = 14

	minLlmRequestLogRetentionDays     = 1
	maxLlmRequestLogRetentionDays     = 3650
	defaultLlmRequestLogRetentionDays = 30
)

// Assistant feature prefix used by the quota usage aggregation, plus the
// UNKNOWN_ORG_ID bucket the NestJS normalizer falls back to.
const (
	assistantFeaturePrefix = "assistant"
	unknownOrgID           = "_unknown_"
)

// assistantSafetyGuardrailPre and assistantSafetyGuardrailPost are the two
// LiteLLM guardrail names the safety settings derive.
const (
	assistantSafetyGuardrailPre  = "openai-moderation-pre"
	assistantSafetyGuardrailPost = "openai-moderation-post"
)

// MySQL session lock protocol for the llm-request-log settings writer.
// CONC-01: partial writes merge against a freshly read DB row under this lock so
// they can never roll back a field another writer just changed.
const (
	llmLogSettingsLockName        = "sys:llm_request_log_settings"
	llmLogSettingsLockWaitSeconds = 10
	// llmLogSettingsLockConflictMessage is byte-identical to the NestJS
	// ConflictException message.
	llmLogSettingsLockConflictMessage = "LLM request log settings are being updated by another request; retry later"
)
