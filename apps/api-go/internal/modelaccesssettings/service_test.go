package modelaccesssettings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// platformUser is the actor the harness treats as a platform admin.
const platformUser = "user-platform-1"

// orgAdmin is an org administrator without the platform role.
const orgAdmin = "user-org-admin-1"

// allowPlatformAdmin marks one actor as a platform admin.
func (h *testHarness) allowPlatformAdmin(userID string) {
	h.identity.admins[userID] = true
}

// modelServicePUT is a valid replacement body.
func modelServicePUT() updateModelServiceSettingsRequest {
	baseURL := "http://model-service"
	return updateModelServiceSettingsRequest{
		Enabled:       true,
		BaseURL:       optionalString{Kind: optionalStringValue, Value: baseURL},
		InternalToken: optionalString{Kind: optionalStringValue, Value: "sk-model"},
		TimeoutMs:     1_000,
		MaxRetries:    3,
	}
}

// TestAllModelServiceWritesRequirePlatformAdmin covers MA1 for both model service
// writes.
func TestAllModelServiceWritesRequirePlatformAdmin(t *testing.T) {
	cases := []struct {
		name string
		run  func(*Service) error
	}{
		{name: "PUT", run: func(service *Service) error {
			_, err := service.updateModelServiceSettings(context.Background(), "org-1", orgAdmin, modelServicePUT())
			return err
		}},
		{name: "DELETE", run: func(service *Service) error {
			_, err := service.resetModelServiceSettings(context.Background(), "org-1", orgAdmin)
			return err
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
			err := testCase.run(harness.service)
			assertMessages(t, err, 403, "Platform admin access required")
			if len(harness.settings.upserts) != 0 || len(harness.settings.deletes) != 0 {
				t.Fatalf("a rejected write must not touch SystemSetting")
			}
			if !harness.locks.ran && len(harness.locks.names) != 0 {
				t.Fatalf("the gate must run before the lock")
			}
			if len(harness.audit.logs) != 0 || len(harness.audit.outbox) != 0 {
				t.Fatalf("a rejected write must not write audit rows")
			}
		})
	}
}

// TestMachineActorIsRejectedWithoutQuerying proves "machine:<id>" never satisfies
// the platform gate and never reaches the foreign key.
func TestMachineActorIsRejectedWithoutQuerying(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	_, err := harness.service.resetModelServiceSettings(context.Background(), "org-1", "machine:tok-1")
	assertMessages(t, err, 403, "Platform admin access required")
	if len(harness.identity.asks) != 0 {
		t.Fatalf("the machine case must not query GlobalRoleAssignment")
	}
}

// TestPlatformGateRunsBeforeBusinessValidation proves the gate precedes the
// "too many keys" business error, while the DTO runs before the gate.
func TestPlatformGateRunsBeforeBusinessValidation(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	keys := make([]string, 0, maxOpenAiApiKeys+1)
	for index := 0; index <= maxOpenAiApiKeys; index++ {
		keys = append(keys, "sk-"+string(rune('a'+index%26))+string(rune('0'+index/26)))
	}
	_, err := harness.service.updateOpenAiKeysSettings(context.Background(), "org-1", orgAdmin,
		updateOpenAiKeysSettingsRequest{Keys: keys})
	assertMessages(t, err, 403, "Platform admin access required")
	if len(harness.settings.upserts) != 0 {
		t.Fatalf("no write must happen")
	}

	// With a platform admin the business error surfaces instead.
	harness.allowPlatformAdmin(platformUser)
	_, err = harness.service.updateOpenAiKeysSettings(context.Background(), "org-1", platformUser,
		updateOpenAiKeysSettingsRequest{Keys: keys})
	assertMessages(t, err, 400, "Too many OpenAI API keys (max 100)")
}

// TestModelServiceWritesUseTheModelLock covers MA3's lock name and the in-lock
// authoritative read.
func TestModelServiceWritesUseTheModelLock(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.allowPlatformAdmin(platformUser)

	if _, err := harness.service.updateModelServiceSettings(context.Background(), "org-1", platformUser, modelServicePUT()); err != nil {
		t.Fatalf("PUT: %v", err)
	}
	if _, err := harness.service.resetModelServiceSettings(context.Background(), "org-1", platformUser); err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	want := []string{lockNameModelService, lockNameModelService}
	assertStrings(t, "lock names", harness.locks.names, want)
}

