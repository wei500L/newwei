package platformgovernance

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math"
	"strconv"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestJSStringToNumberBranches(t *testing.T) {
	for _, raw := range []string{"nan", "inf", "1_000", "0x1p3", "0x", "1,5", "12 3", "0x1g", "--1"} {
		if got := jsStringToNumber(raw); !math.IsNaN(got) {
			t.Errorf("jsStringToNumber(%q) = %v, want NaN", raw, got)
		}
	}
	if got := jsStringToNumber("Infinity"); !math.IsInf(got, 1) {
		t.Errorf("jsStringToNumber(Infinity) = %v, want +Inf", got)
	}
	if got := jsStringToNumber("INFINITY"); !math.IsInf(got, 1) {
		t.Errorf("jsStringToNumber(INFINITY) = %v, want +Inf", got)
	}
	if got := jsStringToNumber("-Infinity"); !math.IsInf(got, -1) {
		t.Errorf("jsStringToNumber(-Infinity) = %v, want -Inf", got)
	}
	for _, tc := range []struct {
		raw  string
		want float64
	}{
		{"", 0},
		{"   ", 0},
		{"\u00a0\u3000", 0},
		{"30", 30},
		{" 30 ", 30},
		{"+30", 30},
		{"-30", -30},
		{".5", 0.5},
		{"5.", 5},
		{"1e3", 1000},
		{"1E+3", 1000},
		{"0x1f", 31},
		{"0X1F", 31},
		{"0o17", 15},
		{"0b101", 5},
	} {
		if got := jsStringToNumber(tc.raw); got != tc.want {
			t.Errorf("jsStringToNumber(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestJSNumberishBranches(t *testing.T) {
	type envelope struct {
		Value jsNumberish `json:"value"`
	}
	decode := func(body string) jsNumberish {
		t.Helper()
		var decoded envelope
		if err := json.Unmarshal([]byte(body), &decoded); err != nil {
			t.Fatalf("decode %q: %v", body, err)
		}
		return decoded.Value
	}

	// The zero value is absent and therefore NaN.
	if got := (jsNumberish{}).Number(); !math.IsNaN(got) {
		t.Errorf("absent field = %v, want NaN", got)
	}
	for _, body := range []string{
		`{}`,
		`{"value":{}}`,
		`{"value":{"nested":1}}`,
		`{"value":["1","2"]}`,
		`{"value":["a","b"]}`,
	} {
		if got := decode(body).Number(); !math.IsNaN(got) {
			t.Errorf("Number(%s) = %v, want NaN", body, got)
		}
	}
	for _, tc := range []struct {
		body string
		want float64
	}{
		{`{"value":7}`, 7},
		{`{"value":"7"}`, 7},
		{`{"value":true}`, 1},
		{`{"value":false}`, 0},
		// Number(null) === 0: an explicit null is present and coerces to zero,
		// unlike an absent field which stays NaN.
		{`{"value":null}`, 0},
		{`{"value":[]}`, 0},
		{`{"value":[7]}`, 7},
		{`{"value":["7"]}`, 7},
		{`{"value":[[7]]}`, 7},
		{`{"value":"0x10"}`, 16},
	} {
		if got := decode(tc.body).Number(); got != tc.want {
			t.Errorf("Number(%s) = %v, want %v", tc.body, got, tc.want)
		}
	}
	// Number([true]) === Number("true") === NaN: the element goes through
	// String() first, unlike a bare boolean field.
	if got := decode(`{"value":[true]}`).Number(); !math.IsNaN(got) {
		t.Errorf("Number([true]) = %v, want NaN", got)
	}
}

func TestJSToFixed4RoundsHalfUp(t *testing.T) {
	for _, tc := range []struct {
		value float64
		want  float64
	}{
		// 0.03125 is exactly representable, so the tie rule is unambiguous:
		// ECMAScript picks the larger of the two nearest 1/10^4 multiples.
		{0.03125, 0.0313},
		{-0.03125, -0.0312},
		{0, 0},
		{1, 1},
		{0.5, 0.5},
		{0.0625, 0.0625},
		{0.03124999, 0.0312},
	} {
		if got := jsToFixed4(tc.value); got != tc.want {
			t.Errorf("jsToFixed4(%v) = %v, want %v", tc.value, got, tc.want)
		}
	}
	if got := jsToFixed4(math.NaN()); !math.IsNaN(got) {
		t.Errorf("jsToFixed4(NaN) = %v, want NaN", got)
	}
	if got := jsToFixed4(math.Inf(1)); !math.IsInf(got, 1) {
		t.Errorf("jsToFixed4(+Inf) = %v, want +Inf", got)
	}
}

func TestJSToFixed4MatchesHalfUpNotHalfEven(t *testing.T) {
	// round-half-even would return 0.0312 for this input; JavaScript returns
	// 0.0313. This is the assertion that keeps strconv.FormatFloat out.
	if got := jsToFixed4(0.03125); got != 0.0313 {
		t.Fatalf("jsToFixed4(0.03125) = %v, want 0.0313 (half even would give 0.0312)", got)
	}
}

func TestResolveEncryptionKeyHexForms(t *testing.T) {
	key := bytes.Repeat([]byte{0x2a}, 32)
	hexValue := hex.EncodeToString(key)
	decoded, errText := resolveEncryptionKey(hexValue)
	if errText != "" || !bytes.Equal(decoded, key) {
		t.Fatalf("hex key: err=%q decoded=%x", errText, decoded)
	}
	decoded, errText = resolveEncryptionKey("0x" + hexValue)
	if errText != "" || !bytes.Equal(decoded, key) {
		t.Fatalf("0x hex key: err=%q decoded=%x", errText, decoded)
	}
	decoded, errText = resolveEncryptionKey("0X" + hexValue)
	if errText != "" || !bytes.Equal(decoded, key) {
		t.Fatalf("0X hex key: err=%q decoded=%x", errText, decoded)
	}
	// 63 and 65 hex characters are not the 64 character form and are not valid
	// base64 either.
	if _, errText = resolveEncryptionKey(hexValue[:63]); errText == "" {
		t.Error("63 hex chars should be rejected")
	}
}

func TestResolveEncryptionKeyBase64Forms(t *testing.T) {
	// 0xfb yields base64 characters from the last two sextet positions, so the
	// standard and URL-safe alphabets genuinely differ for this key.
	key := bytes.Repeat([]byte{0xfb}, 32)
	standard := base64.StdEncoding.EncodeToString(key)
	urlSafe := base64.URLEncoding.EncodeToString(key)
	if standard == urlSafe {
		t.Fatal("test precondition: the two encodings must differ")
	}
	for _, value := range []string{standard, urlSafe} {
		decoded, errText := resolveEncryptionKey(value)
		if errText != "" || !bytes.Equal(decoded, key) {
			t.Fatalf("base64 %q: err=%q decoded=%x", value, errText, decoded)
		}
	}
	// Whitespace and other non-base64 characters are ignored, exactly like
	// Buffer.from(s, "base64").
	padded := " \t" + standard[:10] + "\n" + standard[10:20] + " ! " + standard[20:]
	decoded, errText := resolveEncryptionKey(padded)
	if errText != "" || !bytes.Equal(decoded, key) {
		t.Fatalf("whitespace-laden base64: err=%q decoded=%x", errText, decoded)
	}
}

func TestResolveEncryptionKeyRejectsWrongLengths(t *testing.T) {
	short := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x01}, 16))
	if _, errText := resolveEncryptionKey(short); errText != "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars" {
		t.Fatalf("short key err = %q", errText)
	}
	long := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x01}, 33))
	if _, errText := resolveEncryptionKey(long); errText == "" {
		t.Fatal("33 byte key should be rejected")
	}
	if _, errText := resolveEncryptionKey("   "); errText != "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty" {
		t.Fatalf("blank key err = %q", errText)
	}
}

