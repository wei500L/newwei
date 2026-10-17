package llmgatewayprofiles

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// testKey is a deterministic 32-byte key for the crypto tests.
func testKey() []byte {
	key := make([]byte, keyByteLength)
	for index := range key {
		key[index] = byte(index + 1)
	}
	return key
}

// testKeyBase64 is the base64 form of testKey.
func testKeyBase64() string {
	return base64.StdEncoding.EncodeToString(testKey())
}

// testKeyHex is the 64 hex character form of testKey.
func testKeyHex() string {
	const digits = "0123456789abcdef"
	builder := strings.Builder{}
	for _, value := range testKey() {
		builder.WriteByte(digits[value>>4])
		builder.WriteByte(digits[value&0x0f])
	}
	return builder.String()
}

func TestDecodeSystemSettingsKey(t *testing.T) {
	decoded, err := decodeSystemSettingsKey(testKeyHex())
	if err != nil || !bytes.Equal(decoded, testKey()) {
		t.Fatalf("hex key decode = %x err=%v", decoded, err)
	}
	decoded, err = decodeSystemSettingsKey("0x" + testKeyHex())
	if err != nil || !bytes.Equal(decoded, testKey()) {
		t.Fatalf("0x hex key decode = %x err=%v", decoded, err)
	}
	decoded, err = decodeSystemSettingsKey("  0X" + testKeyHex() + "  ")
	if err != nil || !bytes.Equal(decoded, testKey()) {
		t.Fatalf("0X padded hex key decode = %x err=%v", decoded, err)
	}
	decoded, err = decodeSystemSettingsKey(testKeyBase64())
	if err != nil || !bytes.Equal(decoded, testKey()) {
		t.Fatalf("base64 key decode = %x err=%v", decoded, err)
	}
	// Node's base64 decoder ignores characters outside the alphabet.
	interleaved := testKeyBase64()[:8] + "\n" + testKeyBase64()[8:]
	decoded, err = decodeSystemSettingsKey(interleaved)
	if err != nil || !bytes.Equal(decoded, testKey()) {
		t.Fatalf("interleaved base64 key decode = %x err=%v", decoded, err)
	}

	if _, err = decodeSystemSettingsKey(""); err == nil || err.Error() != errKeyEmptyMessage {
		t.Fatalf("empty key error = %v", err)
	}
	if _, err = decodeSystemSettingsKey("   "); err == nil || err.Error() != errKeyEmptyMessage {
		t.Fatalf("blank key error = %v", err)
	}
	if _, err = decodeSystemSettingsKey("abc"); err == nil || err.Error() != errKeyLengthMessage {
		t.Fatalf("short key error = %v", err)
	}
	if _, err = decodeSystemSettingsKey(strings.Repeat("ab", 31)); err == nil || err.Error() != errKeyLengthMessage {
		t.Fatalf("62 hex char key error = %v", err)
	}
}