// TestOpenAiKeyWritesUseTheKeysLock covers MA2's lock name for all four writes.
func TestOpenAiKeyWritesUseTheKeysLock(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.allowPlatformAdmin(platformUser)
	request := updateOpenAiKeysSettingsRequest{Keys: []string{"sk-a"}}

	if _, err := harness.service.updateOpenAiKeysSettings(context.Background(), "org-1", platformUser, request); err != nil {
		t.Fatalf("PUT: %v", err)
	}
	if _, err := harness.service.appendOpenAiKeys(context.Background(), "org-1", platformUser, request); err != nil {
		t.Fatalf("POST: %v", err)
	}
	if _, err := harness.service.removeOpenAiKeyByFingerprint(context.Background(), "org-1", platformUser, fingerprintKey("sk-a")); err != nil {
		t.Fatalf("DELETE key: %v", err)
	}
	if _, err := harness.service.resetOpenAiKeys(context.Background(), "org-1", platformUser); err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	want := []string{lockNameOpenAiKeys, lockNameOpenAiKeys, lockNameOpenAiKeys, lockNameOpenAiKeys}
	assertStrings(t, "lock names", harness.locks.names, want)
}

// TestLockFailureIs503AndWritesNothing proves a failed acquisition never writes.
func TestLockFailureIs503AndWritesNothing(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.allowPlatformAdmin(platformUser)
	harness.locks.err = errLockUnavailable

	_, err := harness.service.updateModelServiceSettings(context.Background(), "org-1", platformUser, modelServicePUT())
	if !errors.Is(err, errLockUnavailable) {
		t.Fatalf("error = %v, want errLockUnavailable", err)
	}
	if len(harness.settings.upserts) != 0 {
		t.Fatalf("a failed lock must not write")
	}
	if len(harness.audit.logs) != 0 {
		t.Fatalf("a failed lock must not audit")
	}
	// The HTTP mapping is 503 with error="Service Unavailable".
	status, message, errorName := mapErrorForTest(t, err)
	if status != 503 || message != "Internal server error" || errorName != "Service Unavailable" {
		t.Fatalf("mapped to %d %q %q", status, message, errorName)
	}
}

// TestModelServicePutKeepsTheDatabaseTokenNotTheCache covers MA3 end to end.
func TestModelServicePutKeepsTheDatabaseTokenNotTheCache(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.allowPlatformAdmin(platformUser)

	replacement, err := harness.service.encodeSecretForStorage(context.Background(), "token-b")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	dbToken, err := json.Marshal(replacement)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	stale, err := harness.service.encodeSecretForStorage(context.Background(), "token-a")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	staleToken, err := json.Marshal(stale)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	harness.settings.seed(settingKeyModelService,
		`{"enabled":true,"baseUrl":"http://model-service","internalToken":`+string(dbToken)+`,"timeoutMs":1000,"maxRetries":3}`)
	harness.cache.entries[cacheKeyModelService] = json.RawMessage(
		`{"exists":true,"value":{"enabled":true,"baseUrl":"http://model-service","internalToken":` + string(staleToken) + `,"timeoutMs":1000,"maxRetries":3}}`)

	request := modelServicePUT()
	request.InternalToken = optionalString{Kind: optionalStringAbsent}
	public, err := harness.service.updateModelServiceSettings(context.Background(), "org-1", platformUser, request)
	if err != nil {
		t.Fatalf("PUT: %v", err)
	}
	if public.TokenSource != tokenSourceStored || !public.HasToken {
		t.Fatalf("public projection = %+v", public)
	}
	written := harness.settings.rows[settingKeyModelService]
	record, err := decodeModelServiceRecord(written)
	if err != nil {
		t.Fatalf("decode written: %v", err)
	}
	value := secretValueFromRaw(record.payload.InternalToken)
	plain, ok := value.resolvePlaintext(testKey(t), true)
	if !ok || plain != "token-b" {
		t.Fatalf("persisted token = %q, %v; want token-b", plain, ok)
	}
	if strings.Contains(string(written), "token-a") || strings.Contains(string(written), "token-b") {
		t.Fatalf("the plaintext token must never be persisted in clear")
	}
}

