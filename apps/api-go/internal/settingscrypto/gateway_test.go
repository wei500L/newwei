package settingscrypto

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestNormalizeGatewaySecret(t *testing.T) {
	cases := map[string]string{
		"":                  "",
		"   ":               "",
		"bearer":            "",
		"BEARER":            "",
		"  Bearer sk-live ": "sk-live",
		"sk-plain":          "sk-plain",
	}
	for input, want := range cases {
		if got := NormalizeGatewaySecret(input); got != want {
			t.Fatalf("NormalizeGatewaySecret(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestNormalizeGatewayAPIBase(t *testing.T) {
	cases := map[string]string{
		"":                        "",
		"  https://gw.example/  ": "https://gw.example",
		"https://gw.example/v1/chat/completions/": "https://gw.example",
		"https://gw.example/chat/completions":     "https://gw.example",
		"https://gw.example/v1/embeddings":        "https://gw.example",
		"https://gw.example/v1":                   "https://gw.example",
	}
	for input, want := range cases {
		if got := NormalizeGatewayAPIBase(input); got != want {
			t.Fatalf("NormalizeGatewayAPIBase(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestDecryptSettingsSecretRoundTrip(t *testing.T) {
	key := make([]byte, KeyBytes)
	for i := range key {
		key[i] = byte(i)
	}
	envelope, err := Encrypt("sk-live", key)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if !IsEncryptedSettingsSecret(raw) {
		t.Fatal("expected envelope to be recognised as encrypted")
	}
	plain, ok := DecryptSettingsSecret(raw, base64.StdEncoding.EncodeToString(key))
	if !ok || plain != "sk-live" {
		t.Fatalf("plain = %q ok=%v", plain, ok)
	}
	if _, ok := DecryptSettingsSecret(raw, ""); ok {
		t.Fatal("missing key must not yield plaintext")
	}
}

func TestMalformedEnvelopeFailsClosed(t *testing.T) {
	// The __enc/alg markers are present but iv/tag/data are missing: it must be
	// reported as encrypted (so callers treat it as a secret) yet fail to decrypt.
	raw := json.RawMessage(`{"__enc":"system-settings:v1","alg":"aes-256-gcm"}`)
	if !IsEncryptedSettingsSecret(raw) {
		t.Fatal("markers present, expected encrypted=true")
	}
	if _, ok := DecryptSettingsSecret(raw, base64.StdEncoding.EncodeToString(make([]byte, KeyBytes))); ok {
		t.Fatal("malformed envelope must fail closed")
	}
}