func TestEncryptDecryptStringValueV1(t *testing.T) {
	key := testKey()
	envelope, err := encryptStringValueV1("sk-secret", key)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Enc != EncryptionTag || envelope.Alg != EncryptionAlgorithm {
		t.Fatalf("envelope = %+v", envelope)
	}
	iv, err := base64.StdEncoding.DecodeString(envelope.IV)
	if err != nil || len(iv) != gcmIVByteLength {
		t.Fatalf("iv = %x err=%v", iv, err)
	}
	tag, err := base64.StdEncoding.DecodeString(envelope.Tag)
	if err != nil || len(tag) != gcmTagByteLength {
		t.Fatalf("tag = %x err=%v", tag, err)
	}
	decrypted, err := decryptStringValueV1(envelope, key)
	if err != nil || decrypted != "sk-secret" {
		t.Fatalf("decrypt = %q err=%v", decrypted, err)
	}
	// A second encryption uses a fresh IV.
	again, err := encryptStringValueV1("sk-secret", key)
	if err != nil {
		t.Fatal(err)
	}
	if again.IV == envelope.IV {
		t.Fatal("the IV must be random per encryption")
	}
	if _, err := decryptStringValueV1(again, testKey()); err != nil {
		t.Fatalf("second decrypt failed: %v", err)
	}
	// A tampered payload fails instead of returning garbage.
	tampered := envelope
	tampered.Data = base64.StdEncoding.EncodeToString([]byte("not-the-ciphertext"))
	if _, err := decryptStringValueV1(tampered, key); err == nil {
		t.Fatal("a tampered payload must fail")
	}
	wrongKey := testKey()
	wrongKey[0] ^= 0xff
	if _, err := decryptStringValueV1(envelope, wrongKey); err == nil {
		t.Fatal("a wrong key must fail")
	}
	// The envelope round-trips through JSON with the exact key order.
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"` + envelope.IV + `","tag":"` + envelope.Tag + `","data":"` + envelope.Data + `"}`
	if string(payload) != want {
		t.Fatalf("envelope json = %s", payload)
	}
	// A plaintext string and an unknown object are not envelopes.
	if _, ok := decodeEnvelope(json.RawMessage(`"plain"`)); ok {
		t.Fatal("a plaintext string must not be an envelope")
	}
	if _, ok := decodeEnvelope(json.RawMessage(`{"__enc":"other","alg":"aes-256-gcm","iv":"a","tag":"b","data":"c"}`)); ok {
		t.Fatal("an unknown tag must not be an envelope")
	}
	if _, ok := decodeEnvelope(json.RawMessage(`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":1,"tag":"b","data":"c"}`)); ok {
		t.Fatal("a non-string iv must not be an envelope")
	}
}

func TestDecodeSecretValueKinds(t *testing.T) {
	if secret := decodeSecretValue(nil); secret != nil {
		t.Fatalf("absent secret = %+v", secret)
	}
	if secret := decodeSecretValue(json.RawMessage(`null`)); secret.Kind() != SecretNull {
		t.Fatalf("null secret = %v", secret.Kind())
	}
	if secret := decodeSecretValue(json.RawMessage(`"plain"`)); secret.Kind() != SecretPlaintext {
		t.Fatalf("string secret = %v", secret.Kind())
	}
	if secret := decodeSecretValue(json.RawMessage(`42`)); secret.Kind() != SecretOpaque {
		t.Fatalf("number secret = %v", secret.Kind())
	}
	if secret := decodeSecretValue(json.RawMessage(`{"legacy":true}`)); secret.Kind() != SecretOpaque {
		t.Fatalf("object secret = %v", secret.Kind())
	}
	envelope := EncryptedStringValueV1{Enc: EncryptionTag, Alg: EncryptionAlgorithm, IV: "a", Tag: "b", Data: "c"}
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	secret := decodeSecretValue(payload)
	if secret.Kind() != SecretEncrypted {
		t.Fatalf("envelope secret = %v", secret.Kind())
	}
	// An opaque value is preserved byte-for-byte on rewrite.
	opaque := decodeSecretValue(json.RawMessage(`{"legacy":  [1,2]}`))
	rewritten, err := json.Marshal(opaque)
	if err != nil {
		t.Fatal(err)
	}
	if string(rewritten) != `{"legacy":  [1,2]}` {
		t.Fatalf("opaque rewrite = %s", rewritten)
	}
}

