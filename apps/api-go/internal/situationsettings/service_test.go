package situationsettings

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func unitService(env Env) *Service { return NewService(Options{Env: env}) }

func unitEnv() Env { return NewEnvFromLookup(lookupFrom(nil)) }

func TestPublicSettingsDefaultsWhenNoRowExists(t *testing.T) {
	service := unitService(unitEnv())
	settings := service.publicSettings(nil, false)
	if settings.Source != SettingsSourceEnv {
		t.Fatalf("source = %s", settings.Source)
	}
	if settings.TranslationMaxConcurrency != 2 || settings.TranslationAPIBaseURL != "https://api.deeplx.org" ||
		settings.TranslationFallbackAPIBaseURL != "" || !settings.TranslationAPIEnabled {
		t.Fatalf("translation = %+v", settings)
	}
	if settings.TelegramChannelSet != "full" || settings.TelegramMaxFeedItems != 200 ||
		settings.TelegramPollIntervalMS != 60_000 || settings.TelegramEnabled {
		t.Fatalf("telegram = %+v", settings)
	}
	if settings.HasTranslationAPIKey || settings.TranslationAPIKeySource != APIKeySourceNone {
		t.Fatalf("translation key = %+v", settings)
	}
	if settings.LiveHLSProxyCnnConfigured || settings.LiveHLSProxyCnnSource != LiveHLSProxySourceNone ||
		settings.LiveHLSProxyCnnAllowedHosts == nil {
		t.Fatalf("hls = %+v", settings)
	}
	if settings.TelegramAPIID != nil {
		t.Fatalf("telegramApiId should be omitted, got %v", *settings.TelegramAPIID)
	}
}

func TestPublicSettingsStoredOverridesAndSources(t *testing.T) {
	env := unitEnv()
	env.EncryptionKeyRaw = testEncryptionKeyHex
	service := unitService(env)
	stored := decodeStoredFields([]byte(`{
		"translationMaxConcurrency": 4,
		"translationApiEnabled": false,
		"translationApiBaseUrl": "https://db.test/",
		"translationFallbackApiEnabled": true,
		"translationFallbackApiBaseUrl": "https://fallback.test/",
		"translationApiTimeoutMs": 5000,
		"translationApiMaxRetries": 4,
		"translationApiKey": "db-key",
		"finnhubApiKey": {"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AAECAwQFBgcICQoL","tag":"TmYBEvk43mMlN5fqYUsOug==","data":"8m+3cW+RRyX0rrpnWszDrTigcQ=="},
		"telegramEnabled": true,
		"telegramChannelSet": " custom ",
		"telegramMaxFeedItems": 300,
		"telegramApiId": "12345",
		"liveHlsProxyCnnUpstreamUrl": "https://cnn.test/live.m3u8/",
		"liveHlsProxyCnnReferer": "https://cnn.test/",
		"liveHlsProxyCnnAllowedHosts": ["Example.Test","example.test"],
		"liveHlsProxyCnbcUpstreamUrl": "http://cnbc.test/live.m3u8"
	}`))
	settings := service.publicSettings(&stored, true)
	if settings.Source != SettingsSourceDB {
		t.Fatalf("source = %s", settings.Source)
	}
	if settings.TranslationMaxConcurrency != 4 || settings.TranslationAPIEnabled ||
		settings.TranslationAPIBaseURL != "https://db.test" ||
		!settings.TranslationFallbackAPIEnabled ||
		settings.TranslationFallbackAPIBaseURL != "https://fallback.test" ||
		settings.TranslationAPITimeoutMS != 5000 || settings.TranslationAPIMaxRetries != 4 {
		t.Fatalf("translation = %+v", settings)
	}
	if !settings.HasTranslationAPIKey || settings.TranslationAPIKeySource != APIKeySourceStored {
		t.Fatalf("translation key = %+v", settings)
	}
	if !settings.HasFinnhubAPIKey || settings.FinnhubAPIKeySource != APIKeySourceStored {
		t.Fatalf("finnhub key = %+v", settings)
	}
	if !settings.TelegramEnabled || settings.TelegramChannelSet != "custom" || settings.TelegramMaxFeedItems != 300 {
		t.Fatalf("telegram = %+v", settings)
	}
	if settings.TelegramAPIID == nil || *settings.TelegramAPIID != "12345" ||
		settings.TelegramAPIIDSource != APIKeySourceStored {
		t.Fatalf("telegram api id = %+v", settings)
	}
	if !settings.LiveHLSProxyCnnConfigured || settings.LiveHLSProxyCnnSource != LiveHLSProxySourceStored ||
		settings.LiveHLSProxyCnnUpstreamURL != "https://cnn.test/live.m3u8" ||
		settings.LiveHLSProxyCnnReferer != "https://cnn.test" {
		t.Fatalf("cnn hls = %+v", settings)
	}
	if !reflect.DeepEqual(settings.LiveHLSProxyCnnAllowedHosts, []string{"example.test"}) {
		t.Fatalf("cnn hosts = %v", settings.LiveHLSProxyCnnAllowedHosts)
	}
	if settings.LiveHLSProxyCnbcConfigured {
		t.Fatalf("an http cnbc upstream must stay unconfigured: %+v", settings)
	}
}

