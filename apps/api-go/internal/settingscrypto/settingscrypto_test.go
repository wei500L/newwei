package settingscrypto

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

// testKeyHex is a fixed 32-byte key in 64 hex characters.
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

// TestParseKey parses every accepted spelling and pins the failure sentinels.
func TestParseKey(t *testing.T) {
	key := testKey(t)
	base64Std := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
	base64Unpadded := strings.TrimRight(base64Std, "=")
	base64URLUnpadded := strings.NewReplacer("+", "-", "/", "_").Replace(base64Unpadded)
	// A key whose standard base64 contains '+' so the URL-safe swap is actually
	// exercised.
	urlKey := bytes.Repeat([]byte{0xfb}, 32)
	urlStd := base64.StdEncoding.EncodeToString(urlKey)
	urlSafe := strings.NewReplacer("+", "-", "/", "_").Replace(strings.TrimRight(urlStd, "="))

	cases := []struct {
		name    string
		input   string
		wantKey []byte
		wantErr error
	}{
		{name: "64 hex", input: testKeyHex, wantKey: key},
		{name: "64 hex uppercase", input: strings.ToUpper(testKeyHex), wantKey: key},
		{name: "0x prefixed hex", input: "0x" + testKeyHex, wantKey: key},
		{name: "0X prefixed hex", input: "0X" + testKeyHex, wantKey: key},
		{name: "trimmed hex", input: "  " + testKeyHex + "  ", wantKey: key},
		{name: "base64 padded", input: base64Std, wantKey: key},
		{name: "base64 unpadded", input: base64Unpadded, wantKey: key},
		{name: "base64 url-safe unpadded", input: base64URLUnpadded, wantKey: key},
		{name: "url-safe alphabet key", input: urlSafe, wantKey: urlKey},
		{name: "interleaved invalid chars", input: base64Std[:8] + "\n" + base64Std[8:], wantKey: key},
		{name: "empty", input: "", wantErr: ErrKeyEmpty},
		{name: "blank", input: "   ", wantErr: ErrKeyEmpty},
		{name: "too short", input: "abcd", wantErr: ErrKeyLength},
		{name: "63 hex", input: testKeyHex[:63], wantErr: ErrKeyLength},
		{name: "65 hex", input: testKeyHex + "0", wantErr: ErrKeyLength},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			decoded, err := ParseKey(testCase.input)
			if testCase.wantErr != nil {
				if err == nil {
					t.Fatalf("expected %v, got key %x", testCase.wantErr, decoded)
				}
				if err != testCase.wantErr {
					t.Fatalf("error = %v, want %v", err, testCase.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !bytes.Equal(decoded, testCase.wantKey) {
				t.Fatalf("decoded key = %x, want %x", decoded, testCase.wantKey)
			}
		})
	}
}

// TestNodeBase64Decode reproduces Node's lenient base64 decoder on the inputs
// this protocol can meet.
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

// TestEncryptDecryptRoundTrip verifies the envelope shape, a fresh IV per write
// and the round trip.
func TestEncryptDecryptRoundTrip(t *testing.T) {
	key := testKey(t)
	envelope, err := Encrypt("sk-secret-value", key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if envelope.Enc != EnvelopeTag || envelope.Alg != Algorithm {
		t.Fatalf("envelope header = %+v", envelope)
	}
	if envelope.IV == nil || envelope.Tag == nil || envelope.Data == nil {
		t.Fatalf("envelope members missing: %+v", envelope)
	}
	if len(nodeBase64Decode(*envelope.IV)) != IVBytes {
		t.Fatalf("iv length = %d, want %d", len(nodeBase64Decode(*envelope.IV)), IVBytes)
	}
	if len(nodeBase64Decode(*envelope.Tag)) != TagBytes {
		t.Fatalf("tag length = %d, want %d", len(nodeBase64Decode(*envelope.Tag)), TagBytes)
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"` + *envelope.IV + `","tag":"` + *envelope.Tag + `","data":"` + *envelope.Data + `"}`
	if string(raw) != want {
		t.Fatalf("envelope json = %s, want %s", raw, want)
	}
	plain, err := Decrypt(envelope, key)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if plain != "sk-secret-value" {
		t.Fatalf("plaintext = %q", plain)
	}
	second, err := Encrypt("sk-secret-value", key)
	if err != nil {
		t.Fatalf("encrypt 2: %v", err)
	}
	if *second.IV == *envelope.IV || *second.Data == *envelope.Data {
		t.Fatal("each encryption must use a fresh IV")
	}
}

// TestDecryptFailuresAreGeneric pins the single opaque decrypt error.
func TestDecryptFailuresAreGeneric(t *testing.T) {
	key := testKey(t)
	envelope, err := Encrypt("value", key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	encode := func(raw []byte) string { return base64.StdEncoding.EncodeToString(raw) }
	tamper := func(field *string) string {
		raw := nodeBase64Decode(*field)
		raw[0] ^= 0xff
		return encode(raw)
	}
	cases := []struct {
		name   string
		mutate func(Envelope) Envelope
	}{
		{name: "corrupted tag", mutate: func(e Envelope) Envelope { v := tamper(e.Tag); e.Tag = &v; return e }},
		{name: "corrupted data", mutate: func(e Envelope) Envelope { v := tamper(e.Data); e.Data = &v; return e }},
		{name: "corrupted iv", mutate: func(e Envelope) Envelope { v := tamper(e.IV); e.IV = &v; return e }},
		{name: "short iv", mutate: func(e Envelope) Envelope { v := encode([]byte{1, 2, 3}); e.IV = &v; return e }},
		{name: "short tag", mutate: func(e Envelope) Envelope { v := encode([]byte{1, 2, 3, 4}); e.Tag = &v; return e }},
		{name: "empty data", mutate: func(e Envelope) Envelope { v := ""; e.Data = &v; return e }},
		{name: "missing member", mutate: func(e Envelope) Envelope { e.Data = nil; return e }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := Decrypt(testCase.mutate(envelope), key); err != ErrDecrypt {
				t.Fatalf("expected ErrDecrypt, got %v", err)
			}
		})
	}
	if _, err := Decrypt(envelope, []byte{1, 2, 3}); err != ErrDecrypt {
		t.Fatalf("wrong key length error = %v", err)
	}
	other := append([]byte{}, key...)
	other[0] ^= 0xff
	if _, err := Decrypt(envelope, other); err != ErrDecrypt {
		t.Fatalf("wrong key error = %v", err)
	}
}

// TestIsEnvelope pins the plaintext-vs-ciphertext discriminator.
func TestIsEnvelope(t *testing.T) {
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
		{name: "empty", body: ``},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := IsEnvelope(json.RawMessage(testCase.body)); got != testCase.want {
				t.Fatalf("IsEnvelope(%s) = %v, want %v", testCase.body, got, testCase.want)
			}
		})
	}
}