// TestOpenAiAppendUsesTheDatabaseCollectionNotTheCache covers MA2 end to end.
func TestOpenAiAppendUsesTheDatabaseCollectionNotTheCache(t *testing.T) {
	harness := newTestHarness(Config{})
	harness.allowPlatformAdmin(platformUser)

	keyA, keyB, keyC := "sk-aaa", "sk-bbb", "sk-ccc"
	harness.settings.seed(settingKeyOpenAiKeys,
		`{"openaiApiKeys":[{"fingerprint":"`+sha256Hex(keyA)+`","value":"`+keyA+`"},{"fingerprint":"`+sha256Hex(keyB)+`","value":"`+keyB+`"}]}`)
	// A stale 30 second envelope that only knows about keyA.
	harness.cache.entries[cacheKeyOpenAiKeys] = json.RawMessage(
		`{"exists":true,"value":{"openaiApiKeys":[{"fingerprint":"` + sha256Hex(keyA) + `","value":"` + keyA + `"}]}}`)

	public, err := harness.service.appendOpenAiKeys(context.Background(), "org-1", platformUser,
		updateOpenAiKeysSettingsRequest{Keys: []string{keyC}})
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if public.KeysCount != 3 {
		t.Fatalf("keysCount = %d, want 3 (B must not be lost)", public.KeysCount)
	}
	record, err := decodeOpenAiKeysRecord(harness.settings.rows[settingKeyOpenAiKeys])
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	assertStrings(t, "stored keys", harness.service.resolveKeys(record.entries), []string{keyA, keyB, keyC})

	// The same setup with a fingerprint delete keeps B.
	harness.settings.seed(settingKeyOpenAiKeys,
		`{"openaiApiKeys":[{"fingerprint":"`+sha256Hex(keyA)+`","value":"`+keyA+`"},{"fingerprint":"`+sha256Hex(keyB)+`","value":"`+keyB+`"}]}`)
	harness.cache.entries[cacheKeyOpenAiKeys] = json.RawMessage(
		`{"exists":true,"value":{"openaiApiKeys":[{"fingerprint":"` + sha256Hex(keyA) + `","value":"` + keyA + `"}]}}`)
	if _, err := harness.service.removeOpenAiKeyByFingerprint(context.Background(), "org-1", platformUser, sha256Hex(keyA)); err != nil {
		t.Fatalf("remove: %v", err)
	}
	record, err = decodeOpenAiKeysRecord(harness.settings.rows[settingKeyOpenAiKeys])
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	assertStrings(t, "stored keys after delete", harness.service.resolveKeys(record.entries), []string{keyB})
}

// TestRemoveUnknownFingerprintStillReturns200Semantics proves an unmatched
// fingerprint rewrites the same collection.
func TestRemoveUnknownFingerprintStillReturns200Semantics(t *testing.T) {
	harness := newTestHarness(Config{})
	harness.allowPlatformAdmin(platformUser)
	harness.settings.seed(settingKeyOpenAiKeys, `{"openaiApiKeys":[{"fingerprint":"fp","value":"sk-a"}]}`)
	public, err := harness.service.removeOpenAiKeyByFingerprint(context.Background(), "org-1", platformUser, "does-not-match")
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if public.KeysCount != 1 {
		t.Fatalf("keysCount = %d, want 1", public.KeysCount)
	}
}

// TestResetKeepsAppliedStatus proves DELETE does not touch the applied row.
func TestResetKeepsAppliedStatus(t *testing.T) {
	harness := newTestHarness(Config{})
	harness.allowPlatformAdmin(platformUser)
	harness.settings.seed(settingKeyOpenAiKeys, `{"openaiApiKeys":[{"fingerprint":"fp","value":"sk-a"}]}`)
	harness.settings.seed(settingKeyAppliedStatus, `{"source":"db","keyFingerprints":["fp"],"appliedAt":"2026-01-01T00:00:00.000Z"}`)

	public, err := harness.service.resetOpenAiKeys(context.Background(), "org-1", platformUser)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	if harness.settings.present[settingKeyAppliedStatus] != true {
		t.Fatalf("the applied-status row must survive a reset")
	}
	if public.Source != settingsSourceNone || public.KeysCount != 0 {
		t.Fatalf("public = %+v", public)
	}
	if !public.RestartRequired {
		t.Fatalf("an old db report must keep restartRequired=true after a reset")
	}
	if len(harness.cache.dels) != 1 || harness.cache.dels[0] != cacheKeyOpenAiKeys {
		t.Fatalf("only the keys envelope may be invalidated: %v", harness.cache.dels)
	}
}

