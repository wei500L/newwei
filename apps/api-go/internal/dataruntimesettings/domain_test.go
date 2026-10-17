package dataruntimesettings

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These tests are deliberately pure: they exercise the DTO conversion, the merge
// semantics, the encryption policy, the archive status mapping and the error
// mapping without a MySQL or Redis dependency, so they run in the ordinary CI go
// test job. The real-stack differential coverage lives in
// .github/workflows/api-go-data-runtime-settings-smoke.yml.

// testKeyHex is a valid 64 hex character SYSTEM_SETTINGS_ENCRYPTION_KEY.
const testKeyHex = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"

func testService(cfg Config) *Service { return NewService(nil, nil, cfg) }

func realtimeBaseConfig() Config {
	return Config{
		RealtimeEnabled:                  true,
		RealtimeRequestTimeoutMs:         12_000,
		RealtimeMaxRetries:               2,
		RealtimeOpenskyEnabled:           true,
		RealtimeOpenskyIntervalSec:       900,
		RealtimeOpenskyDailyCreditBudget: 4000,
		RealtimeOpenskyDayIntervalSec:    600,
		RealtimeOpenskyNightIntervalSec:  1800,
		RealtimeOpenskyDayStartHourHKT:   8,
		RealtimeOpenskyNightStartHourHKT: 22,
		RealtimeOpenskyWarningRemaining:  20,
		RealtimeOpenskyCriticalRemaining: 10,
		RealtimeOpenskyBaseURL:           "https://opensky-network.org/api",
		RealtimeOpenskyTokenURL:          "https://auth.opensky-network.org/token",
		RealtimeAisEnabled:               true,
		RealtimeAisIntervalSec:           600,
		RealtimeUnrestEnabled:            true,
		RealtimeUnrestIntervalSec:        600,
		RealtimeOutagesEnabled:           true,
		RealtimeOutagesIntervalSec:       600,
		RealtimeKeywordSpikeEnabled:      true,
		RealtimeKeywordSpikeIntervalSec:  600,
		RealtimePizzintEnabled:           true,
		RealtimePizzintIntervalSec:       600,
		RealtimeGdeltTensionEnabled:      true,
		RealtimeGdeltTensionIntervalSec:  600,
		RealtimePolymarketLeadsEnabled:   true,
		RealtimePolymarketIntervalSec:    600,
		RealtimeKeywordSpikeMinCount:     5,
		RealtimeKeywordSpikeMultiplier:   3,
		RealtimePredictionShiftThreshold: 5,
		RealtimePredictionNewsThreshold:  3,
		NominatimUserAgentDefault:        "modular-api",
	}
}

func mustParseRealtime(t *testing.T, body string) *realtimeSettingsUpdate {
	t.Helper()
	update, err := parseRealtimeSettingsUpdate([]byte(body))
	if err != nil {
		t.Fatalf("parse %s: %v", body, err)
	}
	return update
}

func messageOf(err error) string {
	var coded *httpError
	if errors.As(err, &coded) {
		return coded.message
	}
	return err.Error()
}

// ---- DTO conversion ----

func TestRealtimeDTORejectsNumericStrings(t *testing.T) {
	// The realtime DTO has no @Type(() => Number), so a numeric string fails.
	_, err := parseRealtimeSettingsUpdate([]byte(`{"requestTimeoutMs":"5000"}`))
	if err == nil {
		t.Fatal("expected a 400")
	}
	want := "requestTimeoutMs must not be greater than 120000; requestTimeoutMs must not be less than 1000; requestTimeoutMs must be an integer number"
	if messageOf(err) != want {
		t.Fatalf("message = %q, want %q", messageOf(err), want)
	}
}

func TestRealtimeDTOBooleanAndUnknownFieldMessages(t *testing.T) {
	_, err := parseRealtimeSettingsUpdate([]byte(`{"enabled":"true"}`))
	if messageOf(err) != "enabled must be a boolean value" {
		t.Fatalf("message = %q", messageOf(err))
	}

	_, err = parseRealtimeSettingsUpdate([]byte(`{"maxRetries":1,"extra":1}`))
	if messageOf(err) != "property extra should not exist" {
		t.Fatalf("message = %q", messageOf(err))
	}
}

