package modelaccesssettings

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

// testKeyHex is a fixed 32 byte key in 64 hex characters.
const testKeyHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

// testKey returns the decoded fixed key.
func testKey(t *testing.T) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(testKeyHex)
	if err != nil {
		t.Fatalf("hex decode: %v", err)
	}
	return decoded
}

// TestDecodeSettingsKey parses every accepted spelling.
func TestDecodeSettingsKey(t *testing.T) {
	key := testKey(t)
	base64Std := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
	base64Unpadded := strings.TrimRight(base64Std, "=")
	base64URLUnpadded := strings.NewReplacer("+", "-", "/", "_").Replace(base64Unpadded)

	cases := []struct {
		name    string
		input   string
		wantErr string
	}{
		{name: "64 hex", input: testKeyHex, wantErr: ""},
		{name: "64 hex uppercase", input: strings.ToUpper(testKeyHex)},
		{name: "0x prefixed hex", input: "0x" + testKeyHex},
		{name: "0X prefixed hex", input: "0X" + testKeyHex},
		{name: "trimmed hex", input: "  " + testKeyHex + "  "},
		{name: "base64 padded", input: base64Std},
		{name: "base64 unpadded", input: base64Unpadded},
		{name: "base64 url-safe unpadded", input: base64URLUnpadded},
		{name: "empty", input: "", wantErr: "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty"},
		{name: "blank", input: "   ", wantErr: "SYSTEM_SETTINGS_ENCRYPTION_KEY is empty"},
		{name: "too short", input: "abcd", wantErr: "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars"},
		{name: "63 hex", input: testKeyHex[:63], wantErr: "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars"},
		{name: "65 hex", input: testKeyHex + "0", wantErr: "SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			decoded, err := decodeSettingsKey(testCase.input)
			if testCase.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error %q, got key %x", testCase.wantErr, decoded)
				}
				if err.Error() != testCase.wantErr {
					t.Fatalf("error = %q, want %q", err.Error(), testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !bytes.Equal(decoded, key) {
				t.Fatalf("decoded key = %x, want %x", decoded, key)
			}
		})
	}
}

