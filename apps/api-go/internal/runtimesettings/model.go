// Package runtimesettings implements the Go takeover of seven platform runtime
// and governance settings domains (eighteen HTTP routes under
// /api/system-settings). It is wired only when API_GO_RUNTIME_SETTINGS_MODE=go;
// the default (legacy) keeps every request on the NestJS proxy.
//
// The package deliberately mirrors the NestJS contract one-for-one:
//   - authentication is the shared authhttp chain (JWT verification, Redis
//     blacklist, MySQL membership re-derivation) plus the mtk_ machine-token
//     path, which reuses the same SHA-256 lookup as the other Go domains;
//   - reads accept the same stored JSON shapes as Prisma, including the legacy
//     "raw number" and "raw object" forms, and reject genuinely invalid rows
//     with the same 409 payloads;
//   - writes upsert the same SystemSetting primary keys, reuse the same
//     SystemSetting.value object shape (key order included) and write the same
//     best-effort AuditLog rows through the AuditLogOutbox fallback.
//
// Every request and response model is a named struct with explicit json tags.
// JSON values that are inherently schema-less (a stored SystemSetting.value, a
// Redis hash) are handled as json.RawMessage bytes and decoded into named
// structs immediately; the package never uses any / interface{} / map[string]any.
package runtimesettings

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
)

// SettingSource reports where a settings payload came from. It is a named
// string type with a closed value set so callers cannot pass arbitrary text.
type SettingSource string

const (
	// SourceDefault is returned when no SystemSetting row exists yet.
	SourceDefault SettingSource = "default"
	// SourceDB is returned when a SystemSetting row exists and was used.
	SourceDB SettingSource = "db"
)

// SystemSetting primary keys. Each domain owns exactly one global row; there is
// no org dimension on SystemSetting.
const (
	settingKeyRateLimitLogin         = "rate_limit_login"
	settingKeyRateLimitCrawlCreate   = "rate_limit_crawl_create"
	settingKeyRateLimitRbacWrite     = "rate_limit_rbac_write"
	settingKeyAuthProfileCache       = "auth_profile_cache_settings"
	settingKeyAuditLogRetention      = "audit_log_retention_days"
	settingKeyMultiTenantScheduler   = "multi_tenant_scheduler_runtime_settings"
	settingKeyNewsSourceScheduler    = "news_source_scheduler_settings"
	settingKeyNewsNowPersonalization = "newsnow_personalization_settings"
)

// SystemSetting.description values. audit-log, auth-cache and the three
// rate-limit buckets write the description only on the INSERT branch (matching
// the Prisma create block); the multi-tenant scheduler, news-source scheduler
// and NewsNow personalization services also overwrite it on UPDATE, so those
// three call the description-updating upsert variant.
const (
	descriptionRateLimitLogin         = "login rate limit"
	descriptionRateLimitCrawlCreate   = "crawlCreate rate limit"
	descriptionRateLimitRbacWrite     = "rbacWrite rate limit"
	descriptionAuthProfileCache       = "Auth profile cache settings"
	descriptionAuditLogRetention      = "Audit log retention in days"
	descriptionMultiTenantScheduler   = "Multi-tenant scheduler runtime settings (org fan-out concurrency)."
	descriptionNewsSourceScheduler    = "News source scheduler runtime settings (seed freshness + discovery TTL defaults)"
	descriptionNewsNowPersonalization = "NewsNow personalized sorting runtime policy (cache + throttle + ranking weights)."
)

// Redis cache keys. The rate limit policy family is keyed per feature; the
// other domains use one fixed key each.
const (
	rateLimitPolicyCachePrefix = "rate_limit_policy:"
	rateLimitSettingsCacheKey  = "rate_limit:settings"
	authCacheSettingsCacheKey  = "auth_cache:settings"

	// rateLimitPolicyCacheTTLSeconds and authCacheSettingsCacheTTLSeconds are
	// hard-coded in NestJS; only the rate-limit settings bucket TTL is
	// environment configurable.
	rateLimitPolicyCacheTTLSeconds   = 60
	authCacheSettingsCacheTTLSeconds = 60
)

// newsNowMetricsKeyPrefix is the per-day Redis hash used by the aggregator.
const newsNowMetricsKeyPrefix = "newsnow:personalization:metrics:v1:"

