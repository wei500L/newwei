package runtimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// News source scheduler field bounds.
const (
	newsSourceMinFreshnessWindowDays = 1
	newsSourceMaxFreshnessWindowDays = 3650
	newsSourceMinSeedCacheTTL        = 10
	newsSourceMaxSeedCacheTTL        = 3600
	newsSourceMinHitRatePercent      = 0
	newsSourceMaxHitRatePercent      = 100
	newsSourceMinColdNoHitRuns       = 1
	newsSourceMaxColdNoHitRuns       = 24
	newsSourceMinIntervalSeconds     = 10
	newsSourceMaxIntervalSeconds     = 21600
	newsSourceMinIntervalDivisor     = 1
	newsSourceMaxIntervalDivisor     = 8
	newsSourceMinDiscoveryTTLCap     = 10
	newsSourceMaxDiscoveryTTLCap     = 3600
)

// URL query parameter allowlist constants, reproduced from
// packages/utils/src/url-canonical.ts.
const (
	maxURLQueryParamAllowlistSize = 64
	maxURLQueryParamKeyLength     = 64
)

// defaultURLQueryParamAllowlist is DEFAULT_URL_QUERY_PARAM_ALLOWLIST.
var defaultURLQueryParamAllowlist = []string{
	"id", "story", "article", "post", "item", "p", "page", "v", "ver", "lang", "locale", "hl",
}

// News source scheduler invalid-stored-value payload, copied verbatim from the
// service's four ConflictException sites. detail is a single constant and is
// never interpolated with the offending field.
const (
	newsSourceInvalidCode   = "NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID"
	newsSourceInvalidError  = "Stored news source scheduler settings are invalid."
	newsSourceInvalidDetail = "seedFreshnessWindowDays must be an integer between 1 and 3650; " +
		"seedCacheTtlSecondsSitemapRss and seedCacheTtlSecondsListDeep must be integers between 10 and 3600; " +
		"seedCacheTtlForceGlobal must be a boolean; " +
		"seedUrlQueryParamAllowlist must be an array of valid query keys; " +
		"rssAdaptive* settings must be within configured integer ranges and satisfy " +
		"warmHitRate<=hotHitRate, warmCacheTtlCap>=hotCacheTtlCap, coldMaxInterval>=warmMinInterval."
)

// seedDiscoveryCachePrefixes are the four Redis prefixes invalidated after a
// successful PUT, in the order the service deletes them.
var seedDiscoveryCachePrefixes = []string{
	"news-source:sitemap:",
	"news-source:rss:",
	"news-source:list:",
	"news-source:deep:",
}

// newsSourceSchedulerCacheTTLMs is the service's process-local cache TTL.
const newsSourceSchedulerCacheTTLMs = 30000

// newsSourceSchedulerValues is the persisted/audited payload: fifteen values in
// the exact key order the service writes. It has no `source` key.
type newsSourceSchedulerValues struct {
	SeedFreshnessWindowDays                    int      `json:"seedFreshnessWindowDays"`
	SeedCacheTTLSecondsSitemapRSS              int      `json:"seedCacheTtlSecondsSitemapRss"`
	SeedCacheTTLSecondsListDeep                int      `json:"seedCacheTtlSecondsListDeep"`
	SeedCacheTTLForceGlobal                    bool     `json:"seedCacheTtlForceGlobal"`
	SeedURLQueryParamAllowlist                 []string `json:"seedUrlQueryParamAllowlist"`
	RSSAdaptiveHotHitRatePercent               int      `json:"rssAdaptiveHotHitRatePercent"`
	RSSAdaptiveWarmHitRatePercent              int      `json:"rssAdaptiveWarmHitRatePercent"`
	RSSAdaptiveColdConsecutiveNoHitRuns        int      `json:"rssAdaptiveColdConsecutiveNoHitRuns"`
	RSSAdaptiveHotIntervalSeconds              int      `json:"rssAdaptiveHotIntervalSeconds"`
	RSSAdaptiveWarmIntervalDivisor             int      `json:"rssAdaptiveWarmIntervalDivisor"`
	RSSAdaptiveWarmMinIntervalSeconds          int      `json:"rssAdaptiveWarmMinIntervalSeconds"`
	RSSAdaptiveColdIntervalMultiplier          int      `json:"rssAdaptiveColdIntervalMultiplier"`
	RSSAdaptiveColdMaxIntervalSeconds          int      `json:"rssAdaptiveColdMaxIntervalSeconds"`
	RSSAdaptiveHotDiscoveryCacheTTLCapSeconds  int      `json:"rssAdaptiveHotDiscoveryCacheTtlCapSeconds"`
	RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds int      `json:"rssAdaptiveWarmDiscoveryCacheTtlCapSeconds"`
}