func TestPublicSettingsDecryptsNestEnvelope(t *testing.T) {
	env := unitEnv()
	env.EncryptionKeyRaw = testEncryptionKeyHex
	service := unitService(env)
	stored := decodeStoredFields([]byte(`{
		"telegramApiHash": {"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AAECAwQFBgcICQoL","tag":"TmYBEvk43mMlN5fqYUsOug==","data":"8m+3cW+RRyX0rrpnWszDrTigcQ=="}
	}`))
	settings := service.publicSettings(&stored, true)
	if !settings.HasTelegramAPIHash || settings.TelegramAPIHashSource != APIKeySourceStored {
		t.Fatalf("hash = %+v", settings)
	}
	if settings.HasTranslationAPIKey {
		t.Fatalf("unexpected translation key")
	}
}

func TestPublicSettingsEnvSourcesAndFallsBackOnInvalidStoredValues(t *testing.T) {
	env := unitEnv()
	env.TelegramEnabled = true
	env.TelegramAPIHash = "env-hash"
	env.TelegramAPIID = "env-id"
	service := unitService(env)
	stored := decodeStoredFields([]byte(`{
		"translationMaxConcurrency": "not-a-number",
		"translationApiBaseUrl": null,
		"telegramEnabled": "yes",
		"telegramMaxFeedItems": null,
		"telegramChannelSet": "  ",
		"telegramApiHash": null
	}`))
	settings := service.publicSettings(&stored, true)
	if settings.TranslationMaxConcurrency != 2 {
		t.Fatalf("invalid number should fall back to the env default: %d", settings.TranslationMaxConcurrency)
	}
	if settings.TranslationAPIBaseURL != "https://api.deeplx.org" {
		t.Fatalf("null base url should fall back to env: %q", settings.TranslationAPIBaseURL)
	}
	if !settings.TelegramEnabled {
		t.Fatal("a non-boolean stored telegramEnabled keeps the env value")
	}
	if settings.TelegramMaxFeedItems != 50 {
		t.Fatalf("stored null number must clamp to the minimum, got %d", settings.TelegramMaxFeedItems)
	}
	if settings.TelegramChannelSet != "full" {
		t.Fatalf("blank stored channel set falls back to env, got %q", settings.TelegramChannelSet)
	}
	if !settings.HasTelegramAPIID || settings.TelegramAPIIDSource != APIKeySourceEnv ||
		settings.TelegramAPIID == nil || *settings.TelegramAPIID != "env-id" {
		t.Fatalf("telegram api id = %+v", settings)
	}
	if !settings.HasTelegramAPIHash || settings.TelegramAPIHashSource != APIKeySourceEnv {
		t.Fatalf("telegram api hash = %+v", settings)
	}
}

