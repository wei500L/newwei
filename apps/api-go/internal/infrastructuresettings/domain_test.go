package infrastructuresettings

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// testVectorConfig is the environment default set used by the vector tests.
func testVectorConfig() Config {
	return Config{
		VectorEnabled:            false,
		VectorFallbackToMongo:    true,
		VectorBaseURL:            "http://env-vector:4010",
		VectorToken:              "env-token",
		VectorTimeoutMs:          5000,
		VectorMaxRetries:         2,
		S3Region:                 "us-east-1",
		S3PresignedURLTTLSeconds: 300,
	}
}

// TestVectorPublicModel locks source/tokenSource derivation and the stored-value
// coercion rules.
func TestVectorPublicModel(t *testing.T) {
	service := NewService(nil, nil, testVectorConfig())

	envOnly := service.vectorPublic(nil)
	if envOnly.Source != "env" || envOnly.Enabled || !envOnly.FallbackToMongo {
		t.Fatalf("env defaults = %+v", envOnly)
	}
	if envOnly.BaseURL == nil || *envOnly.BaseURL != "http://env-vector:4010" {
		t.Fatalf("env baseUrl = %v", envOnly.BaseURL)
	}
	if envOnly.TimeoutMs != 5000 || envOnly.MaxRetries != 2 || !envOnly.HasToken || envOnly.TokenSource != "env" {
		t.Fatalf("env model = %+v", envOnly)
	}

	stored := &vectorStoredSettings{
		Enabled:         json.RawMessage(`true`),
		FallbackToMongo: json.RawMessage(`false`),
		BaseURL:         json.RawMessage(`"http://db-vector:5000"`),
		Token:           json.RawMessage(`"stored-token"`),
		TimeoutMs:       json.RawMessage(`9000`),
		MaxRetries:      json.RawMessage(`5`),
	}
	fromDB := service.vectorPublic(stored)
	if fromDB.Source != "db" || !fromDB.Enabled || fromDB.FallbackToMongo {
		t.Fatalf("db model = %+v", fromDB)
	}
	if fromDB.TimeoutMs != 9000 || fromDB.MaxRetries != 5 || fromDB.TokenSource != "stored" {
		t.Fatalf("db model = %+v", fromDB)
	}

	coerced := service.vectorPublic(&vectorStoredSettings{
		Enabled:   json.RawMessage(`"yes"`),
		BaseURL:   json.RawMessage(`"   "`),
		Token:     json.RawMessage(`null`),
		TimeoutMs: json.RawMessage(`"7000"`),
	})
	if coerced.Enabled {
		t.Fatal("a non-boolean stored enabled value must keep the env default")
	}
	if coerced.BaseURL == nil || *coerced.BaseURL != "http://env-vector:4010" {
		t.Fatalf("blank stored baseUrl must fall back to env: %v", coerced.BaseURL)
	}
	if coerced.TimeoutMs != 7000 {
		t.Fatalf("numeric string timeoutMs must coerce: %d", coerced.TimeoutMs)
	}
	if coerced.TokenSource != "env" {
		t.Fatalf("explicit null token must fall back to env: %+v", coerced)
	}

	floor := service.vectorPublic(&vectorStoredSettings{
		TimeoutMs:  json.RawMessage(`9000.9`),
		MaxRetries: json.RawMessage(`-1`),
	})
	if floor.TimeoutMs != 9000 || floor.MaxRetries != 2 {
		t.Fatalf("floor/fallback = %+v", floor)
	}
}

// TestVectorURLNormalization locks the WHATWG-compatible normalization.
func TestVectorURLNormalization(t *testing.T) {
	cases := []struct {
		value string
		want  string
		bad   bool
	}{
		{"http://Vector:4010", "http://vector:4010", false},
		{"http://vector:80/", "http://vector", false},
		{"https://vector:443/base/", "https://vector/base", false},
		{"http://vector", "http://vector", false},
		{"http://vector/base/", "http://vector/base", false},
		{"http://user:pass@vector:4010/", "http://user:pass@vector:4010", false},
		{"ftp://vector", "", true},
		{"http://vector:99999", "", true},
		{"not a url", "", true},
		{"http://", "", true},
	}
	for _, tc := range cases {
		got, err := normalizeVectorURL(tc.value)
		if tc.bad {
			if err == nil {
				t.Fatalf("%q must be rejected, got %q", tc.value, got)
			}
			requireMessage(t, err, "baseUrl must be a valid http(s) URL")
			continue
		}
		if err != nil || got != tc.want {
			t.Fatalf("normalizeVectorURL(%q) = %q, %v; want %q", tc.value, got, err, tc.want)
		}
	}
}