// newsSourceSchedulerSettings is the public GET/PUT response: source first, then
// the fifteen values.
type newsSourceSchedulerSettings struct {
	Source SettingSource `json:"source"`
	newsSourceSchedulerValues
}

// newsSourceSchedulerRequest mirrors UpdateNewsSourceSchedulerSettingsDto: all
// fifteen fields are required (no @IsOptional anywhere).
type newsSourceSchedulerRequest struct {
	SeedFreshnessWindowDays                    json.RawMessage `json:"seedFreshnessWindowDays"`
	SeedCacheTTLSecondsSitemapRSS              json.RawMessage `json:"seedCacheTtlSecondsSitemapRss"`
	SeedCacheTTLSecondsListDeep                json.RawMessage `json:"seedCacheTtlSecondsListDeep"`
	SeedCacheTTLForceGlobal                    json.RawMessage `json:"seedCacheTtlForceGlobal"`
	SeedURLQueryParamAllowlist                 json.RawMessage `json:"seedUrlQueryParamAllowlist"`
	RSSAdaptiveHotHitRatePercent               json.RawMessage `json:"rssAdaptiveHotHitRatePercent"`
	RSSAdaptiveWarmHitRatePercent              json.RawMessage `json:"rssAdaptiveWarmHitRatePercent"`
	RSSAdaptiveColdConsecutiveNoHitRuns        json.RawMessage `json:"rssAdaptiveColdConsecutiveNoHitRuns"`
	RSSAdaptiveHotIntervalSeconds              json.RawMessage `json:"rssAdaptiveHotIntervalSeconds"`
	RSSAdaptiveWarmIntervalDivisor             json.RawMessage `json:"rssAdaptiveWarmIntervalDivisor"`
	RSSAdaptiveWarmMinIntervalSeconds          json.RawMessage `json:"rssAdaptiveWarmMinIntervalSeconds"`
	RSSAdaptiveColdIntervalMultiplier          json.RawMessage `json:"rssAdaptiveColdIntervalMultiplier"`
	RSSAdaptiveColdMaxIntervalSeconds          json.RawMessage `json:"rssAdaptiveColdMaxIntervalSeconds"`
	RSSAdaptiveHotDiscoveryCacheTTLCapSeconds  json.RawMessage `json:"rssAdaptiveHotDiscoveryCacheTtlCapSeconds"`
	RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds json.RawMessage `json:"rssAdaptiveWarmDiscoveryCacheTtlCapSeconds"`
}