func TestBuildNextStoredPreservesOmittedFields(t *testing.T) {
	service := unitService(unitEnv())
	stored := decodeStoredFields([]byte(`{
		"translationMaxConcurrency": 3,
		"translationApiBaseUrl": "https://db.test/",
		"translationApiKey": "existing-key",
		"telegramApiHash": "hash-value",
		"telegramSession": "session-value",
		"telegramChannelSet": "tech",
		"liveHlsProxyCnnUpstreamUrl": "https://cnn.test/live.m3u8",
		"liveHlsProxyCnnAllowedHosts": ["cnn.test"]
	}`))
	input, err := parseUpdateSettings([]byte(`{"translationMaxConcurrency":3}`))
	if err != nil {
		t.Fatal(err)
	}
	next, metadata, err := service.buildNextStored(stored, input, secretEncoder{})
	if err != nil {
		t.Fatal(err)
	}
	if next.TranslationAPIBaseURL == nil || *next.TranslationAPIBaseURL != "https://db.test" {
		t.Fatalf("base url = %v", next.TranslationAPIBaseURL)
	}
	var key string
	if err := json.Unmarshal(next.TranslationAPIKey, &key); err != nil || key != "existing-key" {
		t.Fatalf("api key = %s err=%v", next.TranslationAPIKey, err)
	}
	if next.TelegramChannelSet != "tech" {
		t.Fatalf("channel set = %q", next.TelegramChannelSet)
	}
	var hash string
	if err := json.Unmarshal(next.TelegramAPIHash, &hash); err != nil || hash != "hash-value" {
		t.Fatalf("hash = %s err=%v", next.TelegramAPIHash, err)
	}
	if next.LiveHLSProxyCnnUpstreamURL == nil || *next.LiveHLSProxyCnnUpstreamURL != "https://cnn.test/live.m3u8" {
		t.Fatalf("cnn url = %v", next.LiveHLSProxyCnnUpstreamURL)
	}
	if !reflect.DeepEqual(next.LiveHLSProxyCnnAllowedHosts, []string{"cnn.test"}) {
		t.Fatalf("cnn hosts = %v", next.LiveHLSProxyCnnAllowedHosts)
	}
	var meta map[string]any
	if err := json.Unmarshal(metadata, &meta); err != nil {
		t.Fatal(err)
	}
	if meta["translationApiKeyUpdated"] != false || meta["liveHlsProxyCnnUpdated"] != false {
		t.Fatalf("metadata = %v", meta)
	}
	if meta["telegramApiHashUpdated"] != false || meta["telegramSessionUpdated"] != false {
		t.Fatalf("telegram metadata = %v", meta)
	}
}

func TestBuildNextStoredClearsNullAndEmpty(t *testing.T) {
	service := unitService(unitEnv())
	stored := decodeStoredFields([]byte(`{
		"translationMaxConcurrency": 3,
		"translationApiBaseUrl": "https://db.test",
		"translationApiKey": "existing-key",
		"translationFallbackApiBaseUrl": "https://fallback.test",
		"telegramChannelSet": "tech",
		"liveHlsProxyCnnUpstreamUrl": "https://cnn.test/live.m3u8",
		"liveHlsProxyCnnAllowedHosts": ["cnn.test"],
		"liveHlsProxyCnbcAllowedHosts": ["cnbc.test"]
	}`))
	input, err := parseUpdateSettings([]byte(`{
		"translationMaxConcurrency": 3,
		"translationApiBaseUrl": null,
		"translationFallbackApiBaseUrl": "",
		"translationApiKey": null,
		"telegramChannelSet": "",
		"liveHlsProxyCnnUpstreamUrl": null,
		"liveHlsProxyCnnAllowedHosts": "",
		"liveHlsProxyCnbcAllowedHosts": null
	}`))
	if err != nil {
		t.Fatal(err)
	}
	next, metadata, err := service.buildNextStored(stored, input, secretEncoder{})
	if err != nil {
		t.Fatal(err)
	}
	if next.TranslationAPIBaseURL != nil || next.TranslationFallbackAPIBaseURL != nil {
		t.Fatalf("urls = %v %v", next.TranslationAPIBaseURL, next.TranslationFallbackAPIBaseURL)
	}
	if next.TranslationAPIKey != nil {
		t.Fatalf("api key = %s", next.TranslationAPIKey)
	}
	if next.TelegramChannelSet != "full" {
		t.Fatalf("channel set = %q", next.TelegramChannelSet)
	}
	if next.LiveHLSProxyCnnUpstreamURL != nil || len(next.LiveHLSProxyCnnAllowedHosts) != 0 ||
		len(next.LiveHLSProxyCnbcAllowedHosts) != 0 {
		t.Fatalf("hls = %+v", next)
	}
	var meta map[string]any
	if err := json.Unmarshal(metadata, &meta); err != nil {
		t.Fatal(err)
	}
	if meta["translationApiKeyUpdated"] != true || meta["liveHlsProxyCnnUpdated"] != true ||
		meta["liveHlsProxyCnbcUpdated"] != true {
		t.Fatalf("metadata = %v", meta)
	}
}