func TestRealtimeDTOKeepsPropertyThenConstraintOrder(t *testing.T) {
	// Properties in declaration order; constraints inside one property in reverse
	// decorator order (Max, Min, IsInt), matching the verified NestJS output.
	_, err := parseRealtimeSettingsUpdate([]byte(`{"maxRetries":true,"enabled":1}`))
	want := "enabled must be a boolean value; maxRetries must not be greater than 6; " +
		"maxRetries must not be less than 0; maxRetries must be an integer number"
	if messageOf(err) != want {
		t.Fatalf("message = %q, want %q", messageOf(err), want)
	}
}

func TestRealtimeDTOUnknownFieldComesFirst(t *testing.T) {
	_, err := parseRealtimeSettingsUpdate([]byte(`{"enabled":"x","zzz":1}`))
	want := "property zzz should not exist; enabled must be a boolean value"
	if messageOf(err) != want {
		t.Fatalf("message = %q, want %q", messageOf(err), want)
	}
}

func TestRealtimeDTOMissingAndNullAreDistinct(t *testing.T) {
	update := mustParseRealtime(t, `{"requestTimeoutMs":null,"maxRetries":3}`)
	if update.RequestTimeoutMs.state != presenceNull {
		t.Fatalf("state = %v", update.RequestTimeoutMs.state)
	}
	if update.Enabled.state != presenceMissing {
		t.Fatalf("absent field state = %v", update.Enabled.state)
	}
	if update.MaxRetries.value != 3 {
		t.Fatalf("value = %v", update.MaxRetries.value)
	}
}

func TestRealtimeDTOAcceptsFractionalNumbers(t *testing.T) {
	update := mustParseRealtime(t, `{"keywordSpikeMultiplier":2.5}`)
	if update.KeywordSpikeMultiplier.value != 2.5 {
		t.Fatalf("value = %v", update.KeywordSpikeMultiplier.value)
	}
	_, err := parseRealtimeSettingsUpdate([]byte(`{"keywordSpikeMultiplier":101}`))
	if messageOf(err) != "keywordSpikeMultiplier must not be greater than 100" {
		t.Fatalf("message = %q", messageOf(err))
	}
}

func TestArchiveDTOConvertsNumericStringsButNotNull(t *testing.T) {
	// @Type(() => Number) turns "50" into 50, so a numeric string PASSES here.
	update, err := parseArchivePreparationUpdate([]byte(`{"jobBatchSize":"50","embeddingBatchSize":20,"embeddingMaxConcurrency":1,"rerankMaxConcurrency":1}`))
	if err != nil {
		t.Fatalf("numeric string must pass: %v", err)
	}
	if update.JobBatchSize != 50 {
		t.Fatalf("jobBatchSize = %d", update.JobBatchSize)
	}

	// class-transformer returns null unchanged, so null is NOT Number(null)===0.
	_, err = parseArchivePreparationUpdate([]byte(`{"jobBatchSize":null,"embeddingBatchSize":20,"embeddingMaxConcurrency":1,"rerankMaxConcurrency":1}`))
	want := "jobBatchSize must not be greater than 100; jobBatchSize must not be less than 1; jobBatchSize must be an integer number"
	if messageOf(err) != want {
		t.Fatalf("message = %q, want %q", messageOf(err), want)
	}

	// An empty string IS Number("") === 0, which only violates Min.
	_, err = parseArchivePreparationUpdate([]byte(`{"jobBatchSize":"","embeddingBatchSize":20,"embeddingMaxConcurrency":1,"rerankMaxConcurrency":1}`))
	if messageOf(err) != "jobBatchSize must not be less than 1" {
		t.Fatalf("message = %q", messageOf(err))
	}

	// true is Number(true) === 1 and therefore valid.
	if _, err := parseArchivePreparationUpdate([]byte(`{"jobBatchSize":true,"embeddingBatchSize":20,"embeddingMaxConcurrency":1,"rerankMaxConcurrency":1}`)); err != nil {
		t.Fatalf("true must coerce to 1: %v", err)
	}

	// Any array member stays an array and is never a number.
	_, err = parseArchivePreparationUpdate([]byte(`{"jobBatchSize":[50],"embeddingBatchSize":20,"embeddingMaxConcurrency":1,"rerankMaxConcurrency":1}`))
	if messageOf(err) != want {
		t.Fatalf("array message = %q, want %q", messageOf(err), want)
	}
}