// TestNodeBase64Decode reproduces Node's lenient base64 decoder on the inputs this
// protocol can meet.
func TestNodeBase64Decode(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{input: "abc", want: "69b7"},
		{input: "ab", want: "69"},
		{input: "a", want: ""},
		{input: "YWJj", want: "616263"},
		{input: "YWJj=", want: "616263"},
		{input: "YWJj==", want: "616263"},
		{input: "AA=A", want: "00"},
		{input: "=AAA", want: ""},
		{input: "!!!", want: ""},
		{input: "a b", want: "69"},
		{input: "a\tb", want: "69"},
		{input: "_-", want: "ff"},
		{input: "-A", want: "f8"},
		{input: "_A", want: "fc"},
		{input: "A-", want: "03"},
		{input: "0x", want: "d3"},
		{input: "YWJ=j", want: "6162"},
	}
	for _, testCase := range cases {
		t.Run(testCase.input, func(t *testing.T) {
			got := hex.EncodeToString(nodeBase64Decode(testCase.input))
			if got != testCase.want {
				t.Fatalf("nodeBase64Decode(%q) = %s, want %s", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestEncryptDecryptRoundTrip verifies the envelope shape and the plaintext.
func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := testKey(t)
	envelope, err := encryptStringValueV1("sk-secret-value", key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if envelope.Enc != "system-settings:v1" || envelope.Alg != "aes-256-gcm" {
		t.Fatalf("envelope header = %+v", envelope)
	}
	if len(nodeBase64Decode(envelope.IV)) != 12 {
		t.Fatalf("iv length = %d, want 12", len(nodeBase64Decode(envelope.IV)))
	}
	if len(nodeBase64Decode(envelope.Tag)) != 16 {
		t.Fatalf("tag length = %d, want 16", len(nodeBase64Decode(envelope.Tag)))
	}
	plain, err := decryptStringValueV1(envelope, key)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if plain != "sk-secret-value" {
		t.Fatalf("plaintext = %q", plain)
	}

	// A second encryption of the same plaintext must use a fresh IV.
	second, err := encryptStringValueV1("sk-secret-value", key)
	if err != nil {
		t.Fatalf("encrypt 2: %v", err)
	}
	if second.IV == envelope.IV {
		t.Fatalf("iv was reused across writes")
	}
}

// TestDecryptFailuresAreGeneric pins the single generic decrypt error.
func TestDecryptFailuresAreGeneric(t *testing.T) {
	key := testKey(t)
	envelope, err := encryptStringValueV1("value", key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	cases := []struct {
		name   string
		mutate func(encryptedSecret) encryptedSecret
	}{
		{name: "corrupted tag", mutate: func(e encryptedSecret) encryptedSecret {
			raw := nodeBase64Decode(e.Tag)
			raw[0] ^= 0xff
			e.Tag = base64StdEncode(raw)
			return e
		}},
		{name: "corrupted data", mutate: func(e encryptedSecret) encryptedSecret {
			raw := nodeBase64Decode(e.Data)
			raw[0] ^= 0xff
			e.Data = base64StdEncode(raw)
			return e
		}},
		{name: "corrupted iv", mutate: func(e encryptedSecret) encryptedSecret {
			raw := nodeBase64Decode(e.IV)
			raw[0] ^= 0xff
			e.IV = base64StdEncode(raw)
			return e
		}},
		{name: "short iv", mutate: func(e encryptedSecret) encryptedSecret {
			e.IV = base64StdEncode([]byte{1, 2, 3})
			return e
		}},
		{name: "short tag", mutate: func(e encryptedSecret) encryptedSecret {
			e.Tag = base64StdEncode([]byte{1, 2, 3, 4})
			return e
		}},
		{name: "empty data", mutate: func(e encryptedSecret) encryptedSecret {
			e.Data = ""
			return e
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := decryptStringValueV1(testCase.mutate(envelope), key)
			if err == nil {
				t.Fatalf("expected a decrypt failure")
			}
			if err.Error() != "Failed to decrypt system setting secret" {
				t.Fatalf("error = %q", err.Error())
			}
		})
	}
	if _, err := decryptStringValueV1(envelope, []byte{1, 2, 3}); err == nil {
		t.Fatalf("wrong key length must fail")
	}
	// A different valid key fails with the generic error too.
	other := append([]byte{}, key...)
	other[0] ^= 0xff
	if _, err := decryptStringValueV1(envelope, other); err == nil || err.Error() != "Failed to decrypt system setting secret" {
		t.Fatalf("wrong key error = %v", err)
	}
}

// TestEncryptedShapeDetection pins isEncryptedStringValueV1.
func TestEncryptedShapeDetection(t *testing.T) {
	valid := `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"a","tag":"b","data":"c"}`
	cases := []struct {
		name string
		body string
		want bool
	}{
		{name: "valid", body: valid, want: true},
		{name: "extra key tolerated", body: `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"a","tag":"b","data":"c","x":1}`, want: true},
		{name: "wrong tag", body: `{"__enc":"system-settings:v2","alg":"aes-256-gcm","iv":"a","tag":"b","data":"c"}`},
		{name: "wrong alg", body: `{"__enc":"system-settings:v1","alg":"aes-128-gcm","iv":"a","tag":"b","data":"c"}`},
		{name: "missing iv", body: `{"__enc":"system-settings:v1","alg":"aes-256-gcm","tag":"b","data":"c"}`},
		{name: "numeric iv", body: `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":1,"tag":"b","data":"c"}`},
		{name: "null iv", body: `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":null,"tag":"b","data":"c"}`},
		{name: "plain string", body: `"x"`},
		{name: "null", body: `null`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, ok := isEncryptedSecretShape([]byte(testCase.body))
			if ok != testCase.want {
				t.Fatalf("isEncryptedSecretShape(%s) = %v, want %v", testCase.body, ok, testCase.want)
			}
		})
	}
}

// TestSecretEncodingDecisionTable pins the whole production/configured/key matrix.
func TestSecretEncodingDecisionTable(t *testing.T) {
	validKey := testKeyHex
	cases := []struct {
		name             string
		configured       string // "" means no system_security row
		key              string
		production       bool
		wantKind         secretKind
		wantMessage      string
		wantCacheEntries int
	}{
		{name: "valid key + unset toggle encrypts", configured: "", key: validKey, wantKind: secretEncrypted},
		{name: "valid key + configured false stores plaintext", configured: `{"secretEncryptionEnabled":false}`, key: validKey, wantKind: secretPlain},
		{name: "valid key + configured true encrypts", configured: `{"secretEncryptionEnabled":true}`, key: validKey, wantKind: secretEncrypted},
		{name: "production without key fails", key: "", production: true, wantMessage: "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production"},
		{name: "production without key and toggle false still fails", configured: `{"secretEncryptionEnabled":false}`, key: "", production: true, wantMessage: "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production"},
		{name: "configured true without key fails with the not-configured message", configured: `{"secretEncryptionEnabled":true}`, key: "", wantMessage: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured"},
		{name: "configured true with invalid key fails with the decode detail", configured: `{"secretEncryptionEnabled":true}`, key: "not-a-key", wantMessage: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid (SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars)"},
		{name: "configured true with blank key reports the empty detail", configured: `{"secretEncryptionEnabled":true}`, key: "   ", wantMessage: "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid (SYSTEM_SETTINGS_ENCRYPTION_KEY is empty)"},
		{name: "non-production without key stores plaintext", key: "", wantKind: secretPlain},
		{name: "non-production without key and toggle false stores plaintext", configured: `{"secretEncryptionEnabled":false}`, key: "", wantKind: secretPlain},
		{name: "invalid key with unset toggle falls back to plaintext off-production", key: "not-a-key", wantKind: secretPlain},
		{name: "non-boolean toggle counts as unset", configured: `{"secretEncryptionEnabled":"true"}`, key: validKey, wantKind: secretEncrypted},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newTestHarness(Config{
				SettingsEncryptionKeyRaw: testCase.key,
				IsProduction:             testCase.production,
			})
			if testCase.configured != "" {
				harness.settings.seed(settingKeySystemSecurity, testCase.configured)
			}
			value, err := harness.service.encodeSecretForStorage(context.Background(), "sk-plain")
			if testCase.wantMessage != "" {
				assertMessages(t, err, 400, testCase.wantMessage)
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if value.kind != testCase.wantKind {
				t.Fatalf("kind = %v, want %v", value.kind, testCase.wantKind)
			}
		})
	}
}

// TestSecretStoredRoundTripThroughNestEnvelope proves a value this package writes
// is readable again and that the byte order matches the NestJS field order.
func TestSecretStoredRoundTripThroughNestEnvelope(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	value, err := harness.service.encodeSecretForStorage(context.Background(), "sk-round-trip")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, field := range []string{`"__enc":"system-settings:v1"`, `"alg":"aes-256-gcm"`, `"iv":`, `"tag":`, `"data":`} {
		if !strings.Contains(string(payload), field) {
			t.Fatalf("envelope %s is missing %s", payload, field)
		}
	}
	roundTripped := secretValueFromRaw(payload)
	if roundTripped.kind != secretEncrypted {
		t.Fatalf("round-tripped kind = %v", roundTripped.kind)
	}
	plain, ok := roundTripped.resolvePlaintext(testKey(t), true)
	if !ok || plain != "sk-round-trip" {
		t.Fatalf("resolvePlaintext = %q, %v", plain, ok)
	}
}

// TestReadSystemSecurityCacheIsReadOnly proves the encryption decision honours a
// cached envelope and never writes one.
func TestReadSystemSecurityCacheIsReadOnly(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	harness.cache.entries[cacheKeySystemSecurity] = json.RawMessage(`{"exists":true,"value":{"secretEncryptionEnabled":false}}`)
	value, err := harness.service.encodeSecretForStorage(context.Background(), "sk-plain")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if value.kind != secretPlain {
		t.Fatalf("kind = %v, want plaintext (the cached toggle is false)", value.kind)
	}
	if len(harness.cache.entries) != 1 {
		t.Fatalf("the system_security cache must not be written: %v", harness.cache.entries)
	}
}

// base64StdEncode encodes bytes the way Node's toString("base64") does.
func base64StdEncode(raw []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var builder strings.Builder
	for index := 0; index < len(raw); index += 3 {
		remaining := len(raw) - index
		block := uint32(raw[index]) << 16
		if remaining > 1 {
			block |= uint32(raw[index+1]) << 8
		}
		if remaining > 2 {
			block |= uint32(raw[index+2])
		}
		builder.WriteByte(alphabet[(block>>18)&0x3f])
		builder.WriteByte(alphabet[(block>>12)&0x3f])
		if remaining > 1 {
			builder.WriteByte(alphabet[(block>>6)&0x3f])
		} else {
			builder.WriteByte('=')
		}
		if remaining > 2 {
			builder.WriteByte(alphabet[block&0x3f])
		} else {
			builder.WriteByte('=')
		}
	}
	return builder.String()
}