func TestEncryptionKeyStatusPresentAndValid(t *testing.T) {
	absent := (&Service{env: Env{}}).encryptionKeyStatus()
	if absent.present || absent.valid || absent.errText != "" {
		t.Fatalf("absent key = %+v", absent)
	}
	blank := (&Service{env: Env{EncryptionKeyRaw: "  "}}).encryptionKeyStatus()
	if !blank.present || blank.valid || blank.errText != "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty" {
		t.Fatalf("blank key = %+v", blank)
	}
	valid := (&Service{env: Env{EncryptionKeyRaw: hex.EncodeToString(bytes.Repeat([]byte{0x01}, 32))}}).encryptionKeyStatus()
	if !valid.present || !valid.valid || len(valid.key) != 32 {
		t.Fatalf("valid key = %+v", valid)
	}
}

func TestBuildSafetyEffectiveDerivesGuardrails(t *testing.T) {
	for _, tc := range []struct {
		enabled            bool
		outputModeration   bool
		wantEnabled        bool
		wantOutput         bool
		wantGuardrailCount int
	}{
		{true, false, true, false, 1},
		{true, true, true, true, 2},
		{false, false, false, false, 0},
		{false, true, false, true, 0},
	} {
		got := buildSafetyEffective(tc.enabled, tc.outputModeration)
		if got.Enabled != tc.wantEnabled || got.OutputModerationEnabled != tc.wantOutput {
			t.Fatalf("buildSafetyEffective(%v,%v) = %+v", tc.enabled, tc.outputModeration, got)
		}
		if len(got.Guardrails) != tc.wantGuardrailCount {
			t.Fatalf("buildSafetyEffective(%v,%v) guardrails = %v", tc.enabled, tc.outputModeration, got.Guardrails)
		}
		if tc.wantEnabled && got.Guardrails[0] != assistantSafetyGuardrailPre {
			t.Fatalf("first guardrail = %q", got.Guardrails[0])
		}
		if tc.wantGuardrailCount == 2 && got.Guardrails[1] != assistantSafetyGuardrailPost {
			t.Fatalf("second guardrail = %q", got.Guardrails[1])
		}
	}
}