func TestArchiveDTORequiresAllFourFields(t *testing.T) {
	_, err := parseArchivePreparationUpdate([]byte(`{}`))
	want := "jobBatchSize must not be greater than 100; jobBatchSize must not be less than 1; jobBatchSize must be an integer number; " +
		"embeddingBatchSize must not be greater than 100; embeddingBatchSize must not be less than 1; embeddingBatchSize must be an integer number; " +
		"embeddingMaxConcurrency must not be greater than 8; embeddingMaxConcurrency must not be less than 1; embeddingMaxConcurrency must be an integer number; " +
		"rerankMaxConcurrency must not be greater than 8; rerankMaxConcurrency must not be less than 1; rerankMaxConcurrency must be an integer number"
	if messageOf(err) != want {
		t.Fatalf("message = %q, want %q", messageOf(err), want)
	}
}

func TestNominatimDTOMinLengthAndEmailOrder(t *testing.T) {
	// MinLength is applied before IsString (reverse decorator order) and "" is
	// rejected.
	_, err := parseNominatimUpdate([]byte(`{"userAgent":""}`))
	if messageOf(err) != "userAgent must be longer than or equal to 1 characters" {
		t.Fatalf("empty userAgent: %q", messageOf(err))
	}

	_, err = parseNominatimUpdate([]byte(`{"email":"not-an-email"}`))
	if messageOf(err) != "email must be an email" {
		t.Fatalf("invalid email: %q", messageOf(err))
	}

	_, err = parseNominatimUpdate([]byte(`{"email":5}`))
	if messageOf(err) != "email must be an email; email must be a string" {
		t.Fatalf("non-string email: %q", messageOf(err))
	}

	update, err := parseNominatimUpdate([]byte(`{"userAgent":"   ","email":null}`))
	if err != nil {
		t.Fatalf("whitespace userAgent must pass the DTO: %v", err)
	}
	if update.UserAgent.state != presenceValue || update.UserAgent.value != "   " {
		t.Fatalf("userAgent = %+v", update.UserAgent)
	}
	if update.Email.state != presenceNull {
		t.Fatalf("email state = %v", update.Email.state)
	}
}

func TestRealtimeDTOFieldOrderMatchesAuditConstant(t *testing.T) {
	want := []string{
		"enabled", "requestTimeoutMs", "maxRetries", "openskyEnabled", "adsbEnabled",
		"openskyIntervalSec", "openskyDailyCreditBudget", "openskyDayIntervalSec",
		"openskyNightIntervalSec", "openskyDayStartHourHkt", "openskyNightStartHourHkt",
		"openskyWarningRemainingPct", "openskyCriticalRemainingPct", "adsbIntervalSec",
		"aisEnabled", "aisIntervalSec", "unrestEnabled", "unrestIntervalSec",
		"outagesEnabled", "outagesIntervalSec", "keywordSpikeEnabled",
		"keywordSpikeIntervalSec", "pizzintEnabled", "pizzintIntervalSec",
		"gdeltTensionEnabled", "gdeltTensionIntervalSec", "polymarketLeadsEnabled",
		"polymarketLeadsIntervalSec", "keywordSpikeMinCount", "keywordSpikeMultiplier",
		"predictionShiftThreshold", "predictionNewsActivityThreshold", "openskyBaseUrl",
		"adsbBaseUrl", "openskyTokenUrl", "aisRelayBaseUrl", "relayBaseUrl",
		"openskyClientId", "openskyClientSecret", "aisRelaySharedSecret",
		"relaySharedSecret", "acledOauthUsername", "acledOauthPassword",
		"acledOauthClientId", "cloudflareApiToken", "wingbitsApiKey",
		"polymarketProxyUrl",
	}
	if len(realtimeDTOFieldOrder) != len(want) {
		t.Fatalf("len = %d, want %d", len(realtimeDTOFieldOrder), len(want))
	}
	for index, name := range want {
		if realtimeDTOFieldOrder[index] != name {
			t.Fatalf("field %d = %q, want %q", index, realtimeDTOFieldOrder[index], name)
		}
	}
}

// ---- merge semantics ----