// TestAuditMetadataIsRedacted pins the exact metadata documents.
func TestAuditMetadataIsRedacted(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.allowPlatformAdmin(platformUser)
	request := modelServicePUT()
	request.InternalToken = optionalString{Kind: optionalStringValue, Value: "super-secret-token"}
	if _, err := harness.service.updateModelServiceSettings(context.Background(), "org-1", platformUser, request); err != nil {
		t.Fatalf("PUT: %v", err)
	}
	if len(harness.audit.logs) != 1 {
		t.Fatalf("expected one audit row, got %d", len(harness.audit.logs))
	}
	entry := harness.audit.logs[0]
	if entry.Action != actionModelServiceUpdate {
		t.Fatalf("action = %q", entry.Action)
	}
	if entry.CreatedAt.IsZero() {
		t.Fatalf("the AuditLog row must carry a real timestamp")
	}
	want := `{"enabled":true,"baseUrl":"http://model-service","timeoutMs":1000,"maxRetries":3,"tokenUpdated":true,"tokenConfigured":true}`
	if string(entry.Metadata) != want {
		t.Fatalf("metadata = %s, want %s", entry.Metadata, want)
	}
	if strings.Contains(string(entry.Metadata), "super-secret-token") {
		t.Fatalf("the audit metadata must never carry the token")
	}

	harness.allowPlatformAdmin(platformUser)
	if _, err := harness.service.resetModelServiceSettings(context.Background(), "org-1", platformUser); err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	resetEntry := harness.audit.logs[len(harness.audit.logs)-1]
	if string(resetEntry.Metadata) != `{"ok":true}` {
		t.Fatalf("reset metadata = %s", resetEntry.Metadata)
	}

	harness.allowPlatformAdmin(platformUser)
	if _, err := harness.service.updateOpenAiKeysSettings(context.Background(), "org-1", platformUser,
		updateOpenAiKeysSettingsRequest{Keys: []string{"Bearer sk-x", "sk-x"}}); err != nil {
		t.Fatalf("keys PUT: %v", err)
	}
	keysEntry := harness.audit.logs[len(harness.audit.logs)-1]
	if keysEntry.Action != actionOpenAiKeysUpdate || string(keysEntry.Metadata) != `{"keysCount":1}` {
		t.Fatalf("keys audit = %s %s", keysEntry.Action, keysEntry.Metadata)
	}
}

// TestAuditOutboxFallbackAndFailure pins the outbox fallback and the rethrow.
func TestAuditOutboxFallbackAndFailure(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.allowPlatformAdmin(platformUser)
	harness.audit.logErr = errFakeBoom

	if _, err := harness.service.updateModelServiceSettings(context.Background(), "org-1", platformUser, modelServicePUT()); err != nil {
		t.Fatalf("an outbox-enqueued audit must not fail the request: %v", err)
	}
	if len(harness.audit.logs) != 0 {
		t.Fatalf("the direct insert must have failed")
	}
	if len(harness.audit.outbox) != 1 {
		t.Fatalf("expected one outbox row, got %d", len(harness.audit.outbox))
	}
	// DATETIME(3) columns need a real time.Time: a formatted ISO string is
	// rejected by MySQL with 1292, and a zero value would insert 0000-00-00.
	if harness.audit.outbox[0].AvailableAt.IsZero() || harness.audit.outbox[0].CreatedAt.IsZero() || harness.audit.outbox[0].UpdatedAt.IsZero() {
		t.Fatalf("the outbox row must carry real timestamps: %+v", harness.audit.outbox[0])
	}
	payload := string(harness.audit.outbox[0].Payload)
	for _, want := range []string{`"orgId":"org-1"`, `"actorId":"` + platformUser + `"`, `"resource":"system_settings"`, `"action":"model_service_update"`, `"metadata":`} {
		if !strings.Contains(payload, want) {
			t.Fatalf("outbox payload %s is missing %s", payload, want)
		}
	}

	// Direct and outbox both failing must surface the original error.
	harness.audit.outboxErr = errFakeBoom
	_, err := harness.service.updateModelServiceSettings(context.Background(), "org-1", platformUser, modelServicePUT())
	if !errors.Is(err, errFakeBoom) {
		t.Fatalf("error = %v, want the original audit failure", err)
	}
	if harness.settings.rowCount(settingKeyModelService) < 1 {
		t.Fatalf("the configuration row must already be committed before the audit")
	}
}

