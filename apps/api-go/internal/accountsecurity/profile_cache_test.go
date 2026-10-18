package accountsecurity

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func testAuthCacheService() *Service {
	return &Service{cfg: Config{
		AuthProfileCacheTTLSeconds:   600,
		AuthProfileCacheLockTTLMs:    5000,
		AuthProfileCacheMaxWaitMs:    5000,
		AuthProfileCacheRetryDelayMs: 50,
	}}
}

func TestProfileCacheKey(t *testing.T) {
	if got := profileCacheKey("user-1", "org-1"); got != "profile:user-1:org-1" {
		t.Fatalf("key = %q", got)
	}
	if got := profileCacheKey("user-1", ""); got != "profile:user-1:default" {
		t.Fatalf("default key = %q", got)
	}
}

func TestAuthCacheSettingsNormalization(t *testing.T) {
	service := testAuthCacheService()

	// Out-of-range stored values are clamped in the documented order.
	normalized := service.normalizeStoredAuthCache([]byte(`{"profileTtlSeconds":10,"lockTtlMs":1,"maxWaitMs":1,"retryDelayMs":1}`))
	if normalized.ProfileTTLSeconds != 60 || normalized.LockTTLMs != 100 ||
		normalized.RetryDelayMs != 10 || normalized.MaxWaitMs != 50 {
		t.Fatalf("clamps = %+v", normalized)
	}
	high := service.normalizeStoredAuthCache([]byte(`{"profileTtlSeconds":1000000,"lockTtlMs":1000000,"maxWaitMs":1000000,"retryDelayMs":1000000}`))
	if high.ProfileTTLSeconds != 86400 || high.LockTTLMs != 60000 ||
		high.RetryDelayMs != 1000 || high.MaxWaitMs != 120000 {
		t.Fatalf("upper clamps = %+v", high)
	}

	// Only a finite number is accepted: numeric strings fall back and fractions
	// are floored.
	mixed := service.normalizeStoredAuthCache([]byte(`{"profileTtlSeconds":"120","lockTtlMs":250.9}`))
	if mixed.ProfileTTLSeconds != 600 {
		t.Fatalf("numeric string coerced: %d", mixed.ProfileTTLSeconds)
	}
	if mixed.LockTTLMs != 250 {
		t.Fatalf("fraction not floored: %d", mixed.LockTTLMs)
	}

	// maxWaitMs must be at least retryDelayMs.
	dependent := service.normalizeStoredAuthCache([]byte(`{"retryDelayMs":900,"maxWaitMs":100}`))
	if dependent.MaxWaitMs != 900 || dependent.RetryDelayMs != 900 {
		t.Fatalf("maxWait dependency = %+v", dependent)
	}

	// A non-object stored value spreads to an empty object, i.e. the clamped
	// environment defaults.
	nonObject := service.normalizeStoredAuthCache([]byte(`42`))
	if nonObject.ProfileTTLSeconds != 600 || nonObject.MaxWaitMs != 5000 {
		t.Fatalf("non-object = %+v", nonObject)
	}

	// The row-absent path returns the raw environment defaults without clamping.
	service.cfg.AuthProfileCacheTTLSeconds = 5
	if fallback := service.fallbackAuthCacheSettings(); fallback.ProfileTTLSeconds != 5 {
		t.Fatalf("row-absent fallback was clamped: %+v", fallback)
	}
}

func TestTTLSecondsUntilCeils(t *testing.T) {
	now := time.Date(2026, 5, 6, 7, 8, 9, 0, time.UTC)
	cases := []struct {
		offset time.Duration
		want   int
	}{
		{-time.Second, 0},
		{0, 0},
		{time.Millisecond, 1},
		{time.Second, 1},
		{1001 * time.Millisecond, 2},
		{2500 * time.Millisecond, 3},
		{72 * time.Hour, 259200},
	}
	for _, testCase := range cases {
		got := ttlSecondsUntil(now.Add(testCase.offset), now)
		if got != testCase.want {
			t.Fatalf("offset %s: got %d want %d", testCase.offset, got, testCase.want)
		}
	}
}

func TestFormatJSDateTruncatesToMilliseconds(t *testing.T) {
	if got := formatJSDate(nil); got != nil {
		t.Fatalf("nil date = %v", got)
	}
	value := time.Date(2026, 5, 6, 7, 8, 9, 123456789, time.UTC)
	formatted := formatJSDate(&value)
	if formatted == nil || *formatted != "2026-05-06T07:08:09.123Z" {
		t.Fatalf("formatted = %v", formatted)
	}
}