func TestNullishCoalescingAliases(t *testing.T) {
	// A null canonical value falls through to the alias; an absent alias leaves
	// the result missing (undefined), which is NOT the same as an explicit null.
	got := coalesceString(optionalString{state: presenceNull}, optionalString{state: presenceMissing})
	if got.state != presenceMissing {
		t.Fatalf("null ?? missing = %v", got.state)
	}
	got = coalesceString(optionalString{state: presenceValue, value: "a"}, optionalString{state: presenceValue, value: "b"})
	if got.value != "a" {
		t.Fatalf("value ?? value = %q", got.value)
	}
	got = coalesceNumber(optionalNumber{state: presenceNull}, optionalNumber{state: presenceValue, value: 7})
	if got.value != 7 {
		t.Fatalf("null ?? 7 = %v", got.value)
	}
	gotBool := coalesceBool(optionalBool{state: presenceValue, value: false}, optionalBool{state: presenceValue, value: true})
	if gotBool.value {
		t.Fatalf("false ?? true = %v", gotBool.value)
	}
}

func TestRawCoalescePreservesFalsyRawValues(t *testing.T) {
	if got := rawCoalesce(json.RawMessage("false"), json.RawMessage("true")); string(got) != "false" {
		t.Fatalf("false ?? true = %s", got)
	}
	if got := rawCoalesce(json.RawMessage("null"), json.RawMessage(`"x"`)); string(got) != `"x"` {
		t.Fatalf("null ?? x = %s", got)
	}
	if got := rawCoalesce(nil, json.RawMessage("0")); string(got) != "0" {
		t.Fatalf("missing ?? 0 = %s", got)
	}
}