// newsSourceSchedulerStoredValue is the typed view of the stored JSON object.
type newsSourceSchedulerStoredValue struct {
	SeedFreshnessWindowDays                    json.RawMessage `json:"seedFreshnessWindowDays"`
	SeedCacheTTLSecondsSitemapRSS              json.RawMessage `json:"seedCacheTtlSecondsSitemapRss"`
	SeedCacheTTLSecondsListDeep                json.RawMessage `json:"seedCacheTtlSecondsListDeep"`
	SeedCacheTTLForceGlobal                    json.RawMessage `json:"seedCacheTtlForceGlobal"`
	SeedURLQueryParamAllowlist                 json.RawMessage `json:"seedUrlQueryParamAllowlist"`
	RSSAdaptiveHotHitRatePercent               json.RawMessage `json:"rssAdaptiveHotHitRatePercent"`
	RSSAdaptiveWarmHitRatePercent              json.RawMessage `json:"rssAdaptiveWarmHitRatePercent"`
	RSSAdaptiveColdConsecutiveNoHitRuns        json.RawMessage `json:"rssAdaptiveColdConsecutiveNoHitRuns"`
	RSSAdaptiveHotIntervalSeconds              json.RawMessage `json:"rssAdaptiveHotIntervalSeconds"`
	RSSAdaptiveWarmIntervalDivisor             json.RawMessage `json:"rssAdaptiveWarmIntervalDivisor"`
	RSSAdaptiveWarmMinIntervalSeconds          json.RawMessage `json:"rssAdaptiveWarmMinIntervalSeconds"`
	RSSAdaptiveColdIntervalMultiplier          json.RawMessage `json:"rssAdaptiveColdIntervalMultiplier"`
	RSSAdaptiveColdMaxIntervalSeconds          json.RawMessage `json:"rssAdaptiveColdMaxIntervalSeconds"`
	RSSAdaptiveHotDiscoveryCacheTTLCapSeconds  json.RawMessage `json:"rssAdaptiveHotDiscoveryCacheTtlCapSeconds"`
	RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds json.RawMessage `json:"rssAdaptiveWarmDiscoveryCacheTtlCapSeconds"`
}

// newsSourceSchedulerCache mirrors the service's 30 second process-local cache.
type newsSourceSchedulerCache struct {
	mutex     sync.Mutex
	value     newsSourceSchedulerSettings
	expiresAt time.Time
	valid     bool
}

// load returns the cached settings when they have not expired.
func (c *newsSourceSchedulerCache) load(now time.Time) (newsSourceSchedulerSettings, bool) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if c.valid && now.Before(c.expiresAt) {
		return c.value, true
	}
	return newsSourceSchedulerSettings{}, false
}

// store refreshes the cache.
func (c *newsSourceSchedulerCache) store(value newsSourceSchedulerSettings, now time.Time) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	c.value = value
	c.valid = true
	c.expiresAt = now.Add(newsSourceSchedulerCacheTTLMs * time.Millisecond)
}

// defaultNewsSourceSchedulerValues returns the documented defaults. The
// allowlist is copied so callers cannot mutate the shared default slice.
func defaultNewsSourceSchedulerValues() newsSourceSchedulerValues {
	return newsSourceSchedulerValues{
		SeedFreshnessWindowDays:                    365,
		SeedCacheTTLSecondsSitemapRSS:              60,
		SeedCacheTTLSecondsListDeep:                180,
		SeedCacheTTLForceGlobal:                    false,
		SeedURLQueryParamAllowlist:                 append([]string(nil), defaultURLQueryParamAllowlist...),
		RSSAdaptiveHotHitRatePercent:               60,
		RSSAdaptiveWarmHitRatePercent:              25,
		RSSAdaptiveColdConsecutiveNoHitRuns:        4,
		RSSAdaptiveHotIntervalSeconds:              30,
		RSSAdaptiveWarmIntervalDivisor:             2,
		RSSAdaptiveWarmMinIntervalSeconds:          30,
		RSSAdaptiveColdIntervalMultiplier:          2,
		RSSAdaptiveColdMaxIntervalSeconds:          3600,
		RSSAdaptiveHotDiscoveryCacheTTLCapSeconds:  30,
		RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds: 60,
	}
}

// invalidNewsSourceSettings builds the 409 for an unusable stored row.
func invalidNewsSourceSettings() error {
	return &httpError{
		status:  http.StatusConflict,
		message: newsSourceInvalidError,
		code:    newsSourceInvalidCode,
		detail:  newsSourceInvalidDetail,
	}
}

// normalizeParamKey mirrors normalizeParamKey: a string is trimmed and
// lower-cased; empty, over-long or non-matching keys are dropped.
func normalizeParamKey(value string) (string, bool) {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" || len(trimmed) > maxURLQueryParamKeyLength {
		return "", false
	}
	if !queryParamAllowlistEntry(trimmed) {
		return "", false
	}
	return trimmed, true
}