func TestJSTruthyJSON(t *testing.T) {
	falsy := []string{"null", "false", "0", `""`, "[]"}
	for _, raw := range falsy {
		if jsTruthyJSON(json.RawMessage(raw)) {
			t.Fatalf("%s must be falsy", raw)
		}
	}
	truthy := []string{`{}`, `{"id":"user-1"}`, `"x"`, "1", "true", `[1]`, `[null]`}
	for _, raw := range truthy {
		if !jsTruthyJSON(json.RawMessage(raw)) {
			t.Fatalf("%s must be truthy", raw)
		}
	}
}

// TestProfileModelCarriesNoRequestMetadata pins the cache boundary: the cached
// base profile has no accessTokenId/accessTokenExpiresAt and never a password
// hash. GET /me layers the verified metadata on afterwards.
func TestProfileModelCarriesNoRequestMetadata(t *testing.T) {
	base := profileResponse{
		ID:          "user-1",
		Email:       "user@example.com",
		FirstName:   "Ada",
		LastName:    "Lovelace",
		OrgID:       "org-1",
		RoleIDs:     []string{"role-1"},
		Permissions: []string{"metrics.read"},
		GlobalRoles: []string{},
	}
	payload, err := json.Marshal(base)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	text := string(payload)
	for _, forbidden := range []string{"accessTokenId", "accessTokenExpiresAt", "passwordHash", "token"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("base profile contains %q: %s", forbidden, text)
		}
	}
	// The always-null fields are present as JSON null, not omitted.
	for _, required := range []string{`"emailVerified":null`, `"lastLoginAt":null`, `"pendingEmail":null`, `"avatarUrl":null`, `"primaryRoleId":null`, `"planTier":null`, `"subscriptionStatus":null`} {
		if !strings.Contains(text, required) {
			t.Fatalf("base profile missing %s: %s", required, text)
		}
	}
	if !strings.Contains(text, `"mfaRequired":false`) || !strings.Contains(text, `"mfaEnrollmentRequired":false`) {
		t.Fatalf("MFA flags = %s", text)
	}

	// Layering the request metadata only adds the two keys when present.
	millis := int64(1893456000000)
	base.AccessTokenID = "jti-1"
	base.AccessTokenExpiresAt = &millis
	layered, err := json.Marshal(base)
	if err != nil {
		t.Fatalf("marshal layered: %v", err)
	}
	if !strings.Contains(string(layered), `"accessTokenId":"jti-1"`) ||
		!strings.Contains(string(layered), `"accessTokenExpiresAt":1893456000000`) {
		t.Fatalf("layered = %s", layered)
	}
}

func TestMachineProfileModelShape(t *testing.T) {
	machine := machineProfileResponse{
		ID:          "machine:mtk_1",
		Email:       "ci@machine.local",
		OrgID:       "org-1",
		RoleIDs:     []string{},
		Permissions: []string{"settings.manage"},
		FirstName:   "ci",
		LastName:    "Machine",
		IsActive:    true,
		GlobalRoles: []string{},
	}
	payload, err := json.Marshal(machine)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	text := string(payload)
	if strings.Contains(text, "accessTokenId") || strings.Contains(text, "accessTokenExpiresAt") {
		t.Fatalf("machine profile leaked request metadata: %s", text)
	}
	for _, required := range []string{`"id":"machine:mtk_1"`, `"email":"ci@machine.local"`, `"primaryRoleId":null`, `"roleIds":[]`, `"globalRoles":[]`} {
		if !strings.Contains(text, required) {
			t.Fatalf("machine profile missing %s: %s", required, text)
		}
	}
}

func TestDecodeCachedProfileRejectsFalsyAndCorrupt(t *testing.T) {
	if _, ok := decodeCachedProfile(json.RawMessage("null")); ok {
		t.Fatalf("null cache decoded")
	}
	if _, ok := decodeCachedProfile(json.RawMessage("{")); ok {
		t.Fatalf("corrupt cache decoded")
	}
	profile, ok := decodeCachedProfile(json.RawMessage(`{"id":"user-1","orgId":"org-1"}`))
	if !ok || profile.ID != "user-1" {
		t.Fatalf("valid cache = %+v ok=%v", profile, ok)
	}
}