func TestResolveSecretStates(t *testing.T) {
	service := &Service{cfg: Config{SettingsEncryptionKey: testKeyBase64()}}
	if _, ok := service.resolveSecret(nil); ok {
		t.Fatal("absent secret must not resolve")
	}
	if _, ok := service.resolveSecret(newNullSecret()); ok {
		t.Fatal("null secret must not resolve")
	}
	if _, ok := service.resolveSecret(newOpaqueSecret(json.RawMessage(`{"legacy":1}`))); ok {
		t.Fatal("opaque secret must not resolve")
	}
	if _, ok := service.resolveSecret(newPlaintextSecret("")); ok {
		t.Fatal("an empty plaintext secret must not resolve")
	}
	if value, ok := service.resolveSecret(newPlaintextSecret(" Bearer sk-plain ")); !ok || value != "sk-plain" {
		t.Fatalf("plaintext secret = %q ok=%v", value, ok)
	}

	envelope, err := encryptStringValueV1("Bearer sk-encrypted", testKey())
	if err != nil {
		t.Fatal(err)
	}
	if value, ok := service.resolveSecret(newEncryptedSecret(envelope)); !ok || value != "sk-encrypted" {
		t.Fatalf("encrypted secret = %q ok=%v", value, ok)
	}
	// No key configured: an encrypted payload cannot be read, and there is no
	// environment apiKey to fall back to.
	withoutKey := &Service{cfg: Config{}}
	if _, ok := withoutKey.resolveSecret(newEncryptedSecret(envelope)); ok {
		t.Fatal("an encrypted secret must not resolve without a key")
	}
	if withoutKey.hasAPIKey(StoredProfile{APIKey: newEncryptedSecret(envelope)}) {
		t.Fatal("hasApiKey must be false without a key")
	}
	wrongKeyService := &Service{cfg: Config{SettingsEncryptionKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, keyByteLength))}}
	if _, ok := wrongKeyService.resolveSecret(newEncryptedSecret(envelope)); ok {
		t.Fatal("an encrypted secret must not resolve with the wrong key")
	}
}

func TestEncodeSecretForStoragePolicy(t *testing.T) {
	ctx := context.Background()
	configured := func(raw string) func(context.Context) (securitySettingsProjection, error) {
		return func(context.Context) (securitySettingsProjection, error) {
			if raw == "" {
				return securitySettingsProjection{}, nil
			}
			return securitySettingsProjection{SecretEncryptionEnabled: json.RawMessage(raw)}, nil
		}
	}

	// A valid key encrypts by default.
	encrypting := &Service{cfg: Config{SettingsEncryptionKey: testKeyBase64()}}
	encrypting.securityFn = configured(`true`)
	secret, err := encrypting.encodeSecretForStorage(ctx, "sk-1")
	if err != nil {
		t.Fatal(err)
	}
	if secret.Kind() != SecretEncrypted {
		t.Fatalf("secret = %v, want encrypted", secret.Kind())
	}

	// configured === false is the plaintext escape hatch.
	plainService := &Service{cfg: Config{SettingsEncryptionKey: testKeyBase64()}}
	plainService.securityFn = configured(`false`)
	secret, err = plainService.encodeSecretForStorage(ctx, "sk-2")
	if err != nil {
		t.Fatal(err)
	}
	if secret.Kind() != SecretPlaintext {
		t.Fatalf("secret = %v, want plaintext", secret.Kind())
	}

	// A non-boolean stored flag is "not configured", so a valid key encrypts.
	looseService := &Service{cfg: Config{SettingsEncryptionKey: testKeyBase64()}}
	looseService.securityFn = configured(`"true"`)
	secret, err = looseService.encodeSecretForStorage(ctx, "sk-3")
	if err != nil {
		t.Fatal(err)
	}
	if secret.Kind() != SecretEncrypted {
		t.Fatalf("secret = %v, want encrypted", secret.Kind())
	}

	// Encryption enabled with a present but invalid key.
	invalidKey := &Service{cfg: Config{SettingsEncryptionKey: "not-a-key"}}
	invalidKey.securityFn = configured(`true`)
	_, err = invalidKey.encodeSecretForStorage(ctx, "sk-4")
	want := "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid (" + errKeyLengthMessage + ")"
	if got := messageOf(t, err); got != want {
		t.Fatalf("invalid key message = %q, want %q", got, want)
	}

	// Encryption enabled without a key.
	missingKey := &Service{cfg: Config{}}
	missingKey.securityFn = configured(`true`)
	_, err = missingKey.encodeSecretForStorage(ctx, "sk-5")
	if got := messageOf(t, err); got != "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured" {
		t.Fatalf("missing key message = %q", got)
	}

	// Production without any usable key refuses plaintext.
	production := &Service{cfg: Config{Production: true}}
	production.securityFn = configured(``)
	_, err = production.encodeSecretForStorage(ctx, "sk-6")
	if got := messageOf(t, err); got != "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production" {
		t.Fatalf("production message = %q", got)
	}

	// Non-production without a key keeps the historical plaintext fallback.
	development := &Service{cfg: Config{}}
	development.securityFn = configured(``)
	secret, err = development.encodeSecretForStorage(ctx, "sk-7")
	if err != nil {
		t.Fatal(err)
	}
	if value, ok := secret.Plaintext(); !ok || value != "sk-7" {
		t.Fatalf("plaintext fallback = %q ok=%v", value, ok)
	}
}