// normalizeURLQueryParamAllowlist mirrors normalizeUrlQueryParamAllowlist for an
// already-decoded []string input: values are normalized, de-duplicated in
// insertion order and capped at 64 entries.
func normalizeURLQueryParamAllowlist(values []string) []string {
	normalized := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, entry := range values {
		key, ok := normalizeParamKey(entry)
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		normalized = append(normalized, key)
		if len(normalized) >= maxURLQueryParamAllowlistSize {
			break
		}
	}
	return normalized
}

// storedNumber mirrors the service toNumber: a finite JSON number, or a numeric
// string with non-blank content. Booleans, null, arrays and objects are
// rejected (the "not a number" state).
func storedNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil || strings.TrimSpace(text) == "" {
			return 0, false
		}
		value := jsStringToNumber(text)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return value, true
	}
	if !isJSONNumber(trimmed) {
		return 0, false
	}
	value, err := parseJSONFloat(trimmed)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// storedInt enforces the shared "integer inside [min,max]" rule.
func storedInt(raw json.RawMessage, min, max int) (int, bool) {
	value, ok := storedNumber(raw)
	if !ok || !jsIsInteger(value) || value < float64(min) || value > float64(max) {
		return 0, false
	}
	return int(value), true
}

// storedOptionalInt resolves an optional stored field: absent or null means
// "use the default" (found=false, ok=true), an invalid value means the whole
// record is invalid (ok=false).
func storedOptionalInt(raw json.RawMessage, min, max int) (value int, found bool, ok bool) {
	if !present(raw) || isNull(raw) {
		return 0, false, true
	}
	parsed, valid := storedInt(raw, min, max)
	if !valid {
		return 0, true, false
	}
	return parsed, true, true
}

// storedOptionalBool resolves an optional stored boolean: only a real JSON
// boolean is accepted.
func storedOptionalBool(raw json.RawMessage) (value bool, found bool, ok bool) {
	if !present(raw) || isNull(raw) {
		return false, false, true
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("true")) {
		return true, true, true
	}
	if bytes.Equal(trimmed, []byte("false")) {
		return false, true, true
	}
	return false, true, false
}

// storedOptionalAllowlist resolves the stored allowlist: absent or null means
// "use the default"; a found value must be an array of at most 64 valid
// string keys, otherwise the whole record is invalid.
func storedOptionalAllowlist(raw json.RawMessage) (value []string, found bool, ok bool) {
	if !present(raw) || isNull(raw) {
		return nil, false, true
	}
	if !bytes.HasPrefix(bytes.TrimSpace(raw), []byte{'['}) {
		return nil, true, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &entries); err != nil {
		return nil, true, false
	}
	if len(entries) > maxURLQueryParamAllowlistSize {
		return nil, true, false
	}
	decoded := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !bytes.HasPrefix(bytes.TrimSpace(entry), []byte{'"'}) {
			return nil, true, false
		}
		var text string
		if err := json.Unmarshal(bytes.TrimSpace(entry), &text); err != nil {
			return nil, true, false
		}
		if _, valid := normalizeParamKey(text); !valid {
			return nil, true, false
		}
		decoded = append(decoded, text)
	}
	return normalizeURLQueryParamAllowlist(decoded), true, true
}

// checkNewsSourceCrossField applies the three cross-field rules shared by the
// read path (409) and the write path (400). build receives the message.
func checkNewsSourceCrossField(values newsSourceSchedulerValues, build func(string) error) error {
	if values.RSSAdaptiveWarmHitRatePercent > values.RSSAdaptiveHotHitRatePercent {
		return build("rssAdaptiveWarmHitRatePercent must be less than or equal to rssAdaptiveHotHitRatePercent")
	}
	if values.RSSAdaptiveColdMaxIntervalSeconds < values.RSSAdaptiveWarmMinIntervalSeconds {
		return build("rssAdaptiveColdMaxIntervalSeconds must be greater than or equal to rssAdaptiveWarmMinIntervalSeconds")
	}
	if values.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds < values.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds {
		return build("rssAdaptiveWarmDiscoveryCacheTtlCapSeconds must be greater than or equal to rssAdaptiveHotDiscoveryCacheTtlCapSeconds")
	}
	return nil
}