func TestMergeTreatsNullNumericAsLowerBound(t *testing.T) {
	service := testService(realtimeBaseConfig())
	update := mustParseRealtime(t, `{"requestTimeoutMs":null,"maxRetries":null}`)
	effective, err := service.resolveEffectiveSettings(nil)
	if err != nil {
		t.Fatal(err)
	}
	next, err := service.mergeRealtimeSettings(context.Background(), update, effective, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Number(null) === 0 -> clamped up to the lower bound.
	if next.RequestTimeoutMs != 1_000 {
		t.Fatalf("requestTimeoutMs = %d", next.RequestTimeoutMs)
	}
	if next.MaxRetries != 0 {
		t.Fatalf("maxRetries = %d", next.MaxRetries)
	}
	// Untouched fields keep the effective value.
	if next.OpenskyIntervalSec != 900 {
		t.Fatalf("openskyIntervalSec = %d", next.OpenskyIntervalSec)
	}
}

func TestMergeAliasNullKeepsStoredCanonicalURL(t *testing.T) {
	service := testService(realtimeBaseConfig())
	stored := parseStoredRealtimeSettings(json.RawMessage(`{"openskyBaseUrl":"https://db.example/base"}`))
	effective, err := service.resolveEffectiveSettings(stored)
	if err != nil {
		t.Fatal(err)
	}

	// canonical null + absent legacy alias -> `null ?? undefined` is undefined,
	// so the stored value is preserved.
	update := mustParseRealtime(t, `{"openskyBaseUrl":null}`)
	next, err := service.mergeRealtimeSettings(context.Background(), update, effective, stored)
	if err != nil {
		t.Fatal(err)
	}
	if next.OpenskyBaseURL == nil || *next.OpenskyBaseURL != "https://db.example/base" {
		t.Fatalf("openskyBaseUrl = %v", next.OpenskyBaseURL)
	}

	// canonical null + legacy alias null -> `null ?? null` is null -> cleared.
	update = mustParseRealtime(t, `{"openskyBaseUrl":null,"adsbBaseUrl":null}`)
	next, err = service.mergeRealtimeSettings(context.Background(), update, effective, stored)
	if err != nil {
		t.Fatal(err)
	}
	if next.OpenskyBaseURL != nil {
		t.Fatalf("openskyBaseUrl = %v, want nil", *next.OpenskyBaseURL)
	}
}

func TestMergeKeepsUnmodifiedCiphertextByteIdentical(t *testing.T) {
	cfg := realtimeBaseConfig()
	cfg.EncryptionKeyRaw = testKeyHex
	cfg.EncryptionKeyPresent = true
	service := testService(cfg)

	storedRaw := json.RawMessage(`{"openskyClientSecret":{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"aXY=","tag":"dGFn","data":"ZGF0YQ=="},"maxRetries":1}`)
	stored := parseStoredRealtimeSettings(storedRaw)
	effective, err := service.resolveEffectiveSettings(stored)
	if err != nil {
		t.Fatal(err)
	}
	// The stored envelope cannot be decrypted with the test key, so the effective
	// secret falls back to the environment (empty here) — the merge base is still
	// the raw ciphertext.
	update := mustParseRealtime(t, `{"maxRetries":3}`)
	next, err := service.mergeRealtimeSettings(context.Background(), update, effective, stored)
	if err != nil {
		t.Fatal(err)
	}
	if string(next.OpenskyClientSecret) != `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"aXY=","tag":"dGFn","data":"ZGF0YQ=="}` {
		t.Fatalf("ciphertext changed: %s", next.OpenskyClientSecret)
	}
	if next.MaxRetries != 3 {
		t.Fatalf("maxRetries = %d", next.MaxRetries)
	}
}

func TestMergeEncryptsNewSecretAndClearsOnNull(t *testing.T) {
	cfg := realtimeBaseConfig()
	cfg.EncryptionKeyRaw = testKeyHex
	cfg.EncryptionKeyPresent = true
	service := testService(cfg)
	effective, err := service.resolveEffectiveSettings(nil)
	if err != nil {
		t.Fatal(err)
	}

	update := mustParseRealtime(t, `{"openskyClientSecret":"  s3cret  "}`)
	next, err := service.mergeRealtimeSettings(context.Background(), update, effective, nil)
	if err != nil {
		t.Fatal(err)
	}
	var envelope encryptedStringValueV1
	if err := json.Unmarshal(next.OpenskyClientSecret, &envelope); err != nil {
		t.Fatalf("expected an envelope: %s", next.OpenskyClientSecret)
	}
	if !envelope.valid() {
		t.Fatalf("invalid envelope: %+v", envelope)
	}
	key, err := decodeSystemSettingsKey(testKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := decryptStringValueV1(envelope, key)
	if err != nil {
		t.Fatal(err)
	}
	if plain != "s3cret" {
		t.Fatalf("plaintext = %q", plain)
	}
	// The written document is a fresh IV every time.
	again, err := service.mergeRealtimeSettings(context.Background(), update, effective, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(again.OpenskyClientSecret) == string(next.OpenskyClientSecret) {
		t.Fatal("a new secret must not reuse the previous IV")
	}

	cleared := mustParseRealtime(t, `{"openskyClientSecret":null}`)
	next, err = service.mergeRealtimeSettings(context.Background(), cleared, effective, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(next.OpenskyClientSecret) != "null" {
		t.Fatalf("openskyClientSecret = %s, want null", next.OpenskyClientSecret)
	}
	// The historical ACLED token is written as JSON null, and relayBaseUrl /
	// relaySharedSecret are dropped from the document entirely.
	if string(next.AcledAccessToken) != "null" {
		t.Fatalf("acledAccessToken = %s", next.AcledAccessToken)
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "relayBaseUrl") || strings.Contains(string(encoded), "relaySharedSecret") {
		t.Fatalf("legacy aliases must not be written: %s", encoded)
	}
}

func TestCrossFieldRelationsUseExactMessages(t *testing.T) {
	cases := []struct {
		name  string
		build func() (*writtenRealtimeSettings, error)
		want  string
	}{
		{
			name: "budget",
			build: func() (*writtenRealtimeSettings, error) {
				return nil, validateOpenskyBudgetRelations(0, 600, 1800, 8, 22, 20, 10)
			},
			want: "openskyDailyCreditBudget must be greater than 0",
		},
		{
			name: "day start",
			build: func() (*writtenRealtimeSettings, error) {
				return nil, validateOpenskyBudgetRelations(4000, 600, 1800, 22, 8, 20, 10)
			},
			want: "openskyDayStartHourHkt must be earlier than openskyNightStartHourHkt",
		},
		{
			name: "critical",
			build: func() (*writtenRealtimeSettings, error) {
				return nil, validateOpenskyBudgetRelations(4000, 600, 1800, 8, 22, 20, 20)
			},
			want: "openskyCriticalRemainingPct must be lower than openskyWarningRemainingPct",
		},
		{
			name: "day interval",
			build: func() (*writtenRealtimeSettings, error) {
				return nil, validateOpenskyBudgetRelations(4000, 1800, 600, 8, 22, 20, 10)
			},
			want: "openskyDayIntervalSec must be less than or equal to openskyNightIntervalSec",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := testCase.build()
			if err == nil || messageOf(err) != testCase.want {
				t.Fatalf("err = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestStoredValueCoercionMatchesJavaScript(t *testing.T) {
	if got := asBoundedIntRaw(json.RawMessage(`"35"`), 20, 1, 100); got != 35 {
		t.Fatalf(`"35" = %d`, got)
	}
	if got := asBoundedIntRaw(json.RawMessage(`1.6`), 20, 1, 100); got != 1 {
		t.Fatalf("1.6 = %d (Math.trunc)", got)
	}
	if got := asBoundedIntRaw(json.RawMessage(`null`), 20, 1, 100); got != 1 {
		t.Fatalf("null = %d", got)
	}
	if got := asBoundedIntRaw(nil, 20, 1, 100); got != 20 {
		t.Fatalf("absent = %d", got)
	}
	if got := asBoundedIntRaw(json.RawMessage(`{}`), 20, 1, 100); got != 20 {
		t.Fatalf("object = %d (Number({}) is NaN)", got)
	}
	if got := asBoundedIntRaw(json.RawMessage(`99999`), 20, 1, 100); got != 100 {
		t.Fatalf("clamped = %d", got)
	}
	if got := asBoundedNumberRawOptional(json.RawMessage(`2.5`), 3, 1, 100); got != 2.5 {
		t.Fatalf("float = %v", got)
	}
}

func TestArchiveNormalizationRoundsAndClamps(t *testing.T) {
	settings := normalizeArchivePreparation(&storedArchivePreparationSettings{
		JobBatchSize:            json.RawMessage(`20.5`),
		EmbeddingBatchSize:      json.RawMessage(`100.4`),
		EmbeddingMaxConcurrency: json.RawMessage(`"3"`),
		RerankMaxConcurrency:    json.RawMessage(`null`),
	})
	if settings.JobBatchSize != 21 || settings.EmbeddingBatchSize != 100 ||
		settings.EmbeddingMaxConcurrency != 3 || settings.RerankMaxConcurrency != 1 {
		t.Fatalf("settings = %+v", settings)
	}

	fallback := normalizeArchivePreparation(&storedArchivePreparationSettings{
		JobBatchSize: json.RawMessage(`"abc"`),
	})
	if fallback.JobBatchSize != 20 {
		t.Fatalf("non-finite must fall back: %+v", fallback)
	}
}

func TestArchiveSourceUsesJavaScriptTruthiness(t *testing.T) {
	if !jsTruthy(json.RawMessage(`{}`)) || !jsTruthy(json.RawMessage(`[]`)) {
		t.Fatal("an object and an array are truthy")
	}
	for _, falsy := range []string{`null`, `false`, `0`, `""`} {
		if jsTruthy(json.RawMessage(falsy)) {
			t.Fatalf("%s must be falsy", falsy)
		}
	}
	for _, truthy := range []string{`true`, `1`, `"x"`} {
		if !jsTruthy(json.RawMessage(truthy)) {
			t.Fatalf("%s must be truthy", truthy)
		}
	}
}

// ---- archive status ----

func TestSelectScopedStatusRecordsFiltersAndOrders(t *testing.T) {
	key := func(scope, org, value string) string {
		return "archive:preparation:status:" + scope + ":" + org + ":" + value
	}
	keys := []string{
		key("digest", "org-a", "oldest"),
		key("digest", "org-b", "foreign"),
		key("digest", "org-a", "expired"),
		key("digest", "org-a", "newest"),
	}
	values := []json.RawMessage{
		json.RawMessage(`{"orgId":"org-a","scope":"digest","scopeValue":"oldest","state":"READY","updatedAt":"2026-01-01T00:00:00.000Z"}`),
		json.RawMessage(`{"orgId":"org-b","scope":"digest","scopeValue":"foreign","state":"READY","updatedAt":"2026-01-02T00:00:00.000Z"}`),
		nil,
		json.RawMessage(`{"orgId":"org-a","scope":"digest","scopeValue":"newest","state":"PROCESSING","updatedAt":"2026-01-03T00:00:00.000Z"}`),
	}

	records := selectScopedStatusRecords(keys, values, "org-a")
	if len(records) != 2 {
		t.Fatalf("records = %d, want 2", len(records))
	}
	// Newest first, and the expired member is skipped.
	if normalizeStringRaw(records[0].ScopeValueRaw) != "newest" || normalizeStringRaw(records[1].ScopeValueRaw) != "oldest" {
		t.Fatalf("order = %v", records)
	}
	counts := countStatusStates(records)
	if counts.Completed != 1 || counts.Active != 1 {
		t.Fatalf("counts = %+v", counts)
	}
}

func TestSelectScopedStatusRecordsRecoversLegacyOrgID(t *testing.T) {
	legacyKey := "archive:preparation:status:digest:org-a:legacy"
	values := []json.RawMessage{
		json.RawMessage(`{"scope":"digest","scopeValue":"legacy","state":"READY","updatedAt":"2026-01-01T00:00:00.000Z"}`),
	}
	if records := selectScopedStatusRecords([]string{legacyKey}, values, "org-a"); len(records) != 1 {
		t.Fatalf("legacy record must be recovered for org-a: %v", records)
	}
	if records := selectScopedStatusRecords([]string{legacyKey}, values, "org-b"); len(records) != 0 {
		t.Fatalf("legacy record must not leak to org-b: %v", records)
	}
	// A record with neither an orgId member nor a long enough key is dropped.
	if records := selectScopedStatusRecords([]string{"too:short"}, values, "org-a"); len(records) != 0 {
		t.Fatalf("unrecoverable org id must be dropped: %v", records)
	}
}

func TestCountStatusStatesMapping(t *testing.T) {
	state := func(value string) storedArchiveStatusRecord {
		return storedArchiveStatusRecord{state: ArchivePreparationState(value)}
	}
	counts := countStatusStates([]storedArchiveStatusRecord{
		state("QUEUED"),
		state("PROCESSING"),
		state("PARTIAL"),
		state("READY"),
		state("FAILED"),
		state("IDLE"),
		state("SOMETHING_ELSE"),
	})
	want := archiveStatusCounts{Waiting: 1, Active: 2, Completed: 1, Failed: 1, Delayed: 0}
	if counts != want {
		t.Fatalf("counts = %+v, want %+v", counts, want)
	}
}

func TestPublicStatusRecordRedactsAndPreservesNullSemantics(t *testing.T) {
	message := "call failed: Bearer tok.abc-1 password=pw token=t1 api_key=k1 secret=s1"
	record := storedArchiveStatusRecord{
		ScopeRaw:        json.RawMessage(`"digest"`),
		ScopeValueRaw:   json.RawMessage(`"v"`),
		StateRaw:        json.RawMessage(`"FAILED"`),
		UpdatedAtRaw:    json.RawMessage(`"2026-01-01T00:00:00.000Z"`),
		ErrorMessageRaw: json.RawMessage(strconvQuote(message)),
		state:           ArchiveStateFailed,
	}
	public := toPublicStatusRecord(record)
	var redacted string
	if err := json.Unmarshal(public.ErrorMessage, &redacted); err != nil {
		t.Fatal(err)
	}
	want := "call failed: Bearer [REDACTED] password=[REDACTED] token=[REDACTED] api_key=[REDACTED] secret=[REDACTED]"
	if redacted != want {
		t.Fatalf("redacted = %q, want %q", redacted, want)
	}

	// An empty message stays ""; a missing message becomes the JSON literal null.
	empty := toPublicStatusRecord(storedArchiveStatusRecord{ErrorMessageRaw: json.RawMessage(`""`)})
	if string(empty.ErrorMessage) != `""` {
		t.Fatalf("empty = %s", empty.ErrorMessage)
	}
	missing := toPublicStatusRecord(storedArchiveStatusRecord{})
	if string(missing.ErrorMessage) != "null" {
		t.Fatalf("missing = %s", missing.ErrorMessage)
	}
	// The public record never carries the organisation or the Redis key.
	encoded, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"orgId", "org-a", "archive:preparation:status"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("public record leaks %q: %s", forbidden, encoded)
		}
	}
}

// ---- crypto ----

func TestSecretEncodingPolicy(t *testing.T) {
	// Non-production without a key falls back to plaintext.
	service := testService(Config{NodeEnv: "development"})
	resolved, err := service.encodeSecretForStorage(context.Background(), "plain")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.plaintext != "plain" || resolved.encrypted != nil {
		t.Fatalf("resolved = %+v", resolved)
	}

	// Production without a key is a 400 with the exact message.
	service = testService(Config{NodeEnv: "production"})
	if _, err := service.encodeSecretForStorage(context.Background(), "plain"); err == nil ||
		messageOf(err) != "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production" {
		t.Fatalf("err = %v", err)
	}

	// A valid key encrypts.
	service = testService(Config{NodeEnv: "production", EncryptionKeyRaw: testKeyHex, EncryptionKeyPresent: true})
	resolved, err = service.encodeSecretForStorage(context.Background(), "plain")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.encrypted == nil || !resolved.encrypted.valid() {
		t.Fatalf("resolved = %+v", resolved)
	}
}

func TestDecodeSystemSettingsKeyAcceptsHexAndBase64(t *testing.T) {
	key, err := decodeSystemSettingsKey("0x" + testKeyHex)
	if err != nil || len(key) != 32 {
		t.Fatalf("0x-prefixed hex: %v", err)
	}
	base64Key := base64Of(key)
	decoded, err := decodeSystemSettingsKey(base64Key)
	if err != nil || string(decoded) != string(key) {
		t.Fatalf("base64: %v", err)
	}
	if _, err := decodeSystemSettingsKey("nope"); err == nil {
		t.Fatal("an invalid key must fail")
	}
	if _, err := decodeSystemSettingsKey(""); err == nil {
		t.Fatal("an empty key must fail")
	}
}

func TestEnvelopeRoundTripAcrossImplementations(t *testing.T) {
	key, err := decodeSystemSettingsKey(testKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := encryptStringValueV1("cross-implementation", key)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := envelope.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	var decoded encryptedStringValueV1
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	plain, err := decryptStringValueV1(decoded, key)
	if err != nil || plain != "cross-implementation" {
		t.Fatalf("plain = %q, err = %v", plain, err)
	}
}

// ---- URL normalization ----

func TestValidateHTTPURLNormalizesLikeWHATWG(t *testing.T) {
	got, err := validateHTTPURL("HTTP://Proxy.Example:80/Path/", "openskyBaseUrl")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://proxy.example/Path" {
		t.Fatalf("got %q", got)
	}
	got, err = validateHTTPURL("https://example.com:443", "openskyBaseUrl")
	if err != nil || got != "https://example.com" {
		t.Fatalf("got %q, err %v", got, err)
	}
	for _, invalid := range []string{"ftp://example.com", "not-a-url", "http://"} {
		_, err := validateHTTPURL(invalid, "openskyBaseUrl")
		if err == nil || messageOf(err) != "openskyBaseUrl must be a valid http(s) URL" {
			t.Fatalf("%s: err = %v", invalid, err)
		}
	}
}

// ---- error mapping ----

func TestWriteServiceErrorMapsLockFailures(t *testing.T) {
	busy := &httpError{status: http.StatusConflict, message: realtimeLockBusyMessage}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, pathRealtime, nil)
	writeServiceError(recorder, request, busy)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d", recorder.Code)
	}
	body := decodeErrorBody(t, recorder)
	if body.Message != realtimeLockBusyMessage || body.Error != "Conflict" {
		t.Fatalf("body = %v", body)
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPut, pathRealtime, nil)
	writeServiceError(recorder, request, errLockUnavailable)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", recorder.Code)
	}
	body = decodeErrorBody(t, recorder)
	if body.Message != "Internal server error" || body.Error != "Service Unavailable" {
		t.Fatalf("body = %v", body)
	}
	// The lock name and the connection details never reach the response.
	if strings.Contains(recorder.Body.String(), "GET_LOCK") || strings.Contains(recorder.Body.String(), lockRealtime) {
		t.Fatalf("body leaks lock details: %s", recorder.Body.String())
	}
}

func TestWriteServiceErrorMapsPlatformGateAndValidation(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, pathRealtime, nil)
	writeServiceError(recorder, request, &httpError{status: http.StatusForbidden, message: "Platform admin access required"})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d", recorder.Code)
	}
	if decodeErrorBody(t, recorder).Message != "Platform admin access required" {
		t.Fatalf("body = %s", recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPut, pathRealtime, nil)
	writeServiceError(recorder, request, &httpError{status: http.StatusBadRequest, message: "enabled must be a boolean value"})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}
	if decodeErrorBody(t, recorder).Error != "Bad Request" {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

// ---- helpers ----

// errorEnvelope is the decoded GlobalExceptionFilter shape. A named struct is
// used instead of a loose map so the assertions stay typed.
type errorEnvelope struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

func decodeErrorBody(t *testing.T, recorder *httptest.ResponseRecorder) errorEnvelope {
	t.Helper()
	var body errorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
	return body
}

func strconvQuote(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}

func base64Of(value []byte) string {
	return base64.StdEncoding.EncodeToString(value)
}
