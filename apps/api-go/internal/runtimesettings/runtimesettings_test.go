package runtimesettings

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

// TestJSCoercionHelpers locks the JavaScript Number() semantics the stored-value
// readers depend on.
func TestJSCoercionHelpers(t *testing.T) {
	cases := []struct {
		raw     string
		want    float64
		present bool
	}{
		{`4`, 4, true},
		{`4.5`, 4.5, true},
		{`"4"`, 4, true},
		{`" 4 "`, 4, true},
		{`"0x4"`, 4, true},
		{`""`, 0, true},
		{`true`, 1, true},
		{`false`, 0, true},
		{`null`, 0, true},
		{`[4]`, 4, true},
		{`[]`, 0, true},
		{`[1,2]`, 0, true}, // NaN sentinel: multi-element arrays are not numeric
		{`{}`, 0, true},    // NaN sentinel: objects are not numeric
	}
	for _, tc := range cases {
		value, present := jsNumberFromJSON(json.RawMessage(tc.raw))
		if present != tc.present {
			t.Fatalf("%s present=%v want %v", tc.raw, present, tc.present)
		}
		if tc.raw == `[1,2]` || tc.raw == `{}` {
			if !math.IsNaN(value) {
				t.Fatalf("%s value=%v want NaN", tc.raw, value)
			}
			continue
		}
		if value != tc.want {
			t.Fatalf("%s value=%v want %v", tc.raw, value, tc.want)
		}
	}
	if _, present := jsNumberFromJSON(nil); present {
		t.Fatal("absent raw must report present=false")
	}
	if !jsIsInteger(16) || jsIsInteger(4.5) || jsIsInteger(math.Inf(1)) {
		t.Fatal("jsIsInteger mismatch")
	}
	if jsRoundTo4(0.8) != 0.8 || jsRoundTo4(0.123456) != 0.1235 {
		t.Fatal("jsRoundTo4 mismatch")
	}
	if jsClamp(math.NaN(), 1, 1000) != 1 || jsClamp(5000, 1, 1000) != 1000 || jsClamp(42, 1, 1000) != 42 {
		t.Fatal("jsClamp mismatch")
	}
}

// TestNullableActorID covers the machine-token foreign key fix: machine actors
// and empty ids must be written as SQL NULL, humans keep their user id.
func TestNullableActorID(t *testing.T) {
	if nullableActorID("machine:tok1") != nil {
		t.Fatal("machine actor must map to NULL")
	}
	if nullableActorID("") != nil {
		t.Fatal("empty actor must map to NULL")
	}
	actor := nullableActorID("user-1")
	if actor == nil || *actor != "user-1" {
		t.Fatalf("human actor = %v", actor)
	}
}

// TestNormalizePolicyFeature locks trim().toLowerCase() plus the 400 message.
func TestNormalizePolicyFeature(t *testing.T) {
	normalized, err := normalizePolicyFeature("  RSS_Fetch ")
	if err != nil || normalized != "rss_fetch" {
		t.Fatalf("normalize = %q err=%v", normalized, err)
	}
	for _, invalid := range []string{"", "1abc", "a b", "a-b", "a/b"} {
		_, err := normalizePolicyFeature(invalid)
		var coded *httpError
		if err == nil || !asHTTPError(err, &coded) || coded.status != 400 || coded.message != "Invalid rate limit feature name" {
			t.Fatalf("invalid %q err=%v", invalid, err)
		}
	}
}