// parseNewsSourceSchedulerRequest validates the PUT body. The DTO requires all
// fifteen fields, then the service normalizes the allowlist and applies the
// three cross-field rules.
func parseNewsSourceSchedulerRequest(body []byte) (newsSourceSchedulerValues, error) {
	var dto newsSourceSchedulerRequest
	if err := decodeBodyError(newStrictDecoder(body).Decode(&dto)); err != nil {
		return newsSourceSchedulerValues{}, err
	}
	problems := validationErrors{}
	seedFreshnessWindowDays, _ := numberField(&problems, dto.SeedFreshnessWindowDays, "seedFreshnessWindowDays", true, newsSourceMinFreshnessWindowDays, newsSourceMaxFreshnessWindowDays)
	seedCacheTTLSitemap, _ := numberField(&problems, dto.SeedCacheTTLSecondsSitemapRSS, "seedCacheTtlSecondsSitemapRss", true, newsSourceMinSeedCacheTTL, newsSourceMaxSeedCacheTTL)
	seedCacheTTLListDeep, _ := numberField(&problems, dto.SeedCacheTTLSecondsListDeep, "seedCacheTtlSecondsListDeep", true, newsSourceMinSeedCacheTTL, newsSourceMaxSeedCacheTTL)
	seedCacheTTLForceGlobal, _ := boolField(&problems, dto.SeedCacheTTLForceGlobal, "seedCacheTtlForceGlobal", true)
	allowlist, _ := stringListField(&problems, dto.SeedURLQueryParamAllowlist, "seedUrlQueryParamAllowlist", maxURLQueryParamAllowlistSize, maxURLQueryParamAllowlistSize)
	hotHitRate, _ := numberField(&problems, dto.RSSAdaptiveHotHitRatePercent, "rssAdaptiveHotHitRatePercent", true, newsSourceMinHitRatePercent, newsSourceMaxHitRatePercent)
	warmHitRate, _ := numberField(&problems, dto.RSSAdaptiveWarmHitRatePercent, "rssAdaptiveWarmHitRatePercent", true, newsSourceMinHitRatePercent, newsSourceMaxHitRatePercent)
	coldNoHitRuns, _ := numberField(&problems, dto.RSSAdaptiveColdConsecutiveNoHitRuns, "rssAdaptiveColdConsecutiveNoHitRuns", true, newsSourceMinColdNoHitRuns, newsSourceMaxColdNoHitRuns)
	hotInterval, _ := numberField(&problems, dto.RSSAdaptiveHotIntervalSeconds, "rssAdaptiveHotIntervalSeconds", true, newsSourceMinIntervalSeconds, newsSourceMaxIntervalSeconds)
	warmDivisor, _ := numberField(&problems, dto.RSSAdaptiveWarmIntervalDivisor, "rssAdaptiveWarmIntervalDivisor", true, newsSourceMinIntervalDivisor, newsSourceMaxIntervalDivisor)
	warmMinInterval, _ := numberField(&problems, dto.RSSAdaptiveWarmMinIntervalSeconds, "rssAdaptiveWarmMinIntervalSeconds", true, newsSourceMinIntervalSeconds, newsSourceMaxIntervalSeconds)
	coldMultiplier, _ := numberField(&problems, dto.RSSAdaptiveColdIntervalMultiplier, "rssAdaptiveColdIntervalMultiplier", true, newsSourceMinIntervalDivisor, newsSourceMaxIntervalDivisor)
	coldMaxInterval, _ := numberField(&problems, dto.RSSAdaptiveColdMaxIntervalSeconds, "rssAdaptiveColdMaxIntervalSeconds", true, newsSourceMinIntervalSeconds, newsSourceMaxIntervalSeconds)
	hotTTLCap, _ := numberField(&problems, dto.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds, "rssAdaptiveHotDiscoveryCacheTtlCapSeconds", true, newsSourceMinDiscoveryTTLCap, newsSourceMaxDiscoveryTTLCap)
	warmTTLCap, _ := numberField(&problems, dto.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds, "rssAdaptiveWarmDiscoveryCacheTtlCapSeconds", true, newsSourceMinDiscoveryTTLCap, newsSourceMaxDiscoveryTTLCap)
	if err := problems.err(); err != nil {
		return newsSourceSchedulerValues{}, err
	}

	values := newsSourceSchedulerValues{
		SeedFreshnessWindowDays:                    seedFreshnessWindowDays,
		SeedCacheTTLSecondsSitemapRSS:              seedCacheTTLSitemap,
		SeedCacheTTLSecondsListDeep:                seedCacheTTLListDeep,
		SeedCacheTTLForceGlobal:                    seedCacheTTLForceGlobal,
		SeedURLQueryParamAllowlist:                 normalizeURLQueryParamAllowlist(allowlist),
		RSSAdaptiveHotHitRatePercent:               hotHitRate,
		RSSAdaptiveWarmHitRatePercent:              warmHitRate,
		RSSAdaptiveColdConsecutiveNoHitRuns:        coldNoHitRuns,
		RSSAdaptiveHotIntervalSeconds:              hotInterval,
		RSSAdaptiveWarmIntervalDivisor:             warmDivisor,
		RSSAdaptiveWarmMinIntervalSeconds:          warmMinInterval,
		RSSAdaptiveColdIntervalMultiplier:          coldMultiplier,
		RSSAdaptiveColdMaxIntervalSeconds:          coldMaxInterval,
		RSSAdaptiveHotDiscoveryCacheTTLCapSeconds:  hotTTLCap,
		RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds: warmTTLCap,
	}
	if values.SeedURLQueryParamAllowlist == nil {
		values.SeedURLQueryParamAllowlist = []string{}
	}
	if err := checkNewsSourceCrossField(values, func(message string) error {
		return &httpError{status: http.StatusBadRequest, message: message}
	}); err != nil {
		return newsSourceSchedulerValues{}, err
	}
	return values, nil
}