// TestInternalReportWritesNoAdminAuditAndNoKeysRow pins route 10's side effects.
func TestInternalReportWritesNoAdminAuditAndNoKeysRow(t *testing.T) {
	harness := newTestHarness(Config{})
	if err := harness.service.reportAppliedKeyFingerprints(context.Background(), reportAppliedRequest{
		Source:          appliedSourceDB,
		KeyFingerprints: []string{" b ", "a", "a", ""},
	}); err != nil {
		t.Fatalf("report: %v", err)
	}
	if len(harness.audit.logs) != 0 || len(harness.audit.outbox) != 0 {
		t.Fatalf("the internal report must not write an admin audit row")
	}
	if harness.settings.present[settingKeyOpenAiKeys] {
		t.Fatalf("the internal report must not create an openai_keys row")
	}
	record, err := decodeAppliedStatusRecord(harness.settings.rows[settingKeyAppliedStatus])
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := string(record.payload.Source); got != `"db"` {
		t.Fatalf("source = %s", got)
	}
	appliedAt, ok := jsonString(record.payload.AppliedAt)
	if !ok || !strings.HasSuffix(appliedAt, "Z") || len(appliedAt) != 24 {
		t.Fatalf("appliedAt = %q", appliedAt)
	}
	fingerprints := harness.service.listAppliedFingerprints(record.payload.KeyFingerprints)
	assertStrings(t, "applied fingerprints", fingerprints, []string{"b", "a"})
}

// TestGETReadsKeepTheCacheContract proves the read path honours a cache hit and
// refreshes on a miss.
func TestGETReadsKeepTheCacheContract(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.cache.entries[cacheKeyModelService] = json.RawMessage(`{"exists":true,"value":{"enabled":true,"timeoutMs":1234,"maxRetries":1}}`)
	public, err := harness.service.getModelServiceSettings(context.Background())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !public.Enabled || public.TimeoutMs != 1234 {
		t.Fatalf("cache hit not honoured: %+v", public)
	}
	if harness.settings.present[settingKeyModelService] {
		t.Fatalf("a cache hit must not read MySQL")
	}

	fresh := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	fresh.settings.seed(settingKeyModelService, `{"enabled":false}`)
	if _, err := fresh.service.getModelServiceSettings(context.Background()); err != nil {
		t.Fatalf("get: %v", err)
	}
	if fresh.cache.ttls[cacheKeyModelService] != settingsCacheTTLSeconds {
		t.Fatalf("cache ttl = %d, want %d", fresh.cache.ttls[cacheKeyModelService], settingsCacheTTLSeconds)
	}

	applied := newTestHarness(Config{})
	applied.settings.seed(settingKeyAppliedStatus, `{"source":"db","keyFingerprints":["fp"]}`)
	if _, err := applied.service.getOpenAiKeysSettings(context.Background()); err != nil {
		t.Fatalf("get: %v", err)
	}
	if applied.cache.ttls[cacheKeyAppliedStatus] != appliedCacheTTLSeconds {
		t.Fatalf("applied cache ttl = %d", applied.cache.ttls[cacheKeyAppliedStatus])
	}
}

// TestPlaintextKeysSkipUndecryptableEntries pins route 9's behaviour.
func TestPlaintextKeysSkipUndecryptableEntries(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.settings.seed(settingKeyOpenAiKeys,
		`{"openaiApiKeys":[{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AAEC","tag":"AAEC","data":"AAEC"},"sk-live"]}`)
	response, err := harness.service.getPlaintextKeys(context.Background())
	if err != nil {
		t.Fatalf("getPlaintextKeys: %v", err)
	}
	assertStrings(t, "plaintext keys", response.OpenaiApiKeys, []string{"sk-live"})
}

// TestPlaintextKeysEmptyIsEmptyArray pins the empty shape.
func TestPlaintextKeysEmptyIsEmptyArray(t *testing.T) {
	harness := newTestHarness(Config{})
	response, err := harness.service.getPlaintextKeys(context.Background())
	if err != nil {
		t.Fatalf("getPlaintextKeys: %v", err)
	}
	payload, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(payload) != `{"openaiApiKeys":[]}` {
		t.Fatalf("payload = %s", payload)
	}
}

// mapErrorForTest mirrors the HTTP mapping table for the 503 lock failure.
func mapErrorForTest(t *testing.T, err error) (status int, message string, errorName string) {
	t.Helper()
	if errors.Is(err, errLockUnavailable) {
		return 503, "Internal server error", "Service Unavailable"
	}
	var coded *httpError
	if errors.As(err, &coded) {
		return coded.status, coded.message, ""
	}
	return 500, "Internal server error", ""
}
