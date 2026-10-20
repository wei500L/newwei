package situationsettings

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

const testEncryptionKeyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testEncryptionKey(t *testing.T) []byte {
	t.Helper()
	key, err := hex.DecodeString(testEncryptionKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// TestDecryptNestSample uses an envelope produced by the NestJS implementation
// (node:crypto AES-256-GCM, fixed IV) to prove Go reads NestJS ciphertext.
func TestDecryptNestSample(t *testing.T) {
	envelope := json.RawMessage(`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AAECAwQFBgcICQoL","tag":"TmYBEvk43mMlN5fqYUsOug==","data":"8m+3cW+RRyX0rrpnWszDrTigcQ=="}`)
	plain, ok := decryptSettingsSecret(envelope, testEncryptionKeyHex)
	if !ok {
		t.Fatal("decrypt failed")
	}
	if plain != "sk-live-nest-sample" {
		t.Fatalf("plain = %q", plain)
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := testEncryptionKey(t)
	envelope, err := encryptSettingsSecret("sk-go-sample", key)
	if err != nil {
		t.Fatal(err)
	}
	if !isEncryptedSettingsValue(envelope) {
		t.Fatalf("envelope not recognised: %s", envelope)
	}
	var decoded struct {
		Enc  string `json:"__enc"`
		Alg  string `json:"alg"`
		IV   string `json:"iv"`
		Tag  string `json:"tag"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(envelope, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Enc != "system-settings:v1" || decoded.Alg != "aes-256-gcm" {
		t.Fatalf("tag/alg = %+v", decoded)
	}
	iv, err := base64.StdEncoding.DecodeString(decoded.IV)
	if err != nil || len(iv) != 12 {
		t.Fatalf("iv = %q err=%v", decoded.IV, err)
	}
	tag, err := base64.StdEncoding.DecodeString(decoded.Tag)
	if err != nil || len(tag) != 16 {
		t.Fatalf("tag = %q err=%v", decoded.Tag, err)
	}
	plain, ok := decryptSettingsSecret(envelope, testEncryptionKeyHex)
	if !ok || plain != "sk-go-sample" {
		t.Fatalf("round trip = %q ok=%v", plain, ok)
	}
}

func TestDecodeSettingsKeyForms(t *testing.T) {
	key := testEncryptionKey(t)
	for _, raw := range []string{
		testEncryptionKeyHex,
		"0x" + testEncryptionKeyHex,
		base64.StdEncoding.EncodeToString(key),
	} {
		decoded, err := decodeSettingsKey(raw)
		if err != nil {
			t.Fatalf("%q: %v", raw, err)
		}
		if string(decoded) != string(key) {
			t.Fatalf("%q decoded = %x", raw, decoded)
		}
	}
	if _, err := decodeSettingsKey(""); err == nil || err.Error() != "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty" {
		t.Fatalf("empty key: %v", err)
	}
	if _, err := decodeSettingsKey("short"); err == nil || !strings.Contains(err.Error(), "32 bytes") {
		t.Fatalf("short key: %v", err)
	}
}

func TestIsEncryptedSettingsValueRejectsLooseShapes(t *testing.T) {
	for _, raw := range []string{
		`null`,
		`"plain"`,
		`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":1,"tag":"b","data":"c"}`,
		`{"__enc":"other","alg":"aes-256-gcm","iv":"a","tag":"b","data":"c"}`,
	} {
		if isEncryptedSettingsValue(json.RawMessage(raw)) {
			t.Fatalf("%s should not be an envelope", raw)
		}
	}
}

func TestSecretEncoderPolicy(t *testing.T) {
	key := testEncryptionKey(t)
	env := Env{EncryptionKeyRaw: testEncryptionKeyHex, NodeEnv: "production"}

	// Valid key, toggle not explicitly false -> encrypt.
	configuredTrue := true
	encoder := secretEncoder{configured: &configuredTrue, keyStatus: encryptionKeyStatus{present: true, valid: true, key: key}}
	encoded, err := encoder.encodeSecretForStorage("secret", env)
	if err != nil {
		t.Fatal(err)
	}
	if !isEncryptedSettingsValue(encoded) {
		t.Fatalf("expected envelope, got %s", encoded)
	}

	// Valid key, toggle false -> plaintext escape hatch.
	configuredFalse := false
	encoder = secretEncoder{configured: &configuredFalse, keyStatus: encryptionKeyStatus{present: true, valid: true, key: key}}
	encoded, err = encoder.encodeSecretForStorage("secret", env)
	if err != nil {
		t.Fatal(err)
	}
	var plain string
	if err := json.Unmarshal(encoded, &plain); err != nil || plain != "secret" {
		t.Fatalf("plaintext = %s err=%v", encoded, err)
	}

	// Toggle true, key present but invalid -> 400 with the exact detail.
	encoder = secretEncoder{configured: &configuredTrue, keyStatus: encryptionKeyStatus{present: true, errText: "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars"}}
	_, err = encoder.encodeSecretForStorage("secret", env)
	if err == nil || err.Error() != "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid (SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars)" {
		t.Fatalf("invalid key error = %v", err)
	}

	// Toggle true, no key -> 400 "not configured".
	encoder = secretEncoder{configured: &configuredTrue}
	_, err = encoder.encodeSecretForStorage("secret", Env{})
	if err == nil || err.Error() != "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured" {
		t.Fatalf("missing key error = %v", err)
	}

	// No key, production -> 400.
	encoder = secretEncoder{}
	_, err = encoder.encodeSecretForStorage("secret", Env{NodeEnv: "production"})
	if err == nil || err.Error() != "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production" {
		t.Fatalf("production error = %v", err)
	}

	// No key, non-production -> plaintext.
	encoded, err = encoder.encodeSecretForStorage("secret", Env{})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &plain); err != nil || plain != "secret" {
		t.Fatalf("dev plaintext = %s err=%v", encoded, err)
	}
}