// readNewsSourceSchedulerSettings mirrors the read path: an absent row returns
// the defaults; a present row is parsed field by field (numeric strings are
// accepted, booleans must be real booleans) and any invalid or cross-field
// violating value fails the whole read with 409.
func (s *Service) readNewsSourceSchedulerSettings(ctx context.Context) (newsSourceSchedulerSettings, error) {
	defaults := defaultNewsSourceSchedulerValues()
	raw, found, err := s.loadSetting(ctx, settingKeyNewsSourceScheduler)
	if err != nil {
		return newsSourceSchedulerSettings{}, err
	}
	if !found {
		return newsSourceSchedulerSettings{Source: SourceDefault, newsSourceSchedulerValues: defaults}, nil
	}
	var stored newsSourceSchedulerStoredValue
	if err := json.Unmarshal(raw, &stored); err != nil {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	}

	// seedFreshnessWindowDays has no optional variant: absent or null is invalid
	// once a row exists.
	freshness, ok := storedInt(stored.SeedFreshnessWindowDays, newsSourceMinFreshnessWindowDays, newsSourceMaxFreshnessWindowDays)
	if !ok {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	}
	values := defaults
	values.SeedFreshnessWindowDays = freshness

	if value, present, valid := storedOptionalInt(stored.SeedCacheTTLSecondsSitemapRSS, newsSourceMinSeedCacheTTL, newsSourceMaxSeedCacheTTL); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.SeedCacheTTLSecondsSitemapRSS = value
	}
	if value, present, valid := storedOptionalInt(stored.SeedCacheTTLSecondsListDeep, newsSourceMinSeedCacheTTL, newsSourceMaxSeedCacheTTL); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.SeedCacheTTLSecondsListDeep = value
	}
	if value, present, valid := storedOptionalBool(stored.SeedCacheTTLForceGlobal); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.SeedCacheTTLForceGlobal = value
	}
	if value, present, valid := storedOptionalAllowlist(stored.SeedURLQueryParamAllowlist); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.SeedURLQueryParamAllowlist = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveHotHitRatePercent, newsSourceMinHitRatePercent, newsSourceMaxHitRatePercent); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveHotHitRatePercent = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveWarmHitRatePercent, newsSourceMinHitRatePercent, newsSourceMaxHitRatePercent); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveWarmHitRatePercent = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveColdConsecutiveNoHitRuns, newsSourceMinColdNoHitRuns, newsSourceMaxColdNoHitRuns); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveColdConsecutiveNoHitRuns = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveHotIntervalSeconds, newsSourceMinIntervalSeconds, newsSourceMaxIntervalSeconds); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveHotIntervalSeconds = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveWarmIntervalDivisor, newsSourceMinIntervalDivisor, newsSourceMaxIntervalDivisor); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveWarmIntervalDivisor = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveWarmMinIntervalSeconds, newsSourceMinIntervalSeconds, newsSourceMaxIntervalSeconds); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveWarmMinIntervalSeconds = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveColdIntervalMultiplier, newsSourceMinIntervalDivisor, newsSourceMaxIntervalDivisor); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveColdIntervalMultiplier = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveColdMaxIntervalSeconds, newsSourceMinIntervalSeconds, newsSourceMaxIntervalSeconds); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveColdMaxIntervalSeconds = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds, newsSourceMinDiscoveryTTLCap, newsSourceMaxDiscoveryTTLCap); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveHotDiscoveryCacheTTLCapSeconds = value
	}
	if value, present, valid := storedOptionalInt(stored.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds, newsSourceMinDiscoveryTTLCap, newsSourceMaxDiscoveryTTLCap); !valid {
		return newsSourceSchedulerSettings{}, invalidNewsSourceSettings()
	} else if present {
		values.RSSAdaptiveWarmDiscoveryCacheTTLCapSeconds = value
	}

	if err := checkNewsSourceCrossField(values, func(string) error {
		return invalidNewsSourceSettings()
	}); err != nil {
		return newsSourceSchedulerSettings{}, err
	}
	return newsSourceSchedulerSettings{Source: SourceDB, newsSourceSchedulerValues: values}, nil
}