func TestSafetyEnvironmentOutputModeration(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{"openai-moderation-pre", false},
		{"openai-moderation-pre,openai-moderation-post", true},
		{" openai-moderation-pre , openai-moderation-post ", true},
		{"", false},
		{",,", false},
		{"openai-moderation-post-x", false},
	} {
		svc := &Service{env: Env{AssistantGuardrails: tc.raw}}
		if got := svc.safetyEnvironmentOutputModeration(); got != tc.want {
			t.Errorf("guardrails %q = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestCoerceLimit(t *testing.T) {
	for _, tc := range []struct {
		value    float64
		fallback int64
		max      int64
		want     int64
	}{
		{math.NaN(), 30, 10_000, 30},
		{math.Inf(1), 30, 10_000, 30},
		{math.Inf(-1), 30, 10_000, 30},
		{5.9, 30, 10_000, 5},
		{-1, 30, 10_000, 0},
		{0, 30, 10_000, 0},
		{1e18, 30, 10_000, 10_000},
		{42, 30, 100, 42},
	} {
		if got := coerceLimit(tc.value, tc.fallback, tc.max); got != tc.want {
			t.Errorf("coerceLimit(%v,%d,%d) = %d, want %d", tc.value, tc.fallback, tc.max, got, tc.want)
		}
	}
}

func TestMetadataTokenListStrict(t *testing.T) {
	strict := func(body string) ([]string, bool) {
		t.Helper()
		return normalizeLlmLogMetadataTokensStrict([]byte(body), maxLlmLogMetadataKeys, maxLlmLogMetadataKeyLength)
	}
	if values, ok := strict(`["b","A","b"]`); !ok || len(values) != 2 || values[0] != "b" || values[1] != "a" {
		t.Fatalf(`["b","A","b"] = %v ok=%v`, values, ok)
	}
	if _, ok := strict(`"not-an-array"`); ok {
		t.Error("a non-array must be rejected in strict mode")
	}
	if _, ok := strict(`["a b"]`); ok {
		t.Error("an entry with a space must be rejected in strict mode")
	}
	if _, ok := strict(`[1]`); ok {
		t.Error("a non-string entry must be rejected in strict mode")
	}
	long := make([]byte, 0, 3*101)
	long = append(long, '[')
	for i := 0; i < 101; i++ {
		if i > 0 {
			long = append(long, ',')
		}
		long = append(long, '"', 'a', '"')
	}
	long = append(long, ']')
	if _, ok := strict(string(long)); ok {
		t.Error("an over-long list must be rejected in strict mode")
	}
}

func TestMetadataTokenListLenient(t *testing.T) {
	lenient := func(body string) []string {
		t.Helper()
		return lenientLlmLogMetadataTokens([]byte(body), maxLlmLogMetadataPrefixes, maxLlmLogMetadataPrefixLength, defaultLlmLogMetadataPrefixes)
	}
	if got := lenient(`"not-an-array"`); len(got) != 3 || got[0] != "x_" {
		t.Fatalf("non-array fallback = %v", got)
	}
	// over-limit lists are truncated and filtered WITHOUT deduplication.
	over := `["x_","x_","y_","z_","w_","v_","u_","t_","s_","r_","q_","p_","o_","n_","m_","l_","k_","j_","i_","h_","g_","f_"]`
	if got := lenient(over); len(got) != 20 || got[0] != "x_" || got[1] != "x_" {
		t.Fatalf("truncated list = %v (len %d)", got, len(got))
	}
	// A list inside the limit is deduplicated and filtered.
	if got := lenient(`["x_","X_","bad token","y_"]`); len(got) != 2 || got[0] != "x_" || got[1] != "y_" {
		t.Fatalf("filtered list = %v", got)
	}
	if got := lenient(`[]`); got == nil || len(got) != 0 {
		t.Fatalf("empty list = %v", got)
	}
}

func TestMergeRequiredLlmLogMetadataKeys(t *testing.T) {
	got := mergeRequiredLlmLogMetadataKeys([]string{"b", "a"})
	want := []string{"b", "a", "runid", "nodeid", "profileid", "frontierrunid", "frontiernodeid", "crawlsiteprofileid"}
	if len(got) != len(want) {
		t.Fatalf("merged keys = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("merged[%d] = %q, want %q (full %v)", i, got[i], want[i], got)
		}
	}
	// The required keys are appended only when missing, so merging the default
	// list is a no-op that preserves source order.
	merged := mergeRequiredLlmLogMetadataKeys(append([]string{}, defaultLlmLogMetadataKeys...))
	if len(merged) != len(defaultLlmLogMetadataKeys) {
		t.Fatalf("merging the default list changed its length: %d", len(merged))
	}
	for i := range defaultLlmLogMetadataKeys {
		if merged[i] != defaultLlmLogMetadataKeys[i] {
			t.Fatalf("merged[%d] = %q, want %q", i, merged[i], defaultLlmLogMetadataKeys[i])
		}
	}
}

func TestTTLIndexDecisionHelpers(t *testing.T) {
	ttl := func(seconds int64) *int64 { return &seconds }
	indexes := indexList{
		{Name: taskLogTTLIndexName, ExpireAfterSeconds: ttl(300)},
		{Name: "other_ttl", ExpireAfterSeconds: ttl(300)},
		{Name: "created_at_plain", ExpireAfterSeconds: nil},
	}
	if !hasDesiredManagedTTLIndex(indexes, 300) {
		t.Error("300 must be reported as the desired TTL")
	}
	if hasDesiredManagedTTLIndex(indexes, 400) {
		t.Error("400 must not be reported as the desired TTL")
	}
	stale := findStaleManagedTTLIndexes(indexes, taskLogTTLIndexName, 400)
	if len(stale) != 2 || stale[0] != taskLogTTLIndexName || stale[1] != "other_ttl" {
		t.Fatalf("stale for target 400 = %v", stale)
	}
	// A non-TTL index is not stale: it is a conflict instead.
	if stale := findStaleManagedTTLIndexes(indexes, taskLogTTLIndexName, 300); len(stale) != 0 {
		t.Fatalf("stale for target 300 = %v", stale)
	}
	blocking, found := findBlockingNonTTLCreatedAtIndex(indexes, taskLogTTLIndexName)
	if !found || blocking != "created_at_plain" {
		t.Fatalf("blocking = %q found=%v", blocking, found)
	}
	// The managed index itself never blocks, even without a TTL.
	managedOnly := indexList{{Name: taskLogTTLIndexName, ExpireAfterSeconds: nil}}
	if blocking, found := findBlockingNonTTLCreatedAtIndex(managedOnly, taskLogTTLIndexName); found {
		t.Fatalf("managed index reported as blocking: %q", blocking)
	}
	// A managed index without a TTL is stale and gets dropped and recreated.
	if stale := findStaleManagedTTLIndexes(managedOnly, taskLogTTLIndexName, 300); len(stale) != 1 {
		t.Fatalf("managed non-TTL stale = %v", stale)
	}
}

func TestParseIndexListFiltersNonCreatedAtIndexes(t *testing.T) {
	key := func(document string) bson.RawValue {
		return mustRawValue(t, document)
	}
	documents := []rawIndexDocument{
		{Name: " _id_ ", Key: key(`{"_id":1}`)},
		{Name: taskLogTTLIndexName, Key: key(`{"createdAt":1}`), ExpireAfterSeconds: mustInt32Value(t, 300)},
		{Name: "composite", Key: key(`{"createdAt":1,"orgId":1}`)},
		{Name: "descending", Key: key(`{"createdAt":-1}`)},
		{Name: "  ", Key: key(`{"createdAt":1}`)},
		{Name: "created_at_plain", Key: key(`{"createdAt":1}`)},
	}
	parsed := parseIndexList(documents)
	if len(parsed) != 2 {
		t.Fatalf("parsed = %+v", parsed)
	}
	if parsed[0].Name != taskLogTTLIndexName || parsed[0].ExpireAfterSeconds == nil || *parsed[0].ExpireAfterSeconds != 300 {
		t.Fatalf("managed index = %+v", parsed[0])
	}
	if parsed[1].Name != "created_at_plain" || parsed[1].ExpireAfterSeconds != nil {
		t.Fatalf("plain index = %+v", parsed[1])
	}
}

func TestNormalizeExpireAfterSecondsAcceptsNumbersAndNumericStrings(t *testing.T) {
	if got := normalizeExpireAfterSeconds(mustInt32Value(t, 42)); got == nil || *got != 42 {
		t.Fatalf("int32 = %v", got)
	}
	if got := normalizeExpireAfterSeconds(mustStringValue(t, " 42 ")); got == nil || *got != 42 {
		t.Fatalf("numeric string = %v", got)
	}
	if got := normalizeExpireAfterSeconds(mustStringValue(t, "abc")); got != nil {
		t.Fatalf("non-numeric string = %v", got)
	}
	if got := normalizeExpireAfterSeconds(mustStringValue(t, "  ")); got != nil {
		t.Fatalf("blank string = %v", got)
	}
	if got := normalizeExpireAfterSeconds(mustNullValue(t)); got != nil {
		t.Fatalf("null = %v", got)
	}
}

func TestSafetyMetricsWindowDays(t *testing.T) {
	for _, tc := range []struct {
		days float64
		want int
	}{
		{7, 7},
		{1, 1},
		{0, 1},
		{-5, 1},
		{90, 90},
		{1000, 90},
		{14.9, 14},
		{math.NaN(), 14},
		{math.Inf(1), 14},
	} {
		if got := safetyMetricsWindowDays(tc.days); got != tc.want {
			t.Errorf("safetyMetricsWindowDays(%v) = %d, want %d", tc.days, got, tc.want)
		}
	}
}

func TestPadSafetyMetricsRows(t *testing.T) {
	start := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	facet := safetyMetricsFacet{
		Totals: []safetyMetricsTotalRow{
			{Date: "2026-10-15", TotalRuns: 4, BlockedRuns: 1},
			{Date: "2026-10-17", TotalRuns: 2, BlockedRuns: 2},
		},
		Guardrails: []safetyMetricsGuardrailRow{
			{Date: "2026-10-15", Guardrails: []AssistantSafetyCountEntry{
				{Name: "openai-moderation-pre", Count: 1},
				{Name: "", Count: 9},
			}},
		},
	}
	rows := padSafetyMetricsRows(facet, start, 3)
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	if rows[0].Date != "2026-10-15" || rows[1].Date != "2026-10-16" || rows[2].Date != "2026-10-17" {
		t.Fatalf("dates = %s %s %s", rows[0].Date, rows[1].Date, rows[2].Date)
	}
	if rows[0].TotalRuns != 4 || rows[0].BlockedRuns != 1 || rows[0].BlockedRate != 0.25 {
		t.Fatalf("day 0 = %+v", rows[0])
	}
	if len(rows[0].Guardrails) != 1 || rows[0].Guardrails[0].Name != "openai-moderation-pre" {
		t.Fatalf("day 0 guardrails = %+v", rows[0].Guardrails)
	}
	if rows[1].TotalRuns != 0 || rows[1].BlockedRate != 0 || rows[1].Guardrails == nil || rows[1].Codes == nil {
		t.Fatalf("empty day = %+v", rows[1])
	}
	if len(rows[1].Guardrails) != 0 || len(rows[1].Codes) != 0 {
		t.Fatalf("empty day arrays = %+v %+v", rows[1].Guardrails, rows[1].Codes)
	}
	if rows[2].BlockedRate != 1 {
		t.Fatalf("day 2 rate = %v", rows[2].BlockedRate)
	}
}

func TestNormalizeOrgIDBucketsBlanks(t *testing.T) {
	if got := normalizeOrgID("  "); got != unknownOrgID {
		t.Errorf("blank orgId = %q, want %q", got, unknownOrgID)
	}
	if got := normalizeOrgID(" org-a "); got != "org-a" {
		t.Errorf("orgId = %q, want org-a", got)
	}
}

func TestStoredValueHelpers(t *testing.T) {
	if _, ok := storedValueIsObjectLike([]byte(` 12 `)); ok {
		t.Error("a bare number is not object-like")
	}
	if _, ok := storedValueIsObjectLike([]byte(`null`)); ok {
		t.Error("null is not object-like")
	}
	cacheBytes, ok := storedValueIsObjectLike([]byte(` [1,2] `))
	if !ok || string(cacheBytes) != "[1,2]" {
		t.Fatalf("array cache bytes = %q ok=%v", cacheBytes, ok)
	}
	decodeBytes, present := storedValueForStruct([]byte(` [1,2] `))
	if !present || decodeBytes != nil {
		t.Fatalf("array struct bytes = %q present=%v", decodeBytes, present)
	}
	decodeBytes, present = storedValueForStruct([]byte(` {"a":1} `))
	if !present || string(decodeBytes) != `{"a":1}` {
		t.Fatalf("object struct bytes = %q present=%v", decodeBytes, present)
	}
}

// mustRawValue decodes a JSON fragment into a bson.RawValue so the pure TTL
// helpers can be exercised without a MongoDB server.
func mustRawValue(t *testing.T, fragment string) bson.RawValue {
	t.Helper()
	var holder struct {
		Value bson.RawValue `bson:"value"`
	}
	if err := bson.UnmarshalExtJSON([]byte(`{"value":`+fragment+`}`), false, &holder); err != nil {
		t.Fatalf("decode %q: %v", fragment, err)
	}
	return holder.Value
}

func mustInt32Value(t *testing.T, value int32) bson.RawValue {
	t.Helper()
	return mustRawValue(t, strconv.FormatInt(int64(value), 10))
}

func mustStringValue(t *testing.T, value string) bson.RawValue {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %q: %v", value, err)
	}
	return mustRawValue(t, string(encoded))
}

func mustNullValue(t *testing.T) bson.RawValue {
	t.Helper()
	return mustRawValue(t, "null")
}