// TestDescriptionClearing covers defect 2: an explicitly supplied blank
// description must clear the column, while an absent key must keep it.
func TestDescriptionClearing(t *testing.T) {
	patch, err := parseUpdateRateLimitPolicy([]byte(`{"description":"   "}`))
	if err != nil {
		t.Fatal(err)
	}
	if !patch.TouchDescription || patch.Description != nil {
		t.Fatalf("blank description patch=%+v", patch)
	}
	patch, err = parseUpdateRateLimitPolicy([]byte(`{"description":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if !patch.TouchDescription || patch.Description != nil {
		t.Fatalf("null description patch=%+v", patch)
	}
	patch, err = parseUpdateRateLimitPolicy([]byte(`{"userLimit":5}`))
	if err != nil {
		t.Fatal(err)
	}
	if patch.TouchDescription {
		t.Fatal("absent description must not touch the column")
	}
	patch, err = parseUpdateRateLimitPolicy([]byte(`{"description":"  hello "}`))
	if err != nil {
		t.Fatal(err)
	}
	if patch.Description == nil || *patch.Description != "hello" {
		t.Fatalf("trimmed description patch=%+v", patch)
	}
}

// TestRateLimitPolicyCreateValidation locks the DTO bounds and the raw feature
// pattern check performed before normalization.
func TestRateLimitPolicyCreateValidation(t *testing.T) {
	feature, write, err := parseCreateRateLimitPolicy([]byte(
		`{"feature":"rss_fetch","userLimit":10,"ipLimit":20,"windowSeconds":60}`))
	if err != nil {
		t.Fatal(err)
	}
	if feature != "rss_fetch" || write.UserLimit != 10 || write.IPLimit != 20 ||
		write.WindowSeconds != 60 || !write.Enabled || write.Description != nil {
		t.Fatalf("create parse=%q %+v", feature, write)
	}
	if _, _, err := parseCreateRateLimitPolicy([]byte(
		`{"feature":"RSS_FETCH","userLimit":10,"ipLimit":20,"windowSeconds":60}`)); err == nil {
		t.Fatal("uppercase feature must fail the DTO @Matches check")
	}
	if _, _, err := parseCreateRateLimitPolicy([]byte(
		`{"feature":"rss","userLimit":-1,"ipLimit":20,"windowSeconds":60}`)); err == nil {
		t.Fatal("negative userLimit must be rejected")
	}
	if _, _, err := parseCreateRateLimitPolicy([]byte(
		`{"feature":"rss","userLimit":10,"ipLimit":20,"windowSeconds":60,"unknown":1}`)); err == nil {
		t.Fatal("unknown property must be rejected")
	}
}

// TestIsDuplicateKeyError locks the MySQL 1062 detection behind the 409.
func TestIsDuplicateKeyError(t *testing.T) {
	if !isDuplicateKeyError(&mysql.MySQLError{Number: 1062, Message: "dup"}) {
		t.Fatal("1062 must be detected")
	}
	if isDuplicateKeyError(&mysql.MySQLError{Number: 1452, Message: "fk"}) {
		t.Fatal("1452 must not be treated as a duplicate")
	}
}

// TestNormalizeBucket locks the rate limit bucket coercion and clamping.
func TestNormalizeBucket(t *testing.T) {
	fallback := rateLimitBucketConfig{Limit: 5, WindowSeconds: 60}
	if got := normalizeBucket(nil, fallback); got != fallback {
		t.Fatalf("absent bucket = %+v", got)
	}
	if got := normalizeBucket(json.RawMessage(`null`), fallback); got != fallback {
		t.Fatalf("null bucket = %+v", got)
	}
	if got := normalizeBucket(json.RawMessage(`{"limit":"50","windowSeconds":"70"}`), fallback); got.Limit != 50 || got.WindowSeconds != 70 {
		t.Fatalf("numeric string bucket = %+v", got)
	}
	if got := normalizeBucket(json.RawMessage(`{"limit":5000,"windowSeconds":999999}`), fallback); got.Limit != 1000 || got.WindowSeconds != 86400 {
		t.Fatalf("clamped bucket = %+v", got)
	}
	if got := normalizeBucket(json.RawMessage(`[]`), fallback); got.Limit != 1 || got.WindowSeconds != 5 {
		t.Fatalf("array bucket = %+v", got)
	}
}

// TestUpdateRateLimitSettingsRequestParsing locks the nested DTO validation.
func TestUpdateRateLimitSettingsRequestParsing(t *testing.T) {
	dto, err := parseUpdateRateLimitSettings([]byte(
		`{"login":{"limit":5,"windowSeconds":60},"crawlCreate":{"limit":10,"windowSeconds":300},"rbacWrite":{"limit":20,"windowSeconds":600}}`))
	if err != nil {
		t.Fatal(err)
	}
	if dto.Login == nil || dto.CrawlCreate == nil || dto.RbacWrite == nil {
		t.Fatalf("buckets=%+v", dto)
	}
	// @ValidateNested() does not run on absent buckets, so an empty body passes.
	if _, err := parseUpdateRateLimitSettings([]byte(`{}`)); err != nil {
		t.Fatalf("empty body must pass DTO validation: %v", err)
	}
	if _, err := parseUpdateRateLimitSettings([]byte(`{"login":{"limit":0,"windowSeconds":60}}`)); err == nil {
		t.Fatal("limit below 1 must be rejected")
	}
	if _, err := parseUpdateRateLimitSettings([]byte(`{"login":{"limit":5}}`)); err == nil {
		t.Fatal("missing windowSeconds must be rejected")
	}
}

// TestNormalizeAuthCacheSettings locks the clamp order, especially the
// maxWaitMs >= retryDelayMs rule.
func TestNormalizeAuthCacheSettings(t *testing.T) {
	fallback := authCacheSettings{ProfileTTLSeconds: 600, LockTTLMs: 5000, MaxWaitMs: 5000, RetryDelayMs: 50}
	normalized := normalizeAuthCacheSettings(authCacheSettings{ProfileTTLSeconds: 600, LockTTLMs: 5000, MaxWaitMs: 50, RetryDelayMs: 500}, fallback)
	if normalized.MaxWaitMs != 500 {
		t.Fatalf("maxWaitMs = %d, want 500", normalized.MaxWaitMs)
	}
	normalized = normalizeAuthCacheSettings(authCacheSettings{ProfileTTLSeconds: 1, LockTTLMs: 1, MaxWaitMs: 1, RetryDelayMs: 1}, fallback)
	if normalized.ProfileTTLSeconds != 60 || normalized.LockTTLMs != 100 || normalized.MaxWaitMs != 50 || normalized.RetryDelayMs != 10 {
		t.Fatalf("clamped = %+v", normalized)
	}
	// authCacheToInt accepts only finite JSON numbers, never numeric strings.
	if got := authCacheToInt(json.RawMessage(`"600"`), 42); got != 42 {
		t.Fatalf("numeric string must fall back, got %d", got)
	}
	if got := authCacheToInt(json.RawMessage(`600`), 42); got != 600 {
		t.Fatalf("number = %d", got)
	}
}

// TestNormalizeRetentionDays locks Math.floor plus the [1,3650] clamp.
func TestNormalizeRetentionDays(t *testing.T) {
	if got := normalizeRetentionDays(90); got != 90 {
		t.Fatalf("90 = %d", got)
	}
	if got := normalizeRetentionDays(90.9); got != 90 {
		t.Fatalf("90.9 = %d", got)
	}
	if got := normalizeRetentionDays(0); got != 1 {
		t.Fatalf("0 = %d", got)
	}
	if got := normalizeRetentionDays(1e9); got != 3650 {
		t.Fatalf("1e9 = %d", got)
	}
}

// TestMultiTenantSchedulerParsing locks the full-replace semantics and the
// layer B flat 400 for a null optional field.
func TestMultiTenantSchedulerParsing(t *testing.T) {
	values, err := parseMultiTenantSchedulerRequest([]byte(
		`{"newsEventsIngestionOrgConcurrency":5,"knowledgeGraphIngestionOrgConcurrency":4,` +
			`"sentimentSnapshotOrgConcurrency":2,"newsnowHottestAnalysisOrgConcurrency":6,` +
			`"userDigestDeliveryOrgConcurrency":4}`))
	if err != nil {
		t.Fatal(err)
	}
	if values.NewsEventsIngestionOrgConcurrency != 5 || values.RealtimeSignalsOrgConcurrency != 4 ||
		values.SituationMonitorOrefDefaultRuleOrgConcurrency != 16 {
		t.Fatalf("values=%+v", values)
	}
	if _, err := parseMultiTenantSchedulerRequest([]byte(
		`{"newsEventsIngestionOrgConcurrency":5,"knowledgeGraphIngestionOrgConcurrency":4,` +
			`"sentimentSnapshotOrgConcurrency":2,"newsnowHottestAnalysisOrgConcurrency":6}`)); err == nil {
		t.Fatal("missing required field must be rejected")
	}
	_, err = parseMultiTenantSchedulerRequest([]byte(
		`{"realtimeSignalsOrgConcurrency":null,"newsEventsIngestionOrgConcurrency":5,` +
			`"knowledgeGraphIngestionOrgConcurrency":4,"sentimentSnapshotOrgConcurrency":2,` +
			`"newsnowHottestAnalysisOrgConcurrency":6,"userDigestDeliveryOrgConcurrency":4}`))
	var coded *httpError
	if err == nil || !asHTTPError(err, &coded) || coded.status != 400 ||
		coded.message != "realtimeSignalsOrgConcurrency must be an integer between 1 and 16" {
		t.Fatalf("null optional err=%v", err)
	}
}

// TestMultiTenantStoredInvalid locks the 409 payload and the fact that a
// present-but-out-of-range concurrency invalidates the whole record while an
// absent key falls back to its default.
func TestMultiTenantStoredInvalid(t *testing.T) {
	if _, ok := strictOptionalInt(json.RawMessage(`99`)); ok {
		t.Fatal("99 must be rejected")
	}
	if _, ok := strictOptionalInt(json.RawMessage(`"4"`)); !ok {
		t.Fatal("numeric string 4 must be accepted on the read path")
	}
	if _, ok := strictOptionalInt(nil); ok {
		t.Fatal("absent must report not-present")
	}
	err := invalidMultiTenantSettings()
	var coded *httpError
	if !asHTTPError(err, &coded) || coded.status != 409 ||
		coded.code != "MULTI_TENANT_SCHEDULER_SETTINGS_INVALID" ||
		coded.message != "Stored multi-tenant scheduler runtime settings are invalid." ||
		coded.detail != "Multi-tenant scheduler concurrency settings must be integers between 1 and 16." {
		t.Fatalf("conflict payload=%+v", coded)
	}
}

// TestNewsSourceSchedulerParsing locks the three cross-field 400 boundaries in
// the documented evaluation order.
func TestNewsSourceSchedulerParsing(t *testing.T) {
	valid := `{"seedFreshnessWindowDays":365,"seedCacheTtlSecondsSitemapRss":60,` +
		`"seedCacheTtlSecondsListDeep":180,"seedCacheTtlForceGlobal":false,` +
		`"seedUrlQueryParamAllowlist":["ID","id","story"],"rssAdaptiveHotHitRatePercent":60,` +
		`"rssAdaptiveWarmHitRatePercent":25,"rssAdaptiveColdConsecutiveNoHitRuns":4,` +
		`"rssAdaptiveHotIntervalSeconds":30,"rssAdaptiveWarmIntervalDivisor":2,` +
		`"rssAdaptiveWarmMinIntervalSeconds":30,"rssAdaptiveColdIntervalMultiplier":2,` +
		`"rssAdaptiveColdMaxIntervalSeconds":3600,` +
		`"rssAdaptiveHotDiscoveryCacheTtlCapSeconds":30,` +
		`"rssAdaptiveWarmDiscoveryCacheTtlCapSeconds":60}`
	values, err := parseNewsSourceSchedulerRequest([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	if len(values.SeedURLQueryParamAllowlist) != 2 || values.SeedURLQueryParamAllowlist[0] != "id" ||
		values.SeedURLQueryParamAllowlist[1] != "story" {
		t.Fatalf("allowlist=%v", values.SeedURLQueryParamAllowlist)
	}

	hotWarm := strings.Replace(valid, `"rssAdaptiveWarmHitRatePercent":25`, `"rssAdaptiveWarmHitRatePercent":80`, 1)
	_, err = parseNewsSourceSchedulerRequest([]byte(hotWarm))
	assertHTTPError(t, err, 400, "rssAdaptiveWarmHitRatePercent must be less than or equal to rssAdaptiveHotHitRatePercent")

	coldWarm := strings.Replace(valid, `"rssAdaptiveColdMaxIntervalSeconds":3600`, `"rssAdaptiveColdMaxIntervalSeconds":10`, 1)
	coldWarm = strings.Replace(coldWarm, `"rssAdaptiveWarmMinIntervalSeconds":30`, `"rssAdaptiveWarmMinIntervalSeconds":600`, 1)
	_, err = parseNewsSourceSchedulerRequest([]byte(coldWarm))
	assertHTTPError(t, err, 400, "rssAdaptiveColdMaxIntervalSeconds must be greater than or equal to rssAdaptiveWarmMinIntervalSeconds")

	ttlCap := strings.Replace(valid, `"rssAdaptiveWarmDiscoveryCacheTtlCapSeconds":60`, `"rssAdaptiveWarmDiscoveryCacheTtlCapSeconds":10`, 1)
	_, err = parseNewsSourceSchedulerRequest([]byte(ttlCap))
	assertHTTPError(t, err, 400, "rssAdaptiveWarmDiscoveryCacheTtlCapSeconds must be greater than or equal to rssAdaptiveHotDiscoveryCacheTtlCapSeconds")
}

// TestNewsSourceAllowlistBounds locks the empty-array case and the cap.
func TestNewsSourceAllowlistBounds(t *testing.T) {
	if got := normalizeURLQueryParamAllowlist(nil); len(got) != 0 {
		t.Fatalf("empty input = %v", got)
	}
	entries := make([]string, 0, 70)
	for i := 0; i < 70; i++ {
		entries = append(entries, "k"+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	if got := normalizeURLQueryParamAllowlist(entries); len(got) != maxURLQueryParamAllowlistSize {
		t.Fatalf("capped length = %d", len(got))
	}
	value, present, ok := storedOptionalAllowlist(json.RawMessage(`[]`))
	if !ok || !present || len(value) != 0 {
		t.Fatalf("stored empty array = %v present=%v ok=%v", value, present, ok)
	}
	if _, present, ok := storedOptionalAllowlist(json.RawMessage(`"id"`)); ok || !present {
		t.Fatal("stored non-array allowlist must be invalid")
	}
	if _, present, ok := storedOptionalAllowlist(json.RawMessage(`["bad key"]`)); ok || !present {
		t.Fatal("stored invalid key must be invalid")
	}
}

// TestNewsNowPersonalizationParsing locks the optional-float defaults and the
// weight cross-field 400.
func TestNewsNowPersonalizationParsing(t *testing.T) {
	body := `{"cacheTtlMs":20000,"maxCacheEntries":2000,"throttleWindowMs":10000,` +
		`"maxRequestsPerWindowPerUser":40,"staleTtlStrategy":"multiplier",` +
		`"staleTtlMultiplier":3,"staleTtlFixedMs":60000}`
	values, err := parseNewsNowPersonalizationRequest([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if values.AffinitySourceWeight != 0.42 || values.BehaviorSourceWeight != 0.58 ||
		values.FocusSourceBonus != 0.35 || values.StaleTTLStrategy != staleTtlStrategyMultiplier {
		t.Fatalf("defaults=%+v", values)
	}
	zeroWeights := strings.Replace(body, `"maxRequestsPerWindowPerUser":40`, `"maxRequestsPerWindowPerUser":40,"affinitySourceWeight":0,"behaviorSourceWeight":0`, 1)
	_, err = parseNewsNowPersonalizationRequest([]byte(zeroWeights))
	assertHTTPError(t, err, 400, "affinitySourceWeight + behaviorSourceWeight must be greater than 0")
	if _, err := parseNewsNowPersonalizationRequest([]byte(strings.Replace(body, `"staleTtlStrategy":"multiplier"`, `"staleTtlStrategy":"linear"`, 1))); err == nil {
		t.Fatal("unknown strategy must be rejected")
	}
	if _, err := parseNewsNowPersonalizationRequest([]byte(strings.Replace(body, `"cacheTtlMs":20000`, `"cacheTtlMs":900000`, 1))); err == nil {
		t.Fatal("out-of-range cacheTtlMs must be rejected")
	}
}

// TestNewsNowMetricsWindowDays locks the days query semantics.
func TestNewsNowMetricsWindowDays(t *testing.T) {
	cases := []struct {
		raw      string
		present  bool
		multiple bool
		want     int
	}{
		{"", false, false, 7},
		{"", true, false, 1},
		{"abc", true, false, 7},
		{"Infinity", true, false, 7},
		{"0", true, false, 1},
		{"-5", true, false, 1},
		{"3.9", true, false, 3},
		{"7", true, false, 7},
		{"0x10", true, false, 16},
		{"1000", true, false, 90},
		{"1", true, true, 7},
	}
	for _, tc := range cases {
		if got := metricsWindowDays(tc.raw, tc.present, tc.multiple); got != tc.want {
			t.Fatalf("days=%q present=%v multiple=%v got=%d want=%d", tc.raw, tc.present, tc.multiple, got, tc.want)
		}
	}
}

// TestNewsNowMetricsAggregation locks the smoke-test arithmetic: totals rates are
// ratios of sums rounded to four decimals.
func TestNewsNowMetricsAggregation(t *testing.T) {
	record := map[string]string{
		"requestCount":          "10",
		"cacheHitFreshCount":    "6",
		"cacheHitStaleCount":    "2",
		"throttleLimitedCount":  "1",
		"throttleRejectedCount": "0",
		"trimCount":             "0",
		"trimEvictedCount":      "0",
	}
	row := metricsRowFromRecord("2026-10-17", record)
	if row.CacheHitTotalCount != 8 || row.CacheHitRate != 0.8 || row.ThrottleRate != 0.1 {
		t.Fatalf("row=%+v", row)
	}
	if got := toPositiveInt("2.9"); got != 2 {
		t.Fatalf("floor(2.9)=%d", got)
	}
	if got := toPositiveInt("abc"); got != 0 {
		t.Fatalf("non-numeric=%d", got)
	}
	if got := safeRatio(0, 0); got != 0 {
		t.Fatalf("zero denominator=%v", got)
	}
}

// TestNewsNowMetricsSnapshotWithoutRedis locks the window shape: windowDays rows
// in ascending date order with an all-zero payload when Redis is absent.
func TestNewsNowMetricsSnapshotWithoutRedis(t *testing.T) {
	service := &Service{}
	snapshot := service.getNewsNowMetricsSnapshot(context.Background(), 3)
	if snapshot.WindowDays != 3 || len(snapshot.Rows) != 3 {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	if snapshot.Totals.RequestCount != 0 || snapshot.Totals.CacheHitRate != 0 {
		t.Fatalf("totals=%+v", snapshot.Totals)
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	if snapshot.To != today.Format("2006-01-02") {
		t.Fatalf("to=%s", snapshot.To)
	}
	if snapshot.From != today.AddDate(0, 0, -2).Format("2006-01-02") {
		t.Fatalf("from=%s", snapshot.From)
	}
	if snapshot.Rows[0].Date >= snapshot.Rows[2].Date {
		t.Fatalf("rows must be ascending: %+v", snapshot.Rows)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"from":`) || !strings.Contains(string(encoded), `"windowDays":3`) {
		t.Fatalf("encoded=%s", encoded)
	}
}

// TestResponseKeyOrder locks the JSON key order the NestJS contract exposes.
func TestResponseKeyOrder(t *testing.T) {
	settings := multiTenantSchedulerSettings{
		Source:                          SourceDB,
		multiTenantSchedulerConcurrency: defaultMultiTenantSchedulerConcurrency(),
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(encoded), `{"source":"db","realtimeSignalsOrgConcurrency":4,`) {
		t.Fatalf("encoded=%s", encoded)
	}
	policy := rateLimitPolicy{Feature: "rss", UserLimit: 1, IPLimit: 2, WindowSeconds: 3, Enabled: true,
		CreatedAt: nestTime(time.Unix(0, 0)), UpdatedAt: nestTime(time.Unix(0, 0))}
	encoded, err = json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "description") {
		t.Fatalf("NULL description must be omitted: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"createdAt":"1970-01-01T00:00:00.000Z"`) {
		t.Fatalf("timestamp format: %s", encoded)
	}
}

// ---- helpers ----

func asHTTPError(err error, target **httpError) bool {
	coded, ok := err.(*httpError)
	if ok {
		*target = coded
	}
	return ok
}

// assertHTTPError requires err to be an httpError with the given status and
// message.
func assertHTTPError(t *testing.T, err error, status int, message string) {
	t.Helper()
	var coded *httpError
	if !asHTTPError(err, &coded) || coded.status != status || coded.message != message {
		t.Fatalf("err=%v want %d %q", err, status, message)
	}
}

// TestRateLimitBucketFallback locks the fallback semantics fixed in 502d5b74:
// an omitted bucket (or a cache payload without the key) keeps the raw,
// unclamped environment default, while a present bucket is coerced and clamped.
func TestRateLimitBucketFallback(t *testing.T) {
	service := &Service{cfg: Config{
		RateLimitLogin:                 5000,
		RateLimitLoginWindow:           60,
		RateLimitCrawlTaskCreate:       10,
		RateLimitCrawlTaskCreateWindow: 300,
		RateLimitRbacWrite:             20,
		RateLimitRbacWriteWindow:       600,
	}}
	fallback := service.fallbackRateLimitSettings()

	normalized := normalizeRequestSettings(rateLimitSettingsRequest{}, fallback)
	if normalized.Login.Limit != 5000 || normalized.Login.WindowSeconds != 60 {
		t.Fatalf("omitted bucket = %+v", normalized.Login)
	}

	present := &rateLimitBucketRequest{
		Limit:         json.RawMessage(`5000`),
		WindowSeconds: json.RawMessage(`999999`),
	}
	normalized = normalizeRequestSettings(rateLimitSettingsRequest{Login: present}, fallback)
	if normalized.Login.Limit != rateLimitMaxLimit || normalized.Login.WindowSeconds != rateLimitMaxWindowSeconds {
		t.Fatalf("present bucket = %+v", normalized.Login)
	}

	cached := cachedRateLimitSettings{Login: &rateLimitBucketConfig{Limit: 5000, WindowSeconds: 999999}}
	normalized = normalizeCachedSettings(cached, fallback)
	if normalized.Login.Limit != rateLimitMaxLimit || normalized.Login.WindowSeconds != rateLimitMaxWindowSeconds {
		t.Fatalf("cached bucket = %+v", normalized.Login)
	}
	if normalized.CrawlCreate.Limit != 10 || normalized.CrawlCreate.WindowSeconds != 300 {
		t.Fatalf("missing cached bucket = %+v", normalized.CrawlCreate)
	}

	if ttl := service.rateLimitSettingsCacheTTL(); ttl != 60 {
		t.Fatalf("default cache ttl = %d", ttl)
	}
	service.cfg.RateLimitSettingsCacheTTLSeconds = 120
	if ttl := service.rateLimitSettingsCacheTTL(); ttl != 120 {
		t.Fatalf("configured cache ttl = %d", ttl)
	}
}