// TestVectorPutTokenStates covers the four token states end to end against the
// in-memory store. A missing token must keep the row's current value (the
// IS3 contract), never a cached copy.
func TestVectorPutTokenStates(t *testing.T) {
	seeded := map[string]string{
		settingKeyVectorService: `{"enabled":false,"fallbackToMongo":true,"baseUrl":null,` +
			`"token":"stored-B","timeoutMs":5000,"maxRetries":2}`,
	}
	body := `{"enabled":false,"fallbackToMongo":true,"timeoutMs":5000,"maxRetries":2}`

	store := newFakeMySQL(seeded)
	service := NewService(store.db(), nil, testVectorConfig())
	dto, err := parseVectorSettingsRequest([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.updateVectorSettings(context.Background(), "org-1", "user-1", dto); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	raw, _ := store.setting(settingKeyVectorService)
	var written vectorStoredWrite
	if err := json.Unmarshal([]byte(raw), &written); err != nil {
		t.Fatal(err)
	}
	var kept string
	if err := json.Unmarshal(written.Token, &kept); err != nil || kept != "stored-B" {
		t.Fatalf("an omitted token must keep the database value, got %s", written.Token)
	}

	for _, tc := range []struct {
		name  string
		token string
	}{
		{"null", `"token":null,`},
		{"blank", `"token":"   ",`},
		{"empty", `"token":"",`},
	} {
		store := newFakeMySQL(seeded)
		service := NewService(store.db(), nil, testVectorConfig())
		payload := `{"enabled":false,"fallbackToMongo":true,` + tc.token + `"timeoutMs":5000,"maxRetries":2}`
		dto, err := parseVectorSettingsRequest([]byte(payload))
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if _, err := service.updateVectorSettings(context.Background(), "org-1", "user-1", dto); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		raw, _ := store.setting(settingKeyVectorService)
		var written vectorStoredWrite
		if err := json.Unmarshal([]byte(raw), &written); err != nil {
			t.Fatal(err)
		}
		if string(written.Token) != "null" {
			t.Fatalf("%s token must clear to null, got %s", tc.name, written.Token)
		}
	}

	// A non-empty token is encoded with the shared policy: without a key and
	// outside production that is the plaintext escape hatch.
	store = newFakeMySQL(seeded)
	service = NewService(store.db(), nil, testVectorConfig())
	dto, err = parseVectorSettingsRequest([]byte(
		`{"enabled":false,"fallbackToMongo":true,"token":"rotated","timeoutMs":5000,"maxRetries":2}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.updateVectorSettings(context.Background(), "org-1", "user-1", dto); err != nil {
		t.Fatal(err)
	}
	raw, _ = store.setting(settingKeyVectorService)
	var rotated vectorStoredWrite
	if err := json.Unmarshal([]byte(raw), &rotated); err != nil {
		t.Fatal(err)
	}
	var rotatedToken string
	if err := json.Unmarshal(rotated.Token, &rotatedToken); err != nil || rotatedToken != "rotated" {
		t.Fatalf("non-empty token must be stored: %s", rotated.Token)
	}

	// With a valid key and no system_security row the token is encrypted.
	key := make([]byte, systemSettingsKeyBytes)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	store = newFakeMySQL(seeded)
	encryptingConfig := testVectorConfig()
	encryptingConfig.EncryptionKeyRaw = hex.EncodeToString(key)
	encryptingConfig.EncryptionKeyPresent = true
	service = NewService(store.db(), nil, encryptingConfig)
	if _, err := service.updateVectorSettings(context.Background(), "org-1", "user-1", dto); err != nil {
		t.Fatal(err)
	}
	raw, _ = store.setting(settingKeyVectorService)
	var encryptedWritten vectorStoredWrite
	if err := json.Unmarshal([]byte(raw), &encryptedWritten); err != nil {
		t.Fatal(err)
	}
	envelope := parseStoredSecretValue(encryptedWritten.Token)
	if envelope.kind != secretEncrypted {
		t.Fatalf("token must be encrypted, got %s", encryptedWritten.Token)
	}
	plain, err := decryptStringValueV1(envelope.encrypted, key)
	if err != nil || plain != "rotated" {
		t.Fatalf("decrypt = %q %v", plain, err)
	}
}

// TestVectorPutValidation locks the enabled-required messages and the fact that
// a rejected update writes nothing.
func TestVectorPutValidation(t *testing.T) {
	store := newFakeMySQL(nil)
	// No environment baseUrl or token: the effective configuration then depends
	// entirely on the stored row, which is what makes the cross-field checks
	// reachable.
	bare := testVectorConfig()
	bare.VectorBaseURL = ""
	bare.VectorToken = ""
	service := NewService(store.db(), nil, bare)

	dto, err := parseVectorSettingsRequest([]byte(
		`{"enabled":true,"fallbackToMongo":true,"timeoutMs":5000,"maxRetries":2}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.updateVectorSettings(context.Background(), "org-1", "user-1", dto)
	requireMessage(t, err, "baseUrl is required when vector service is enabled")
	if _, written := store.setting(settingKeyVectorService); written {
		t.Fatal("a rejected update must not write the row")
	}

	dto, err = parseVectorSettingsRequest([]byte(
		`{"enabled":true,"fallbackToMongo":true,"baseUrl":"http://vector:4010","timeoutMs":5000,"maxRetries":2}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.updateVectorSettings(context.Background(), "org-1", "user-1", dto)
	requireMessage(t, err, "token is required when vector service is enabled")
	if _, written := store.setting(settingKeyVectorService); written {
		t.Fatal("a rejected update must not write the row")
	}

	// Error priority: the encryption policy is evaluated before the enabled
	// cross-field check, exactly like the NestJS call order.
	secretStore := newFakeMySQL(map[string]string{
		settingKeySystemSecurity: `{"secretEncryptionEnabled":true}`,
	})
	broken := testVectorConfig()
	broken.EncryptionKeyRaw = "short-key"
	broken.EncryptionKeyPresent = true
	broken.NodeEnv = "production"
	brokenService := NewService(secretStore.db(), nil, broken)
	dto, err = parseVectorSettingsRequest([]byte(
		`{"enabled":true,"fallbackToMongo":true,"token":"x","timeoutMs":5000,"maxRetries":2}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = brokenService.updateVectorSettings(context.Background(), "org-1", "user-1", dto)
	requireMessage(t, err,
		"Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid "+
			"(SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars)")
	if _, written := secretStore.setting(settingKeyVectorService); written {
		t.Fatal("a rejected update must not write the row")
	}
}

// TestVectorReset deletes the row and audits the reset.
func TestVectorReset(t *testing.T) {
	store := newFakeMySQL(map[string]string{
		settingKeyVectorService: `{"enabled":true,"fallbackToMongo":false,"baseUrl":"http://db:1","token":"t","timeoutMs":5000,"maxRetries":2}`,
	})
	service := NewService(store.db(), nil, testVectorConfig())
	result, err := service.resetVectorSettings(context.Background(), "org-1", "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if _, written := store.setting(settingKeyVectorService); written {
		t.Fatal("reset must delete the row")
	}
	if result.Source != "env" || result.Enabled {
		t.Fatalf("reset response = %+v", result)
	}
	if len(store.audits) != 1 || store.audits[0] != "vector_service_reset" {
		t.Fatalf("audits = %v", store.audits)
	}
}

// TestStoragePatchJSONNull locks IS4: a cleared field is written as the JSON
// literal null (never SQL NULL, never a deleted row).
func TestStoragePatchJSONNull(t *testing.T) {
	store := newFakeMySQL(nil)
	service := NewService(store.db(), nil, testVectorConfig())

	dto, err := parseStorageSettingsRequest([]byte(
		`{"endpoint":null,"forcePathStyle":false,"presignedUrlTtlSeconds":null}`))
	if err != nil {
		t.Fatal(err)
	}
	settings, err := service.updateStorageSettings(context.Background(), "org-1", "user-1", dto)
	if err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{
		settingKeyS3Endpoint:              "null",
		settingKeyS3ForcePathStyle:        "false",
		settingKeyS3PresignedURLTTLSecond: "null",
	} {
		value, ok := store.setting(key)
		if !ok || value != want {
			t.Fatalf("%s = %q (present=%v), want %q", key, value, ok, want)
		}
	}
	if settings.Endpoint != nil {
		t.Fatalf("a null endpoint with no env default must omit the key: %v", *settings.Endpoint)
	}
	if settings.ForcePathStyle {
		t.Fatal("forcePathStyle=false must survive the round trip")
	}
	if settings.PresignedURLTTLSeconds != 300 {
		t.Fatalf("a null TTL must fall back to the env default, got %v", settings.PresignedURLTTLSeconds)
	}
	if len(store.audits) != 1 {
		t.Fatalf("audits = %v", store.audits)
	}
}

// TestStoragePatchNormalization locks the per-field trimming and ignore rules.
func TestStoragePatchNormalization(t *testing.T) {
	store := newFakeMySQL(map[string]string{
		settingKeyS3Region: `"keep-me"`,
	})
	service := NewService(store.db(), nil, testVectorConfig())

	// An empty body and a blank-string-only body must not write anything.
	empty, err := parseStorageSettingsRequest([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.updateStorageSettings(context.Background(), "org-1", "user-1", empty); err != nil {
		t.Fatal(err)
	}
	if len(store.audits) != 0 {
		t.Fatalf("empty patch must not audit: %v", store.audits)
	}
	blanks, err := parseStorageSettingsRequest([]byte(`{"region":"   ","bucket":"","accessKeyId":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.updateStorageSettings(context.Background(), "org-1", "user-1", blanks); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.setting(settingKeyS3Region); value != `"keep-me"` {
		t.Fatalf("blank values must not overwrite: %s", value)
	}
	if _, ok := store.setting(settingKeyS3Bucket); ok {
		t.Fatal("blank values must not create rows")
	}
	if len(store.audits) != 0 {
		t.Fatalf("a no-op patch must not audit: %v", store.audits)
	}

	dto, err := parseStorageSettingsRequest([]byte(
		`{"region":"  us-west-2  ","crawlImageStorage":"s3","forcePathStyle":true,"presignedUrlTtlSeconds":600}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.updateStorageSettings(context.Background(), "org-1", "user-1", dto); err != nil {
		t.Fatal(err)
	}
	if value, _ := store.setting(settingKeyS3Region); value != `"us-west-2"` {
		t.Fatalf("region = %s", value)
	}
	if value, _ := store.setting(settingKeyCrawlImageStorage); value != `"s3"` {
		t.Fatalf("provider = %s", value)
	}
	if value, _ := store.setting(settingKeyS3PresignedURLTTLSecond); value != "600" {
		t.Fatalf("ttl = %s", value)
	}
	if len(store.audits) != 1 {
		t.Fatalf("audits = %v", store.audits)
	}
}

// TestStorageSecretFallbacks locks the three secret resolutions.
func TestStorageSecretFallbacks(t *testing.T) {
	key := make([]byte, systemSettingsKeyBytes)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	otherKey := make([]byte, systemSettingsKeyBytes)
	if _, err := rand.Read(otherKey); err != nil {
		t.Fatal(err)
	}
	envelope, err := encryptStringValueV1("stored-secret", key)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := envelope.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}

	config := testVectorConfig()
	config.EncryptionKeyRaw = hex.EncodeToString(key)
	config.EncryptionKeyPresent = true
	config.S3SecretAccessKey = "env-secret"
	service := NewService(nil, nil, config)

	if got, failed := service.resolveStorageSecret(encoded); got != "stored-secret" || failed {
		t.Fatalf("encrypted secret = %q failed=%v", got, failed)
	}
	if got, failed := service.resolveStorageSecret(json.RawMessage(`"plain-secret"`)); got != "plain-secret" || failed {
		t.Fatalf("plaintext secret = %q failed=%v", got, failed)
	}
	if got, failed := service.resolveStorageSecret(json.RawMessage(`""`)); got != "env-secret" || failed {
		t.Fatalf("empty secret must fall back without the flag: %q failed=%v", got, failed)
	}
	if got, failed := service.resolveStorageSecret(json.RawMessage(`5`)); got != "env-secret" || failed {
		t.Fatalf("invalid shape must fall back: %q failed=%v", got, failed)
	}

	wrongKeyConfig := config
	wrongKeyConfig.EncryptionKeyRaw = hex.EncodeToString(otherKey)
	wrongService := NewService(nil, nil, wrongKeyConfig)
	if got, failed := wrongService.resolveStorageSecret(encoded); got != "env-secret" || !failed {
		t.Fatalf("a wrong key must report decryption failure: %q failed=%v", got, failed)
	}

	noKeyConfig := config
	noKeyConfig.EncryptionKeyRaw = ""
	noKeyConfig.EncryptionKeyPresent = false
	noKeyService := NewService(nil, nil, noKeyConfig)
	if got, failed := noKeyService.resolveStorageSecret(encoded); got != "env-secret" || !failed {
		t.Fatalf("a missing key must report decryption failure: %q failed=%v", got, failed)
	}

	// getAdminSettings reports both flags at once when the env value exists.
	store := newFakeMySQL(map[string]string{settingKeyS3SecretAccessKey: string(encoded)})
	adminService := NewService(store.db(), nil, wrongKeyConfig)
	admin, err := adminService.getStorageAdminSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !admin.HasSecretAccessKey || !admin.SecretDecryptionFailed {
		t.Fatalf("fallback secret with a failed decryption = %+v", admin)
	}
}

// TestStorageAuditMasking locks the fingerprint formats and the null handling.
func TestStorageAuditMasking(t *testing.T) {
	region := "us-west-2"
	accessKeyID := "AKIAEXAMPLE"
	secret := "top-secret"
	forcePathStyle := false
	updates := storageUpdates{
		Region:            &region,
		AccessKeyID:       &accessKeyID,
		SecretAccessKey:   &secret,
		EndpointSet:       true,
		ForcePathStyleSet: true,
		ForcePathStyle:    &forcePathStyle,
	}
	metadata := buildStorageAuditMetadata(updates)
	if metadata.AccessKeyIDFingerprint == nil || *metadata.AccessKeyIDFingerprint != "AKIA***" {
		t.Fatalf("access key fingerprint = %v", metadata.AccessKeyIDFingerprint)
	}
	if metadata.SecretAccessKey == nil || *metadata.SecretAccessKey != "***" {
		t.Fatalf("secret mask = %v", metadata.SecretAccessKey)
	}
	if string(metadata.Endpoint) != "null" {
		t.Fatalf("endpoint = %s", metadata.Endpoint)
	}
	if string(metadata.ForcePathStyle) != "false" {
		t.Fatalf("forcePathStyle = %s", metadata.ForcePathStyle)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), accessKeyID) || strings.Contains(string(encoded), secret) {
		t.Fatalf("audit metadata leaked credential material: %s", encoded)
	}
}

// TestRuntimeSecretsStrictParser locks every 400/409 branch.
func TestRuntimeSecretsStrictParser(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		detail string
	}{
		{"scalar", `"x"`, "Expected object with entries array."},
		{"number", `5`, "Expected object with entries array."},
		{"array", `[]`, "entries must be an array."},
		{"missing entries", `{}`, "entries must be an array."},
		{"entries scalar", `{"entries":"x"}`, "entries must be an array."},
		{"version number", `{"version":2,"entries":[]}`, "Unsupported version for runtime secrets settings."},
		{"version string", `{"version":"1","entries":[]}`, "Unsupported version for runtime secrets settings."},
		{"version null", `{"version":null,"entries":[]}`, "Unsupported version for runtime secrets settings."},
		{"bad entry", `{"entries":[1]}`, "entries contains invalid object."},
		{"bad entry null", `{"entries":[null]}`, "entries contains invalid object."},
		{"bad value", `{"entries":[{"sourceId":"a","key":"k"}]}`, "Invalid value type for a.k."},
		{"bad value type", `{"entries":[{"sourceId":"a","key":"k","value":5}]}`, "Invalid value type for a.k."},
	}
	for _, tc := range cases {
		_, err := parseRuntimeSecretsStrict(json.RawMessage(tc.raw))
		if err == nil {
			t.Fatalf("%s: expected a 409", tc.name)
		}
		var coded *httpError
		if !errors.As(err, &coded) {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if coded.status != 409 || coded.code != "NEWS_SOURCE_RUNTIME_SECRETS_INVALID" ||
			coded.message != "Stored news source runtime secrets are invalid." || coded.detail != tc.detail {
			t.Fatalf("%s: conflict = %+v", tc.name, coded)
		}
	}

	if settings, err := parseRuntimeSecretsStrict(json.RawMessage(`null`)); err != nil || settings != nil {
		t.Fatalf("null record = %+v %v", settings, err)
	}

	// A broken sourceId/key stays a business 400, not a 409. Note that a
	// numeric sourceId is String()-ified to "1" and therefore still valid.
	_, err := parseRuntimeSecretsStrict(json.RawMessage(`{"entries":[{"sourceId":null}]}`))
	requireMessage(t, err, "sourceId must match /^[a-z0-9_-]+$/i")
	_, err = parseRuntimeSecretsStrict(json.RawMessage(`{"entries":[[]]}`))
	requireMessage(t, err, "sourceId must match /^[a-z0-9_-]+$/i")
	numeric, err := parseRuntimeSecretsStrict(json.RawMessage(`{"entries":[{"sourceId":1,"key":"k","value":"v"}]}`))
	if err != nil || numeric.Entries[0].SourceID != "1" {
		t.Fatalf("a numeric sourceId must stringify: %+v %v", numeric, err)
	}

	// Valid records: normalization, fingerprint, last-wins and sorting.
	settings, err := parseRuntimeSecretsStrict(json.RawMessage(
		`{"version":1,"entries":[` +
			`{"sourceId":"Beta","key":"Cookie","value":"v1"},` +
			`{"sourceId":"alpha","key":"key2","value":"v2"},` +
			`{"sourceId":"beta","key":"Cookie","value":"v3","fingerprint":"  abcd  ",` +
			`"updatedAt":"2026-01-02T03:04:05.000Z"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Entries) != 2 {
		t.Fatalf("entries = %+v", settings.Entries)
	}
	if settings.Entries[0].SourceID != "alpha" || settings.Entries[0].Key != "key2" {
		t.Fatalf("first entry = %+v", settings.Entries[0])
	}
	beta := settings.Entries[1]
	if beta.SourceID != "beta" || beta.Key != "Cookie" || beta.Fingerprint != "abcd" {
		t.Fatalf("last-wins entry = %+v", beta)
	}
	if beta.UpdatedAt != "2026-01-02T03:04:05.000Z" {
		t.Fatalf("updatedAt = %q", beta.UpdatedAt)
	}

	// A missing fingerprint falls back to the 16 character SHA-256 prefix.
	settings, err = parseRuntimeSecretsStrict(json.RawMessage(`{"entries":[{"sourceId":"a","key":"k","value":"secret"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.Entries[0].Fingerprint != fingerprintSecretValue("secret") {
		t.Fatalf("fingerprint = %q", settings.Entries[0].Fingerprint)
	}

	// An unparseable updatedAt falls back to the current time.
	settings, err = parseRuntimeSecretsStrict(json.RawMessage(
		`{"entries":[{"sourceId":"a","key":"k","value":"v","updatedAt":"not-a-date"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	parsed, parseErr := time.Parse("2006-01-02T15:04:05.000Z", settings.Entries[0].UpdatedAt)
	if parseErr != nil {
		t.Fatalf("updatedAt = %q", settings.Entries[0].UpdatedAt)
	}
	if delta := time.Since(parsed); delta < -time.Minute || delta > time.Minute {
		t.Fatalf("invalid updatedAt must fall back to now, got %s", settings.Entries[0].UpdatedAt)
	}
}

// TestRuntimeSecretsUpdateMerge locks remove-before-upsert, upsert-wins,
// untouched entries and the noop path.
func TestRuntimeSecretsUpdateMerge(t *testing.T) {
	seed := `{"version":1,"entries":[` +
		`{"sourceId":"alpha","key":"k1","value":"v1","fingerprint":"1111111111111111","updatedAt":"2026-01-01T00:00:00.000Z"},` +
		`{"sourceId":"beta","key":"k2","value":"v2","fingerprint":"2222222222222222","updatedAt":"2026-01-01T00:00:00.000Z"}]}`
	store := newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: seed})
	service := NewService(store.db(), nil, testVectorConfig())

	// The DTO patterns reject whitespace, so the trim/lowercase normalisation is
	// exercised with values that already pass validation (uppercase sourceId,
	// untrimmed value).
	dto, err := parseRuntimeSecretsRequest([]byte(
		`{"upserts":[{"sourceId":"GAMMA","key":"k3","value":" v3 "},` +
			`{"sourceId":"alpha","key":"k1","value":"updated"}],` +
			`"removes":[{"sourceId":"beta","key":"k2"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.updateRuntimeSecrets(context.Background(), "org-1", "user-1", dto)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "db" || len(result.Entries) != 2 {
		t.Fatalf("result = %+v", result)
	}
	if result.Entries[0].SourceID != "alpha" || result.Entries[0].Key != "k1" {
		t.Fatalf("entries = %+v", result.Entries)
	}
	if result.Entries[0].UpdatedAt == "2026-01-01T00:00:00.000Z" {
		t.Fatal("an upserted entry must get a fresh updatedAt")
	}
	if result.Entries[0].Fingerprint != fingerprintSecretValue("updated") {
		t.Fatalf("fingerprint = %q", result.Entries[0].Fingerprint)
	}
	if result.Entries[1].SourceID != "gamma" || result.Entries[1].Key != "k3" {
		t.Fatalf("normalized entry = %+v", result.Entries[1])
	}
	if len(store.audits) != 1 {
		t.Fatalf("audits = %v", store.audits)
	}

	// Same key removed and upserted: the upsert wins.
	store = newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: seed})
	service = NewService(store.db(), nil, testVectorConfig())
	dto, err = parseRuntimeSecretsRequest([]byte(
		`{"upserts":[{"sourceId":"beta","key":"k2","value":"survivor"}],` +
			`"removes":[{"sourceId":"beta","key":"k2"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	result, err = service.updateRuntimeSecrets(context.Background(), "org-1", "user-1", dto)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range result.Entries {
		if entry.SourceID == "beta" && entry.Fingerprint == fingerprintSecretValue("survivor") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the upsert must win over the remove: %+v", result.Entries)
	}

	// A no-op PUT must not write or audit.
	store = newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: seed})
	service = NewService(store.db(), nil, testVectorConfig())
	dto, err = parseRuntimeSecretsRequest([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.updateRuntimeSecrets(context.Background(), "org-1", "user-1", dto); err != nil {
		t.Fatal(err)
	}
	if len(store.audits) != 0 {
		t.Fatalf("a no-op PUT must not audit: %v", store.audits)
	}
	if value, _ := store.setting(settingKeyRuntimeSecrets); value != seed {
		t.Fatal("a no-op PUT must not rewrite the row")
	}

	// Removing the last entry deletes the row.
	store = newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: seed})
	service = NewService(store.db(), nil, testVectorConfig())
	dto, err = parseRuntimeSecretsRequest([]byte(
		`{"removes":[{"sourceId":"alpha","key":"k1"},{"sourceId":"beta","key":"k2"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	result, err = service.updateRuntimeSecrets(context.Background(), "org-1", "user-1", dto)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "none" || len(result.Entries) != 0 {
		t.Fatalf("result = %+v", result)
	}
	if _, present := store.setting(settingKeyRuntimeSecrets); present {
		t.Fatal("an emptied record must delete the row")
	}

	// The 2000 entry cap is enforced on the merged result.
	big := runtimeSecretsWriteDocument{Version: 1}
	for index := 0; index < runtimeSecretsMaxEntries; index++ {
		big.Entries = append(big.Entries, runtimeSecretsWriteEntry{
			SourceID: "s", Key: itoa(index), Value: json.RawMessage(`"v"`),
			Fingerprint: "0000000000000000", UpdatedAt: "2026-01-01T00:00:00.000Z",
		})
	}
	encodedBig, err := json.Marshal(big)
	if err != nil {
		t.Fatal(err)
	}
	store = newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: string(encodedBig)})
	service = NewService(store.db(), nil, testVectorConfig())
	dto, err = parseRuntimeSecretsRequest([]byte(`{"upserts":[{"sourceId":"s","key":"overflow","value":"v"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.updateRuntimeSecrets(context.Background(), "org-1", "user-1", dto)
	requireMessage(t, err, "Too many runtime secrets entries (max 2000)")
}

// TestRuntimeSecretsCorruptRow is not silently overwritten.
func TestRuntimeSecretsCorruptRowIsNotOverwritten(t *testing.T) {
	store := newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: `{"entries":"broken"}`})
	service := NewService(store.db(), nil, testVectorConfig())
	if _, err := service.getRuntimeSecretsPublic(context.Background()); err == nil {
		t.Fatal("the management GET must reject a corrupt row")
	}
	dto, err := parseRuntimeSecretsRequest([]byte(`{"upserts":[{"sourceId":"a","key":"k","value":"v"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.updateRuntimeSecrets(context.Background(), "org-1", "user-1", dto); err == nil {
		t.Fatal("a corrupt row must not be silently replaced")
	}
	if value, _ := store.setting(settingKeyRuntimeSecrets); value != `{"entries":"broken"}` {
		t.Fatalf("the corrupt row changed: %s", value)
	}
}

// TestUTF16VersusCodePoints locks the DTO (code points) versus service (UTF-16)
// length difference.
func TestUTF16VersusCodePoints(t *testing.T) {
	emoji := "😀"
	value := strings.Repeat(emoji, runtimeSecretsValMaxRunes)
	body := `{"upserts":[{"sourceId":"a","key":"k","value":"` + value + `"}]}`
	dto, err := parseRuntimeSecretsRequest([]byte(body))
	if err != nil {
		t.Fatalf("the DTO counts code points, so this must pass: %v", err)
	}
	if _, err := normalizeRuntimeValue(dto.Upserts[0].Value); err == nil {
		t.Fatal("the service counts UTF-16 code units, so this must fail")
	} else {
		requireMessage(t, err, "value must be <= 8192 chars")
	}

	key := strings.Repeat(emoji, runtimeSecretsKeyMaxRunes)
	if _, err := normalizeRuntimeKey(key); err == nil {
		t.Fatal("a 128 emoji key must fail the UTF-16 length check")
	}
	if utf16Length(emoji) != 2 || len([]rune(emoji)) != 1 {
		t.Fatalf("utf16Length=%d runes=%d", utf16Length(emoji), len([]rune(emoji)))
	}
	if utf16Slice("😀abcd", 0, 4) != "😀ab" {
		t.Fatalf("utf16Slice = %q", utf16Slice("😀abcd", 0, 4))
	}
}

// TestLockProtocol covers acquisition failure, release after cancellation and
// the release-failure path.
func TestLockProtocol(t *testing.T) {
	ctx := context.Background()

	// Acquisition timeout: the callback must not run and nothing may be written.
	store := newFakeMySQL(nil)
	store.lockOK = false
	service := NewService(store.db(), nil, testVectorConfig())
	called := false
	err := service.withSessionLock(ctx, lockVectorService, func(context.Context) error {
		called = true
		return nil
	})
	if !errors.Is(err, errLockUnavailable) {
		t.Fatalf("lock failure = %v", err)
	}
	if called {
		t.Fatal("the callback must not run without the lock")
	}
	for _, statement := range store.state.snapshot() {
		if strings.Contains(statement, "INSERT") || strings.Contains(statement, "DELETE") {
			t.Fatalf("a failed lock must not write: %s", statement)
		}
	}

	// Cancellation inside the callback: the release still runs on a live
	// context, which is proven by the RELEASE_LOCK call reaching the driver.
	store = newFakeMySQL(nil)
	service = NewService(store.db(), nil, testVectorConfig())
	cancelCtx, cancel := context.WithCancel(context.Background())
	err = service.withSessionLock(cancelCtx, lockVectorService, func(context.Context) error {
		cancel()
		return nil
	})
	if err != nil {
		t.Fatalf("cancelled request must still release the lock: %v", err)
	}
	if !store.state.releaseCalled {
		t.Fatal("RELEASE_LOCK must be attempted after a cancelled request")
	}

	// A failed release evicts the physical connection instead of returning a
	// possibly still-locked session to the pool.
	store = newFakeMySQL(nil)
	store.releaseFails = true
	service = NewService(store.db(), nil, testVectorConfig())
	if err := service.withSessionLock(ctx, lockVectorService, func(context.Context) error { return nil }); err != nil {
		t.Fatalf("a failed release must not surface as an error: %v", err)
	}
	if !store.state.releaseCalled {
		t.Fatal("RELEASE_LOCK must be attempted")
	}
}

// TestAuditOutboxFallback covers the direct insert, the outbox fallback and the
// both-failed error path.
func TestAuditOutboxFallback(t *testing.T) {
	metadata := json.RawMessage(`{"ok":true}`)

	store := newFakeMySQL(nil)
	service := NewService(store.db(), nil, testVectorConfig())
	if err := service.writeAuditLogBestEffort(context.Background(), "org-1", "user-1", "x", metadata); err != nil {
		t.Fatalf("direct audit failed: %v", err)
	}
	if len(store.audits) != 1 {
		t.Fatalf("audits = %v", store.audits)
	}

	store = newFakeMySQL(nil)
	store.auditFails = true
	service = NewService(store.db(), nil, testVectorConfig())
	if err := service.writeAuditLogBestEffort(context.Background(), "org-1", "machine:tok", "x", metadata); err != nil {
		t.Fatalf("outbox fallback failed: %v", err)
	}
	sawOutbox := false
	for _, statement := range store.state.snapshot() {
		if strings.Contains(statement, "INSERT INTO AuditLogOutbox") {
			sawOutbox = true
		}
	}
	if !sawOutbox {
		t.Fatal("the outbox fallback must be attempted")
	}

	store = newFakeMySQL(nil)
	store.auditFails = true
	store.outboxFails = true
	service = NewService(store.db(), nil, testVectorConfig())
	if err := service.writeAuditLogBestEffort(context.Background(), "org-1", "user-1", "x", metadata); err == nil {
		t.Fatal("both audit writes failing must surface an error")
	}
}

// TestSystemSecurityConfiguredFallbacks locks the read-only policy resolution.
func TestSystemSecurityConfiguredFallbacks(t *testing.T) {
	service := NewService(nil, nil, Config{})
	if configured, ok := service.systemSecurityConfigured(context.Background()); ok || configured {
		t.Fatalf("no row = %v %v", configured, ok)
	}

	store := newFakeMySQL(map[string]string{settingKeySystemSecurity: `{"secretEncryptionEnabled":false}`})
	service = NewService(store.db(), nil, Config{})
	if configured, ok := service.systemSecurityConfigured(context.Background()); !ok || configured {
		t.Fatalf("false row = %v %v", configured, ok)
	}

	store = newFakeMySQL(map[string]string{settingKeySystemSecurity: `{"secretEncryptionEnabled":"yes"}`})
	service = NewService(store.db(), nil, Config{})
	if configured, ok := service.systemSecurityConfigured(context.Background()); !ok || configured {
		t.Fatalf("non-boolean row = %v %v", configured, ok)
	}
}

// TestVectorStoredParsing locks the object/array/null classification.
func TestVectorStoredParsing(t *testing.T) {
	if settings := parseVectorStoredSettings(json.RawMessage(`null`)); settings != nil {
		t.Fatalf("null = %+v", settings)
	}
	if settings := parseVectorStoredSettings(json.RawMessage(`"x"`)); settings != nil {
		t.Fatalf("string = %+v", settings)
	}
	if settings := parseVectorStoredSettings(json.RawMessage(`5`)); settings != nil {
		t.Fatalf("number = %+v", settings)
	}
	if settings := parseVectorStoredSettings(json.RawMessage(`{}`)); settings == nil {
		t.Fatal("object must parse")
	}
	if settings := parseVectorStoredSettings(json.RawMessage(`[]`)); settings == nil {
		t.Fatal("arrays are objects in JavaScript and must still count as a stored row")
	}
}

// TestNormalizeRuntimeUpsertsLastWins locks the dedupe semantics.
func TestNormalizeRuntimeUpsertsLastWins(t *testing.T) {
	upserts, err := normalizeRuntimeUpserts([]runtimeSecretUpsertInput{
		{SourceID: " Example ", Key: " Cookie ", Value: " first "},
		{SourceID: "example", Key: "Cookie", Value: "second"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(upserts) != 1 || upserts[0].Value != "second" {
		t.Fatalf("upserts = %+v", upserts)
	}
	if upserts[0].SourceID != "example" || upserts[0].Key != "Cookie" {
		t.Fatalf("normalization = %+v", upserts[0])
	}
	if _, err := normalizeRuntimeUpserts([]runtimeSecretUpsertInput{{SourceID: "a", Key: "k", Value: "   "}}); err == nil {
		t.Fatal("a blank value must be rejected")
	}
}

// TestFingerprintIsSixteenHex locks the fingerprint width.
func TestFingerprintIsSixteenHex(t *testing.T) {
	fingerprint := fingerprintSecretValue("secret")
	if len(fingerprint) != 16 {
		t.Fatalf("fingerprint = %q", fingerprint)
	}
	for _, char := range fingerprint {
		if !strings.ContainsRune("0123456789abcdef", char) {
			t.Fatalf("fingerprint is not lowercase hex: %q", fingerprint)
		}
	}
}

// TestHandlerFailsClosed locks the handler dispatch: without a wired
// authenticator the taken-over paths fail closed, and any other path is a 404
// so the routing table is the only thing that decides ownership.
func TestHandlerFailsClosed(t *testing.T) {
	handler := NewHandler(nil, nil)
	for _, path := range []string{pathVectorService, pathStorageSettings, pathRuntimeSecrets} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s status = %d, want 503", path, recorder.Code)
		}
	}
	// With a wired handler the dispatch table answers 404 for anything it does
	// not own, so the routing table stays the only thing that decides ownership.
	wired := NewHandler(&Authenticator{}, NewService(nil, nil, Config{}))
	recorder := httptest.NewRecorder()
	wired.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, pathVectorService+"/diagnostics", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unrouted status = %d, want 404", recorder.Code)
	}
}