func TestBuildNextStoredNullNumbersClampToMinimum(t *testing.T) {
	service := unitService(unitEnv())
	stored := decodeStoredFields([]byte(`{"translationMaxConcurrency":3}`))
	input, err := parseUpdateSettings([]byte(`{
		"translationMaxConcurrency": 3,
		"translationApiTimeoutMs": null,
		"telegramMaxFeedItems": null,
		"telegramPollIntervalMs": null
	}`))
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := service.buildNextStored(stored, input, secretEncoder{})
	if err != nil {
		t.Fatal(err)
	}
	if next.TranslationAPITimeoutMS != 1000 || next.TelegramMaxFeedItems != 50 || next.TelegramPollIntervalMS != 15000 {
		t.Fatalf("numeric nulls = %+v", next)
	}
}

func TestBuildNextStoredValidatesURLsAndHosts(t *testing.T) {
	service := unitService(unitEnv())
	stored := decodeStoredFields([]byte(`{"translationMaxConcurrency":3}`))
	cases := []struct {
		body string
		want string
	}{
		{`{"translationMaxConcurrency":3,"translationApiBaseUrl":"ftp://example.test"}`,
			"translationApiBaseUrl must be a valid http(s) URL"},
		{`{"translationMaxConcurrency":3,"liveHlsProxyCnnUpstreamUrl":"http://example.test"}`,
			"liveHlsProxyCnnUpstreamUrl must be a valid https URL"},
		{`{"translationMaxConcurrency":3,"liveHlsProxyCnnReferer":"ftp://example.test"}`,
			"liveHlsProxyCnnReferer must be a valid http(s) URL"},
	}
	for _, tc := range cases {
		input, err := parseUpdateSettings([]byte(tc.body))
		if err != nil {
			t.Fatalf("%s parse: %v", tc.body, err)
		}
		if _, _, err := service.buildNextStored(stored, input, secretEncoder{}); err == nil || err.Error() != tc.want {
			t.Fatalf("%s error = %v", tc.body, err)
		}
	}
}

func TestBuildNextStoredEncryptsWhenKeyPresent(t *testing.T) {
	env := unitEnv()
	env.EncryptionKeyRaw = testEncryptionKeyHex
	service := unitService(env)
	key, _ := decodeSettingsKey(testEncryptionKeyHex)
	encoder := secretEncoder{keyStatus: encryptionKeyStatus{present: true, valid: true, key: key}}
	stored := decodeStoredFields([]byte(`{"translationMaxConcurrency":3}`))
	input, err := parseUpdateSettings([]byte(`{"translationMaxConcurrency":3,"translationApiKey":"new-key"}`))
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := service.buildNextStored(stored, input, encoder)
	if err != nil {
		t.Fatal(err)
	}
	if !isEncryptedSettingsValue(next.TranslationAPIKey) {
		t.Fatalf("key not encrypted: %s", next.TranslationAPIKey)
	}
	plain, ok := decryptSettingsSecret(next.TranslationAPIKey, testEncryptionKeyHex)
	if !ok || plain != "new-key" {
		t.Fatalf("round trip = %q ok=%v", plain, ok)
	}
}

