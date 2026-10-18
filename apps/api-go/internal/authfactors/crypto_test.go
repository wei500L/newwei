package authfactors

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// testKeyHex is a fixed 64 hex character key: 32 bytes, the documented hex
// form.
const testKeyHex = "3f8c1d5a9b2e7046c1a8f3d6e9b0c4a75d2f8e1b6c3a9d0e4f7b2c5a8d1e6f30"

// TestDecodeSystemSettingsKeyForms locks the 64 hex / optional 0x and Node
// base64 key parsing rules.
func TestDecodeSystemSettingsKeyForms(t *testing.T) {
	fromHex, err := decodeSystemSettingsKey(testKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	if len(fromHex) != systemSettingsKeyBytes {
		t.Fatalf("hex key length = %d", len(fromHex))
	}
	for _, variant := range []string{
		"  " + testKeyHex + "  ",
		"0x" + testKeyHex,
		"0X" + testKeyHex,
		strings.ToUpper(testKeyHex),
	} {
		got, err := decodeSystemSettingsKey(variant)
		if err != nil {
			t.Fatalf("decode %q: %v", variant, err)
		}
		if string(got) != string(fromHex) {
			t.Fatalf("decode %q differs", variant)
		}
	}

	// The same 32 bytes in standard base64 must decode identically.
	base64Form := base64.StdEncoding.EncodeToString(fromHex)
	fromBase64, err := decodeSystemSettingsKey(base64Form)
	if err != nil {
		t.Fatalf("base64 form: %v", err)
	}
	if string(fromBase64) != string(fromHex) {
		t.Fatalf("base64 form decoded to %x, want %x", fromBase64, fromHex)
	}

	if _, err := decodeSystemSettingsKey(""); err == nil {
		t.Fatal("an empty key must fail")
	}
	if _, err := decodeSystemSettingsKey("not-a-key"); err == nil {
		t.Fatal("a short key must fail")
	}
	if _, err := decodeSystemSettingsKey(strings.Repeat("a", 63)); err == nil {
		t.Fatal("a 63 character hex key must fail")
	}
}

// TestEncryptDecryptRoundTrip locks the v1 envelope shape and the round trip.
func TestEncryptDecryptRoundTrip(t *testing.T) {
	key, err := decodeSystemSettingsKey(testKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := encryptStringValueV1("JBSWY3DPEHPK3PXP", key)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Enc != "system-settings:v1" || envelope.Alg != "aes-256-gcm" {
		t.Fatalf("envelope header = %+v", envelope)
	}
	if envelope.IV == nil || envelope.Tag == nil || envelope.Data == nil {
		t.Fatalf("envelope members missing: %+v", envelope)
	}
	raw, err := envelope.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range []string{`"__enc":"system-settings:v1"`, `"alg":"aes-256-gcm"`, `"iv":`, `"tag":`, `"data":`} {
		if !strings.Contains(string(raw), member) {
			t.Fatalf("envelope %s is missing %s", raw, member)
		}
	}
	plaintext, err := decryptStringValueV1(envelope, key)
	if err != nil {
		t.Fatal(err)
	}
	if plaintext != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("plaintext = %q", plaintext)
	}

	// A fresh IV per encryption means two envelopes of the same plaintext never
	// share ciphertext.
	second, err := encryptStringValueV1("JBSWY3DPEHPK3PXP", key)
	if err != nil {
		t.Fatal(err)
	}
	if *second.Data == *envelope.Data || *second.IV == *envelope.IV {
		t.Fatal("each encryption must use a fresh IV")
	}

	// A wrong key must fail the GCM verification instead of returning a value.
	otherKey, err := decodeSystemSettingsKey(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptStringValueV1(envelope, otherKey); err == nil {
		t.Fatal("a wrong key must fail")
	}
	tampered := envelope
	broken := "AAAA"
	tampered.Tag = &broken
	if _, err := decryptStringValueV1(tampered, key); err == nil {
		t.Fatal("a tampered tag must fail")
	}
}

// TestParseStoredSecretKinds locks the three named shapes of a JSON secret
// column.
func TestParseStoredSecretKinds(t *testing.T) {
	if got := parseStoredSecret([]byte(`"JBSWY3DPEHPK3PXP"`)); got.kind != secretPlaintext || got.plaintext != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("plaintext model = %+v", got)
	}
	envelope := `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"aXY=","tag":"dGFn","data":"ZGF0YQ=="}`
	if got := parseStoredSecret([]byte(envelope)); got.kind != secretEnvelope {
		t.Fatalf("envelope model = %+v", got)
	}
	for _, absent := range []string{"", "null", "[]", "12", "true", `{"__enc":"other"}`, `{"alg":"aes-256-gcm"}`} {
		if got := parseStoredSecret([]byte(absent)); got.kind != secretAbsent {
			t.Fatalf("parseStoredSecret(%q) = %+v, want absent", absent, got)
		}
	}
}

// TestDecodeSecretPolicy locks decodeSecret: plaintext passes through, an
// envelope without a usable key is "not found", and a decryption failure with a
// present key propagates.
func TestDecodeSecretPolicy(t *testing.T) {
	plain := &Service{cfg: Config{}}
	text, found, err := plain.decodeSecret([]byte(`"plain-secret"`))
	if err != nil || !found || text != "plain-secret" {
		t.Fatalf("plaintext decode = %q %v %v", text, found, err)
	}
	text, found, err = plain.decodeSecret([]byte(`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"aXY=","tag":"dGFn","data":"ZGF0YQ=="}`))
	if err != nil || found || text != "" {
		t.Fatalf("envelope without a key must be not-found, got %q %v %v", text, found, err)
	}
	text, found, err = plain.decodeSecret(nil)
	if err != nil || found || text != "" {
		t.Fatalf("absent value = %q %v %v", text, found, err)
	}

	withKey := &Service{cfg: Config{EncryptionKeyRaw: testKeyHex, EncryptionKeyPresent: true}}
	key := withKey.settingsKey()
	if key == nil {
		t.Fatal("the test key must resolve")
	}
	envelope, err := encryptStringValueV1("round-trip", key)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := envelope.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	text, found, err = withKey.decodeSecret(raw)
	if err != nil || !found || text != "round-trip" {
		t.Fatalf("envelope decode = %q %v %v", text, found, err)
	}

	// A ciphertext produced under a different key must surface as an error, not
	// as "no secret".
	otherKey := &Service{cfg: Config{EncryptionKeyRaw: strings.Repeat("ab", 32), EncryptionKeyPresent: true}}
	if _, _, err := otherKey.decodeSecret(raw); err == nil {
		t.Fatal("a wrong key must propagate a decryption error")
	}
}

// TestSettingsKeyPresenceRules locks the presence test performed on the raw,
// untrimmed environment value.
func TestSettingsKeyPresenceRules(t *testing.T) {
	cases := []struct {
		name    string
		cfg     Config
		wantNil bool
	}{
		{"missing", Config{}, true},
		{"blank", Config{EncryptionKeyRaw: "   ", EncryptionKeyPresent: true}, true},
		{"invalid", Config{EncryptionKeyRaw: "short", EncryptionKeyPresent: true}, true},
		{"valid hex", Config{EncryptionKeyRaw: testKeyHex, EncryptionKeyPresent: true}, false},
		{"present flag false", Config{EncryptionKeyRaw: testKeyHex, EncryptionKeyPresent: false}, true},
	}
	for _, tc := range cases {
		service := &Service{cfg: tc.cfg}
		got := service.settingsKey()
		if tc.wantNil && got != nil {
			t.Fatalf("%s: key = %x, want nil", tc.name, got)
		}
		if !tc.wantNil && got == nil {
			t.Fatalf("%s: key is nil", tc.name)
		}
	}
}

// TestConfiguredFromRawTriState locks the `typeof value === "boolean"` rule: a
// non-boolean member is "not configured", never an explicit false.
func TestConfiguredFromRawTriState(t *testing.T) {
	cases := []struct {
		raw       string
		wantValue bool
		wantOK    bool
	}{
		{`{"secretEncryptionEnabled":true}`, true, true},
		{`{"secretEncryptionEnabled":false}`, false, true},
		{`{"secretEncryptionEnabled":"true"}`, false, false},
		{`{"secretEncryptionEnabled":null}`, false, false},
		{`{"mfaPolicy":"off"}`, false, false},
		{`[]`, false, false},
		{`"x"`, false, false},
		{``, false, false},
	}
	for _, tc := range cases {
		value, ok := configuredFromRaw(json.RawMessage(tc.raw))
		if value != tc.wantValue || ok != tc.wantOK {
			t.Fatalf("configuredFromRaw(%s) = %v %v, want %v %v", tc.raw, value, ok, tc.wantValue, tc.wantOK)
		}
	}
}

// TestEncodeSecretPolicyWithoutDatabase locks the failure policy branches that
// do not need a stored settings row.
func TestEncodeSecretPolicyWithoutDatabase(t *testing.T) {
	// No database: the stored tri-state is unknown, so the policy falls back to
	// the environment.
	production := &Service{cfg: Config{NodeEnv: "production"}}
	if _, err := production.encodeSecret(context.Background(), "plain"); err == nil {
		t.Fatal("production without a key must fail")
	}
	development := &Service{cfg: Config{NodeEnv: "development"}}
	raw, err := development.encodeSecret(context.Background(), "plain")
	if err != nil {
		t.Fatal(err)
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil || text != "plain" {
		t.Fatalf("non-production fallback = %s (%v)", raw, err)
	}

	// With a valid key and no stored policy the value is encrypted.
	withKey := &Service{cfg: Config{EncryptionKeyRaw: testKeyHex, EncryptionKeyPresent: true}}
	raw, err = withKey.encodeSecret(context.Background(), "plain")
	if err != nil {
		t.Fatal(err)
	}
	stored := parseStoredSecret(raw)
	if stored.kind != secretEnvelope {
		t.Fatalf("expected an envelope, got %+v", stored)
	}
}