func TestNormalizeAPIKeyInputAbsentKeepsStoredOpaqueValue(t *testing.T) {
	ctx := context.Background()
	service := &Service{cfg: Config{}}
	base := &StoredProfile{APIKey: newOpaqueSecret(json.RawMessage(`{"legacy":1}`))}
	kept, err := service.normalizeAPIKeyInput(ctx, profileInput{APIKeySet: false}, base)
	if err != nil {
		t.Fatal(err)
	}
	if kept == nil || kept.Kind() != SecretOpaque {
		t.Fatalf("kept = %+v, want the stored opaque value", kept)
	}
	if _, err := service.normalizeAPIKeyInput(ctx, profileInput{APIKeySet: false}, nil); err != nil {
		t.Fatal(err)
	} else {
		// A create without a key stores no apiKey at all.
		created, err := service.normalizeAPIKeyInput(ctx, profileInput{APIKeySet: false}, nil)
		if err != nil || created != nil {
			t.Fatalf("created = %+v err=%v, want absent", created, err)
		}
	}
	cleared, err := service.normalizeAPIKeyInput(ctx, profileInput{APIKeySet: true, APIKey: nil}, base)
	if err != nil {
		t.Fatal(err)
	}
	if cleared == nil || cleared.Kind() != SecretNull {
		t.Fatalf("cleared = %+v, want an explicit null", cleared)
	}
	blank := ""
	cleared, err = service.normalizeAPIKeyInput(ctx, profileInput{APIKeySet: true, APIKey: &blank}, base)
	if err != nil {
		t.Fatal(err)
	}
	if cleared == nil || cleared.Kind() != SecretNull {
		t.Fatalf("blank cleared = %+v, want an explicit null", cleared)
	}
}

func TestEncodeSecretForStorageFailureDoesNotOverwrite(t *testing.T) {
	ctx := context.Background()
	service := &Service{cfg: Config{SettingsEncryptionKey: "bad"}}
	service.securityFn = func(context.Context) (securitySettingsProjection, error) {
		return securitySettingsProjection{SecretEncryptionEnabled: json.RawMessage(`true`)}, nil
	}
	base := &StoredProfile{APIKey: newPlaintextSecret("existing")}
	input := profileInput{APIKeySet: true, APIKey: stringPointer("new-key")}
	_, err := service.normalizeAPIKeyInput(ctx, input, base)
	if err == nil {
		t.Fatal("an invalid key must fail the encode")
	}
	var coded *httpError
	if !errors.As(err, &coded) || coded.status != 400 {
		t.Fatalf("error = %v, want a 400", err)
	}
	// The stored value is untouched because the failure happens before any
	// persistence call.
	if value, ok := base.APIKey.Plaintext(); !ok || value != "existing" {
		t.Fatalf("existing key = %q ok=%v", value, ok)
	}
}