// getNewsSourceSchedulerSettings applies the 30 second process-local cache in
// front of the stored read.
func (s *Service) getNewsSourceSchedulerSettings(ctx context.Context) (newsSourceSchedulerSettings, error) {
	now := time.Now()
	if cached, ok := s.newsSourceCache.load(now); ok {
		return cached, nil
	}
	settings, err := s.readNewsSourceSchedulerSettings(ctx)
	if err != nil {
		return newsSourceSchedulerSettings{}, err
	}
	s.newsSourceCache.store(settings, now)
	return settings, nil
}

// updateNewsSourceSchedulerSettings mirrors updateSettings: a description
// overwriting upsert, best-effort Redis discovery-cache invalidation, the audit
// row and a source:"db" response.
func (s *Service) updateNewsSourceSchedulerSettings(ctx context.Context, orgID, actorID string, values newsSourceSchedulerValues) (newsSourceSchedulerSettings, error) {
	if s == nil || s.db == nil {
		return newsSourceSchedulerSettings{}, errNoDatabase
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return newsSourceSchedulerSettings{}, err
	}
	if err := s.upsertSettingForceDescription(ctx, settingKeyNewsSourceScheduler, encoded,
		descriptionNewsSourceScheduler, nullableActorID(actorID)); err != nil {
		return newsSourceSchedulerSettings{}, err
	}
	// Cache invalidation is best-effort: a Redis failure only skips the
	// remaining prefixes and never fails the write.
	for _, prefix := range seedDiscoveryCachePrefixes {
		s.cacheDelByPrefix(ctx, prefix)
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "news_source_scheduler_settings_update", encoded)
	settings := newsSourceSchedulerSettings{Source: SourceDB, newsSourceSchedulerValues: values}
	s.newsSourceCache.store(settings, time.Now())
	return settings, nil
}