// TestO3WrittenValueMatchesReRead decodes the bytes that were written and
// compares the response built from them with a fresh decode (the exact bytes a
// post-write MySQL read would return).
func TestO3WrittenValueMatchesReRead(t *testing.T) {
	service := unitService(unitEnv())
	stored := decodeStoredFields([]byte(`{
		"translationMaxConcurrency":3,
		"translationApiKey":"existing-key",
		"liveHlsProxyCnnUpstreamUrl":"https://cnn.test/live.m3u8"
	}`))
	input, err := parseUpdateSettings([]byte(`{
		"translationMaxConcurrency": 4,
		"telegramPollIntervalMs": 30000,
		"telegramChannelSet": "tech"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := service.buildNextStored(stored, input, secretEncoder{})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		t.Fatal(err)
	}
	written := decodeStoredFields(encoded)
	reread := decodeStoredFields(append([]byte(nil), encoded...))
	first := service.publicSettings(&written, true)
	second := service.publicSettings(&reread, true)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("written response differs from re-read:\n%+v\n%+v", first, second)
	}
	if first.TranslationMaxConcurrency != 4 || first.TelegramPollIntervalMS != 30000 ||
		first.TelegramChannelSet != "tech" || !first.HasTranslationAPIKey {
		t.Fatalf("written response = %+v", first)
	}
}

func TestClearTelegramStoredValuePreservesUnknownMembers(t *testing.T) {
	raw := json.RawMessage(`{
		"translationMaxConcurrency":3,
		"telegramEnabled":true,
		"telegramApiId":"123",
		"telegramApiHash":"hash",
		"telegramSession":"session",
		"legacyUnknownField":"keep-me"
	}`)
	encoded, err := clearTelegramStoredValue(raw)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if string(decoded["telegramEnabled"]) != "false" ||
		string(decoded["telegramApiId"]) != "null" ||
		string(decoded["telegramApiHash"]) != "null" ||
		string(decoded["telegramSession"]) != "null" {
		t.Fatalf("telegram fields = %s", encoded)
	}
	if string(decoded["legacyUnknownField"]) != `"keep-me"` {
		t.Fatalf("unknown field dropped: %s", encoded)
	}
	if string(decoded["translationMaxConcurrency"]) != "3" {
		t.Fatalf("other field dropped: %s", encoded)
	}
}

func TestClearTelegramStoredValueArraySpread(t *testing.T) {
	encoded, err := clearTelegramStoredValue(json.RawMessage(`["zero","one"]`))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if string(decoded["0"]) != `"zero"` || string(decoded["1"]) != `"one"` {
		t.Fatalf("array spread lost indices: %s", encoded)
	}
	if string(decoded["telegramSession"]) != "null" {
		t.Fatalf("telegram field missing: %s", encoded)
	}
}

func TestClearTelegramStoredValueOnMissingRow(t *testing.T) {
	encoded, err := clearTelegramStoredValue(nil)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 4 {
		t.Fatalf("decoded = %s", encoded)
	}
}

func TestResolveNextStringTrimsAndClears(t *testing.T) {
	if value, err := resolveNextString(json.RawMessage(`" current "`), optionalString{state: presenceMissing}); err != nil || value == nil || *value != "current" {
		t.Fatalf("missing = %v %v", value, err)
	}
	if value, err := resolveNextString(json.RawMessage(`"current"`), optionalString{state: presenceNull}); err != nil || value != nil {
		t.Fatalf("null = %v %v", value, err)
	}
	if value, err := resolveNextString(nil, optionalString{state: presenceValue, value: "  "}); err != nil || value != nil {
		t.Fatalf("blank = %v %v", value, err)
	}
	if value, err := resolveNextString(nil, optionalString{state: presenceValue, value: " next "}); err != nil || value == nil || *value != "next" {
		t.Fatalf("value = %v %v", value, err)
	}
}

func TestUpdateAuditMetadataNeverContainsSecrets(t *testing.T) {
	service := unitService(unitEnv())
	stored := decodeStoredFields([]byte(`{"translationMaxConcurrency":3}`))
	input, err := parseUpdateSettings([]byte(`{
		"translationMaxConcurrency": 3,
		"translationApiKey": "super-secret-value",
		"finnhubApiKey": "finnhub-secret",
		"fredApiKey": "fred-secret"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	_, metadata, err := service.buildNextStored(stored, input, secretEncoder{})
	if err != nil {
		t.Fatal(err)
	}
	text := string(metadata)
	for _, secret := range []string{"super-secret-value", "finnhub-secret", "fred-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("metadata leaked %q: %s", secret, text)
		}
	}
}
