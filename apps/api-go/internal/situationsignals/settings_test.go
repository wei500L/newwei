package situationsignals

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
)

// encryptSettingsSecret builds a system-settings:v1 envelope the way
// apps/api/src/modules/storage/storage-settings.crypto.ts does.
func encryptSettingsSecret(t *testing.T, plain string, key []byte) json.RawMessage {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	data := sealed[:len(sealed)-gcm.Overhead()]
	encoded, err := json.Marshal(map[string]string{
		"__enc": "system-settings:v1",
		"alg":   "aes-256-gcm",
		"iv":    base64.StdEncoding.EncodeToString(iv),
		"tag":   base64.StdEncoding.EncodeToString(tag),
		"data":  base64.StdEncoding.EncodeToString(data),
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func testKey() []byte {
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index + 1)
	}
	return key
}

func TestDecodeSettingsKey(t *testing.T) {
	key := testKey()
	hexKey := "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
	decoded, ok := decodeSettingsKey(hexKey)
	if !ok || len(decoded) != 32 {
		t.Fatalf("hex key = %v/%v", decoded, ok)
	}
	decoded, ok = decodeSettingsKey("0x" + hexKey)
	if !ok || len(decoded) != 32 {
		t.Fatalf("prefixed hex key = %v/%v", decoded, ok)
	}
	decoded, ok = decodeSettingsKey(base64.StdEncoding.EncodeToString(key))
	if !ok || len(decoded) != 32 {
		t.Fatalf("base64 key = %v/%v", decoded, ok)
	}
	for _, invalid := range []string{"", "   ", "short", hexKey[:62], base64.StdEncoding.EncodeToString(key[:16])} {
		if _, ok := decodeSettingsKey(invalid); ok {
			t.Fatalf("%q must not decode", invalid)
		}
	}
}

func TestDecryptSettingsSecret(t *testing.T) {
	key := testKey()
	payload := encryptSettingsSecret(t, "sk-live", key)
	plain, ok := decryptSettingsSecret(rawJSON{raw: payload}, base64.StdEncoding.EncodeToString(key))
	if !ok || plain != "sk-live" {
		t.Fatalf("plain = %q/%v", plain, ok)
	}
	// A wrong key fails closed.
	if _, ok := decryptSettingsSecret(rawJSON{raw: payload}, base64.StdEncoding.EncodeToString(make([]byte, 32))); ok {
		t.Fatal("a wrong key must not decrypt")
	}
	// A plain string is not an envelope.
	if _, ok := decryptSettingsSecret(rawJSON{raw: json.RawMessage(`"plain"`)}, base64.StdEncoding.EncodeToString(key)); ok {
		t.Fatal("a plain string must not decrypt")
	}
}

func TestIsEncryptedSettingsValue(t *testing.T) {
	key := testKey()
	payload := encryptSettingsSecret(t, "secret", key)
	if !(rawJSON{raw: payload}).isEncryptedSettingsValue() {
		t.Fatal("a valid envelope must be recognised")
	}
	for _, invalid := range []string{`"plain"`, `{}`, `{"__enc":"other","alg":"aes-256-gcm","iv":"a","tag":"b","data":"c"}`,
		`{"__enc":"system-settings:v1","alg":"aes-256-cbc","iv":"a","tag":"b","data":"c"}`,
		`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"a","tag":"b"}`} {
		if (rawJSON{raw: json.RawMessage(invalid)}).isEncryptedSettingsValue() {
			t.Fatalf("%s must not be recognised", invalid)
		}
	}
}

func TestStoredSecretResolution(t *testing.T) {
	key := testKey()
	reader := &settingsReader{
		lookup: envLookup(map[string]string{
			"SYSTEM_SETTINGS_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(key),
		}),
	}
	encrypted := encryptSettingsSecret(t, "  telegram-hash  ", key)
	stored := &storedSituationMonitorSettings{}

	// A plain string is trimmed.
	stored.TelegramSession = rawJSON{raw: json.RawMessage(`"  session  "`)}
	if got := reader.storedSecret(stored, func(s *storedSituationMonitorSettings) rawJSON {
		return s.TelegramSession
	}); got != "session" {
		t.Fatalf("session = %q", got)
	}

	// An encrypted envelope is decrypted and trimmed.
	stored.TelegramApiHash = rawJSON{raw: encrypted}
	if got := reader.storedSecret(stored, func(s *storedSituationMonitorSettings) rawJSON {
		return s.TelegramApiHash
	}); got != "telegram-hash" {
		t.Fatalf("hash = %q", got)
	}

	// A falsy value is absent.
	stored.TelegramSession = rawJSON{raw: json.RawMessage(`null`)}
	if got := reader.storedSecret(stored, func(s *storedSituationMonitorSettings) rawJSON {
		return s.TelegramSession
	}); got != "" {
		t.Fatalf("null = %q", got)
	}

	// Without the encryption key an envelope is absent rather than plaintext.
	noKey := &settingsReader{lookup: envLookup(map[string]string{})}
	stored.TelegramApiHash = rawJSON{raw: encrypted}
	if got := noKey.storedSecret(stored, func(s *storedSituationMonitorSettings) rawJSON {
		return s.TelegramApiHash
	}); got != "" {
		t.Fatalf("no key = %q", got)
	}
}

func TestRefreshReadinessBooleans(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[settingsCacheKey] = []byte(`{
		"exists":true,
		"value":{
			"telegramEnabled":true,
			"telegramApiId":"1",
			"telegramApiHash":"hash",
			"telegramSession":"session",
			"liveHlsProxyCnnAllowedHosts":[]
		}
	}`)
	reader := &settingsReader{cache: ops, lookup: envLookup(map[string]string{
		"SITUATION_MONITOR_OREF_ENABLED":    "true",
		"SITUATION_MONITOR_OREF_PROXY_AUTH": " tog oref ",
	})}
	readiness, orefConfigured, err := reader.refreshReadiness(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !readiness.Enabled || !readiness.HasAPIID || !readiness.HasHash || !readiness.HasSess {
		t.Fatalf("readiness = %+v", readiness)
	}
	if !orefConfigured || !reader.orefEnabled() || !reader.orefConfigured() {
		t.Fatalf("oref configured = %v", orefConfigured)
	}

	// Without the OREF environment variables the flags are false.
	plain := &settingsReader{cache: ops, lookup: envLookup(map[string]string{})}
	if _, configured, err := plain.refreshReadiness(t.Context()); err != nil || configured {
		t.Fatalf("configured = %v err = %v", configured, err)
	}
	if plain.orefEnabled() || plain.orefConfigured() {
		t.Fatal("oref must default to disabled and unconfigured")
	}
}

func TestBooleanEnv(t *testing.T) {
	cases := map[string]bool{
		"true": true, "TRUE": true, "1": true, "yes": true, "on": true,
		"false": false, "0": false, "no": false, "off": false, "": false,
	}
	for raw, want := range cases {
		reader := &settingsReader{lookup: envLookup(map[string]string{"FLAG": raw})}
		if got := reader.booleanEnv("FLAG", !want); got != want {
			t.Fatalf("%q -> %v, want %v", raw, got, want)
		}
	}
	// An unset variable keeps the fallback; an unrecognised value keeps it too.
	reader := &settingsReader{lookup: envLookup(map[string]string{})}
	if !reader.booleanEnv("FLAG", true) {
		t.Fatal("unset must keep the fallback")
	}
	reader = &settingsReader{lookup: envLookup(map[string]string{"FLAG": "maybe"})}
	if !reader.booleanEnv("FLAG", true) || reader.booleanEnv("FLAG", false) {
		t.Fatal("an unrecognised value must keep the fallback")
	}
}

func TestNormalizeHostEntry(t *testing.T) {
	if value, ok := normalizeHostEntry(" Example.Test "); !ok || value != "example.test" {
		t.Fatalf("value = %q/%v", value, ok)
	}
	for _, invalid := range []string{"", "bad host", "example.test/path", "example.test:8080", "user@example.test"} {
		if _, ok := normalizeHostEntry(invalid); ok {
			t.Fatalf("%q must not normalise", invalid)
		}
	}
}

func TestNormalizeAbsoluteURL(t *testing.T) {
	if value, ok := normalizeAbsoluteURL("HTTPS://Example.Test/live/", "https"); !ok || value != "https://example.test/live" {
		t.Fatalf("value = %q/%v", value, ok)
	}
	if _, ok := normalizeAbsoluteURL("http://example.test/live", "https"); ok {
		t.Fatal("http must be rejected when only https is allowed")
	}
	if _, ok := normalizeAbsoluteURL("not a url", "https"); ok {
		t.Fatal("a relative value must be rejected")
	}
}
