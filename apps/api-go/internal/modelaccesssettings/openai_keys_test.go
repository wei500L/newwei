package modelaccesssettings

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

// sha256Hex is the fingerprint helper the tests assert against.
func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// wrapPlain renders one wrapped entry holding a plaintext value.
func wrapPlain(t *testing.T, fingerprint, value string) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(openAiKeyEntryWrite{
		Fingerprint: fingerprint,
		Value:       secretValuePlain(value),
	})
	if err != nil {
		t.Fatalf("marshal entry: %v", err)
	}
	return payload
}

// keyEntries decodes a stored array into raw entries.
func keyEntries(t *testing.T, body string) []json.RawMessage {
	t.Helper()
	record, err := decodeOpenAiKeysRecord(json.RawMessage(body))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return record.entries
}

// TestStripBearerPrefixBoundaries pins the JavaScript regex behaviour.
func TestStripBearerPrefixBoundaries(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{input: "Bearer sk-a", want: "sk-a"},
		{input: "bearer\tsk-a", want: "sk-a"},
		{input: "BEARER  sk-a", want: "sk-a"},
		{input: "Bearer\u00a0sk-a", want: "sk-a"},
		{input: "bearer\u2003sk", want: "sk"},
		{input: "Bearer", want: "Bearer"},
		{input: "bearer ", want: ""},
		{input: "  bearer sk-a", want: "bearer sk-a"},
		{input: "x Bearer sk", want: "x Bearer sk"},
		{input: " Bearer\tsk ", want: "Bearer\tsk"},
		{input: "bearerXsk", want: "bearerXsk"},
		{input: "bearer\u0085sk", want: "bearer\u0085sk"},
		{input: "sk-plain", want: "sk-plain"},
		{input: "sk-plain ", want: "sk-plain"},
	}
	for _, testCase := range cases {
		t.Run(testCase.input, func(t *testing.T) {
			if got := stripBearerPrefix(testCase.input); got != testCase.want {
				t.Fatalf("stripBearerPrefix(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestNormalizeKeys pins the strip -> trim -> drop-empty -> dedupe order.
func TestNormalizeKeys(t *testing.T) {
	got := normalizeKeys([]string{"Bearer sk-a", " sk-a ", "", "   ", "sk-b", "bearer  sk-c", "sk-b"})
	want := []string{"sk-a", "sk-b", "sk-c"}
	if len(got) != len(want) {
		t.Fatalf("normalizeKeys = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("normalizeKeys = %v, want %v", got, want)
		}
	}
}

// TestFingerprintKey pins the SHA-256 of the stripped value.
func TestFingerprintKey(t *testing.T) {
	cases := []struct{ input, canonical string }{
		{input: "sk-a", canonical: "sk-a"},
		{input: "Bearer sk-a", canonical: "sk-a"},
		{input: "  sk-a  ", canonical: "sk-a"},
		{input: "bearer\tsk-a", canonical: "sk-a"},
	}
	for _, testCase := range cases {
		t.Run(testCase.input, func(t *testing.T) {
			if got, want := fingerprintKey(testCase.input), sha256Hex(testCase.canonical); got != want {
				t.Fatalf("fingerprintKey(%q) = %s, want %s", testCase.input, got, want)
			}
		})
	}
	if len(fingerprintKey("sk-a")) != 64 {
		t.Fatalf("fingerprint must be 64 lowercase hex characters")
	}
}

// TestLegacyKeyShapes pins the three stored shapes and the three algorithms'
// deliberate disagreement.
func TestLegacyKeyShapes(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	envelope, err := harness.service.encodeSecretForStorage(context.Background(), "sk-encrypted")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	envelopeJSON, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}

	entries := []json.RawMessage{
		json.RawMessage(`"sk-legacy-plain"`),
		envelopeJSON,
		wrapPlain(t, sha256Hex("sk-wrapped"), "sk-wrapped"),
		json.RawMessage(`""`),
		json.RawMessage(`null`),
		json.RawMessage(`{}`),
		json.RawMessage(`{"fingerprint":5,"value":"sk-bad"}`),
		json.RawMessage(`{"fingerprint":"deadbeef"}`),
		json.RawMessage(`{"fingerprint":"stored-fp","value":""}`),
	}

	resolved := harness.service.resolveKeys(entries)
	wantResolved := []string{"sk-legacy-plain", "sk-encrypted", "sk-wrapped"}
	assertStrings(t, "resolveKeys", resolved, wantResolved)

	fingerprints := harness.service.listKeyFingerprints(entries)
	wantFingerprints := []string{
		sha256Hex("sk-legacy-plain"),
		sha256Hex("sk-encrypted"),
		"stored-fp",
	}
	assertStrings(t, "listKeyFingerprints", fingerprints, wantFingerprints)

	// countStoredKeys counts by structure: the two empty/false wrapped values and
	// the unrecognized objects do not count, and neither do the falsy entries.
	if got, want := countStoredKeys(entries), 4; got != want {
		t.Fatalf("countStoredKeys = %d, want %d", got, want)
	}
}

// TestCountResolveFingerprintDisagreeOnEmptyPlaintext pins the intentional
// difference: a legacy plaintext entry whose stripped form is empty is hashed but
// not resolved.
func TestCountResolveFingerprintDisagreeOnEmptyPlaintext(t *testing.T) {
	harness := newTestHarness(Config{})
	entries := []json.RawMessage{json.RawMessage(`"   "`)}
	if got, want := countStoredKeys(entries), 1; got != want {
		t.Fatalf("countStoredKeys = %d, want %d", got, want)
	}
	if got := harness.service.resolveKeys(entries); len(got) != 0 {
		t.Fatalf("resolveKeys = %v, want empty", got)
	}
	fingerprints := harness.service.listKeyFingerprints(entries)
	assertStrings(t, "listKeyFingerprints", fingerprints, []string{sha256Hex("")})
}

// TestResolveKeysSkipsUndecryptableEntries proves a broken entry never becomes an
// error and the other entries survive.
func TestResolveKeysSkipsUndecryptableEntries(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	broken := json.RawMessage(`{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AAEC","tag":"AAEC","data":"AAEC"}`)
	entries := []json.RawMessage{
		broken,
		json.RawMessage(`"sk-alive"`),
	}
	resolved := harness.service.resolveKeys(entries)
	assertStrings(t, "resolveKeys", resolved, []string{"sk-alive"})
	assertStrings(t, "listKeyFingerprints", harness.service.listKeyFingerprints(entries), []string{sha256Hex("sk-alive")})
	if got, want := countStoredKeys(entries), 2; got != want {
		t.Fatalf("countStoredKeys = %d, want %d", got, want)
	}
}

// TestResolveKeysWithoutKeyKeepsPlaintext proves a missing key only affects
// encrypted entries.
func TestResolveKeysWithoutKeyKeepsPlaintext(t *testing.T) {
	harness := newTestHarness(Config{})
	harness.settings.seed(settingKeySystemSecurity, `{"secretEncryptionEnabled":false}`)
	envelope, err := newTestHarness(Config{}).service.encodeSecretForStorage(context.Background(), "sk-plain-write")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if envelope.kind != secretPlain {
		t.Fatalf("expected a plaintext envelope for this setup")
	}
	encryptedEnvelope, err := json.Marshal(encryptedSecret{
		Enc: "system-settings:v1", Alg: "aes-256-gcm", IV: "AAEC", Tag: "AAEC", Data: "AAEC",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	entries := []json.RawMessage{encryptedEnvelope, json.RawMessage(`"sk-legacy"`)}
	assertStrings(t, "resolveKeys", harness.service.resolveKeys(entries), []string{"sk-legacy"})
}

// TestRestartRequiredBranches pins the exact restartRequired formula.
func TestRestartRequiredBranches(t *testing.T) {
	harness := newTestHarness(Config{})
	keysRecord, err := decodeOpenAiKeysRecord(json.RawMessage(`{"openaiApiKeys":[
		{"fingerprint":"fp-1","value":"sk-1"},
		{"fingerprint":"fp-2","value":"sk-2"}
	]}`))
	if err != nil {
		t.Fatalf("decode keys: %v", err)
	}
	emptyRecord := openAiKeysRecord{present: true}

	cases := []struct {
		name     string
		record   openAiKeysRecord
		applied  string
		expected bool
	}{
		{name: "no report with keys", record: keysRecord, applied: ``, expected: true},
		{name: "report source env", record: keysRecord, applied: `{"source":"env","keyFingerprints":["fp-1","fp-2"],"appliedAt":"2026-01-01T00:00:00.000Z"}`, expected: true},
		{name: "report source none", record: keysRecord, applied: `{"source":"none","keyFingerprints":["fp-1","fp-2"]}`, expected: true},
		{name: "report db matching", record: keysRecord, applied: `{"source":"db","keyFingerprints":["fp-1","fp-2"]}`, expected: false},
		{name: "report db reordered set", record: keysRecord, applied: `{"source":"db","keyFingerprints":["fp-2","fp-1"]}`, expected: false},
		{name: "report db missing one", record: keysRecord, applied: `{"source":"db","keyFingerprints":["fp-1"]}`, expected: true},
		{name: "report db extra one", record: keysRecord, applied: `{"source":"db","keyFingerprints":["fp-1","fp-2","fp-3"]}`, expected: true},
		{name: "report db empty fingerprints with keys", record: keysRecord, applied: `{"source":"db","keyFingerprints":[]}`, expected: true},
		{name: "no keys and no report", record: emptyRecord, applied: ``, expected: false},
		{name: "no keys with db report", record: emptyRecord, applied: `{"source":"db","keyFingerprints":["fp-1"]}`, expected: true},
		{name: "no keys with db empty report", record: emptyRecord, applied: `{"source":"db","keyFingerprints":[]}`, expected: false},
		{name: "no keys with env report", record: emptyRecord, applied: `{"source":"env","keyFingerprints":["fp-1"]}`, expected: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			applied, err := decodeAppliedStatusRecord(json.RawMessage(testCase.applied))
			if err != nil {
				t.Fatalf("decode applied: %v", err)
			}
			public := harness.service.buildOpenAiKeysPublic(testCase.record, applied)
			if public.RestartRequired != testCase.expected {
				t.Fatalf("restartRequired = %v, want %v (applied=%s)", public.RestartRequired, testCase.expected, testCase.applied)
			}
		})
	}
}

// TestAppliedProjectionNormalization pins appliedAt / appliedSource /
// appliedKeyFingerprints normalization.
func TestAppliedProjectionNormalization(t *testing.T) {
	harness := newTestHarness(Config{})
	keys, err := decodeOpenAiKeysRecord(json.RawMessage(`{"openaiApiKeys":[]}`))
	if err != nil {
		t.Fatalf("decode keys: %v", err)
	}
	applied, err := decodeAppliedStatusRecord(json.RawMessage(
		`{"source":"other","keyFingerprints":[" a ","","a",5,"b"],"appliedAt":5}`))
	if err != nil {
		t.Fatalf("decode applied: %v", err)
	}
	public := harness.service.buildOpenAiKeysPublic(keys, applied)
	if public.AppliedAt != nil {
		t.Fatalf("appliedAt = %v, want nil (a non-string appliedAt is not usable)", *public.AppliedAt)
	}
	if public.AppliedSource != nil {
		t.Fatalf("appliedSource = %v, want nil", *public.AppliedSource)
	}
	assertStrings(t, "appliedKeyFingerprints", public.AppliedKeyFingerprints, []string{"a", "b"})
	if public.KeyFingerprints == nil || public.AppliedKeyFingerprints == nil {
		t.Fatalf("fingerprint arrays must serialize as [] not null")
	}
}

// TestEmptyStringArraysSerializeAsEmptyJSONArrays pins the wire shape.
func TestEmptyStringArraysSerializeAsEmptyJSONArrays(t *testing.T) {
	harness := newTestHarness(Config{})
	public := harness.service.buildOpenAiKeysPublic(openAiKeysRecord{}, appliedStatusRecord{})
	payload, err := json.Marshal(public)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{`"keyFingerprints":[]`, `"appliedKeyFingerprints":[]`, `"appliedAt":null`, `"appliedSource":null`, `"source":"none"`} {
		if !contains(string(payload), want) {
			t.Fatalf("payload %s is missing %s", payload, want)
		}
	}
}

// assertStrings compares two string slices.
func assertStrings(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("%s = %v, want %v", label, got, want)
		}
	}
}

// contains is a small strings.Contains wrapper for readability.
func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

// indexOf finds needle in haystack.
func indexOf(haystack, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}