// machineActorPrefix is the user-id prefix produced by AuthenticateMachine.
// SystemSetting.updatedById and AuditLog.actorId are foreign keys into User(id),
// so a machine identity must be written as NULL instead of "machine:<id>".
const machineActorPrefix = "machine:"

// actorIsMachine reports whether the actor id belongs to a machine token
// rather than a human user.
func actorIsMachine(actorID string) bool {
	return actorID == "" || strings.HasPrefix(actorID, machineActorPrefix)
}

// nullableActorID converts an actor id into the value that may be written to
// the nullable User foreign keys. Machine tokens and empty ids must become SQL
// NULL: writing "machine:<tokenId>" would violate the MySQL foreign key (1452)
// and surface as an HTTP 500.
func nullableActorID(actorID string) *string {
	if actorIsMachine(actorID) {
		return nil
	}
	return &actorID
}

// nestTime serializes a timestamp exactly like JavaScript's
// Date.prototype.toISOString: UTC, millisecond precision, trailing Z. Express
// res.json produces this shape, so byte-level parity depends on it.
type nestTime time.Time

// MarshalJSON renders the timestamp in JavaScript ISO-8601 form.
func (t nestTime) MarshalJSON() ([]byte, error) {
	return []byte(`"` + time.Time(t).UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

// jsNumberFromJSON mirrors JavaScript's Number(value) for a decoded JSON value.
//
// The NestJS read paths coerce stored values with Number(), which accepts
// numeric strings ("4", " 4 ", "0x4"), booleans (true -> 1, false -> 0), null
// (-> 0) and single-element arrays ([4] -> 4). The second return value is false
// only when raw is empty, which means "the key is absent" rather than "the
// value is NaN" (absent fields fall back to their defaults; present but
// unparseable fields invalidate the record).
func jsNumberFromJSON(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return math.NaN(), true
		}
		return jsStringToNumber(text), true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		return 0, true
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return math.NaN(), true
		}
		switch len(items) {
		case 0:
			return 0, true
		case 1:
			return jsNumberFromJSON(items[0])
		default:
			// JS Array.prototype.toString joins with "," which Number() cannot
			// parse, so a multi-element array is NaN.
			return math.NaN(), true
		}
	case '{':
		return math.NaN(), true
	default:
		value, err := strconv.ParseFloat(string(trimmed), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				// JSON.parse("1e999") and Number("1e999") are Infinity, not an
				// error; callers reject Infinity because it is not an integer.
				return value, true
			}
			return math.NaN(), true
		}
		return value, true
	}
}

// jsStringToNumber mirrors JavaScript's Number(string) coercion, including the
// hex/octal/binary literal forms and the empty-string rule (Number("") === 0).
func jsStringToNumber(text string) float64 {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0
	}
	lower := strings.ToLower(trimmed)
	switch lower {
	case "infinity", "+infinity":
		return math.Inf(1)
	case "-infinity":
		return math.Inf(-1)
	}
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "0o") || strings.HasPrefix(lower, "0b") {
		base := 16
		switch lower[1] {
		case 'o':
			base = 8
		case 'b':
			base = 2
		}
		value, err := strconv.ParseInt(trimmed[2:], base, 64)
		if err != nil {
			return math.NaN()
		}
		return float64(value)
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
			return value
		}
		return math.NaN()
	}
	return value
}

// jsIsInteger mirrors Number.isInteger: finite values with no fractional part.
func jsIsInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// jsRoundTo4 mirrors Number(value.toFixed(4)), which the NewsNow weight fields
// use to cap the stored precision at four decimal places.
func jsRoundTo4(value float64) float64 {
	return math.Round(value*10000) / 10000
}

// jsClamp mirrors the clamp helper shared by the NestJS services: NaN or a
// value below min becomes min, a value above max becomes max.
func jsClamp(value float64, min, max int) int {
	if math.IsNaN(value) || value < float64(min) {
		return min
	}
	if value > float64(max) {
		return max
	}
	return int(value)
}

// objectLikeJSON reports whether raw holds a JSON object (not null, array or
// primitive). NestJS distinguishes these with typeof/Array.isArray checks.
func objectLikeJSON(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}
