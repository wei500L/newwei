package modelaccesssettings

import (
	"context"
	"encoding/json"
	"testing"
)

// TestNormalizeHTTPURLSamples pins the WHATWG normalisation samples verified
// against Node's new URL().toString().replace(/\/$/, "").
func TestNormalizeHTTPURLSamples(t *testing.T) {
	cases := []struct{ input, want string }{
		{input: "http://example.com", want: "http://example.com"},
		{input: "http://example.com/", want: "http://example.com"},
		{input: "HTTP://Example.COM", want: "http://example.com"},
		{input: "http://example.com:80", want: "http://example.com"},
		{input: "https://example.com:443/x", want: "https://example.com/x"},
		{input: "http://example.com:8080/", want: "http://example.com:8080"},
		{input: "http://example.com/a/", want: "http://example.com/a"},
		{input: "http://example.com/a//", want: "http://example.com/a/"},
		{input: "http://example.com/a/../b/./c/", want: "http://example.com/b/c"},
		{input: "http:example.com", want: "http://example.com"},
		{input: "http:/example.com", want: "http://example.com"},
		{input: "http:///example.com", want: "http://example.com"},
		{input: "http://user:pw@Example.com:80/p", want: "http://user:pw@example.com/p"},
		{input: "http://[::1]:80/p", want: "http://[::1]/p"},
		{input: "http://127.0.0.1:80", want: "http://127.0.0.1"},
		{input: "  http://example.com/x  ", want: "http://example.com/x"},
		{input: "http://example.com/x?A=b#F", want: "http://example.com/x?A=b#F"},
		{input: "http://example.com/%7euser", want: "http://example.com/%7euser"},
		{input: "http://example.com/a b", want: "http://example.com/a%20b"},
		{input: "http://example.com/?", want: "http://example.com/?"},
		{input: "http://example.com/#", want: "http://example.com/#"},
		{input: "http://example.com:080/", want: "http://example.com"},
		{input: "http://example.com./", want: "http://example.com."},
		{input: "http://example.com\\a\\b", want: "http://example.com/a/b"},
		{input: "http://example.com/x/", want: "http://example.com/x"},
		{input: "http://ex%41mple.com/", want: "http://example.com"},
	}
	for _, testCase := range cases {
		t.Run(testCase.input, func(t *testing.T) {
			got, err := normalizeHTTPURL(testCase.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("normalizeHTTPURL(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestNormalizeHTTPURLErrors pins every rejected shape with the NestJS message.
func TestNormalizeHTTPURLErrors(t *testing.T) {
	for _, input := range []string{"notaurl", "ftp://example.com/x", "//example.com/x", "http://", "http://example.com:99999", "example.com:8080", "http://example.com:abc"} {
		t.Run(input, func(t *testing.T) {
			_, err := normalizeHTTPURL(input)
			if err == nil {
				t.Fatalf("expected an error")
			}
			assertMessages(t, err, 400, "baseUrl must be a valid http(s) URL")
		})
	}
}

// TestNormalizeBaseURLInput pins the omitted/null/blank/valid split.
func TestNormalizeBaseURLInput(t *testing.T) {
	omitted, err := normalizeBaseURLInput(optionalString{Kind: optionalStringAbsent})
	if err != nil || omitted != nil {
		t.Fatalf("omitted = %v, %v", omitted, err)
	}
	null, err := normalizeBaseURLInput(optionalString{Kind: optionalStringNull})
	if err != nil || null != nil {
		t.Fatalf("null = %v, %v", null, err)
	}
	blank, err := normalizeBaseURLInput(optionalString{Kind: optionalStringValue, Value: "   "})
	if err != nil || blank != nil {
		t.Fatalf("blank = %v, %v", blank, err)
	}
	valid, err := normalizeBaseURLInput(optionalString{Kind: optionalStringValue, Value: " http://example.com/ "})
	if err != nil || valid == nil || *valid != "http://example.com" {
		t.Fatalf("valid = %v, %v", valid, err)
	}
}

// TestEffectiveConfigFallsBackToEnv pins each field's env fallback rule.
func TestEffectiveConfigFallsBackToEnv(t *testing.T) {
	harness := newTestHarness(Config{
		ModelServiceEnabled:       true,
		ModelServiceBaseURL:       " http://env.example.com/ ",
		ModelServiceInternalToken: "env-token",
		ModelServiceTimeoutMs:     15_000,
		ModelServiceMaxRetries:    2,
	})

	empty := harness.service.resolveEffectiveConfig(modelServiceRecord{present: true})
	// The env value is only JS-trimmed, never URL-normalized, so the trailing
	// slash survives exactly like `envDefaults.baseUrl?.trim()` in NestJS.
	if !empty.enabled || empty.baseURL != "http://env.example.com/" || empty.internalToken != "env-token" || empty.timeoutMs != 15_000 || empty.maxRetries != 2 {
		t.Fatalf("env defaults not applied: %+v", empty)
	}

	record, err := decodeModelServiceRecord(json.RawMessage(
		`{"enabled":false,"baseUrl":"http://db.example.com/","internalToken":"  ","timeoutMs":"12000","maxRetries":"3"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	stored := harness.service.resolveEffectiveConfig(record)
	if stored.enabled {
		t.Fatalf("stored boolean must override env")
	}
	if stored.baseURL != "http://db.example.com/" {
		t.Fatalf("stored baseUrl = %q", stored.baseURL)
	}
	if stored.internalToken != "env-token" {
		t.Fatalf("a blank stored token must fall back to env, got %q", stored.internalToken)
	}
	if stored.timeoutMs != 12_000 || stored.maxRetries != 3 {
		t.Fatalf("numeric coercion failed: %+v", stored)
	}

	// A stored value that is not a usable number falls back to env.
	invalid, err := decodeModelServiceRecord(json.RawMessage(`{"timeoutMs":0,"maxRetries":-1}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	fallback := harness.service.resolveEffectiveConfig(invalid)
	if fallback.timeoutMs != 15_000 || fallback.maxRetries != 2 {
		t.Fatalf("invalid stored numbers must fall back: %+v", fallback)
	}

	// An array-valued row counts as stored but reads no fields.
	array, err := decodeModelServiceRecord(json.RawMessage(`[1,2]`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !array.present {
		t.Fatalf("an array value must count as stored")
	}
	public := harness.service.buildModelServicePublic(array)
	if public.Source != settingsSourceDB {
		t.Fatalf("source = %q, want db", public.Source)
	}
	if !public.Enabled || public.BaseURL == nil || *public.BaseURL != "http://env.example.com/" {
		t.Fatalf("array row must fall back to env: %+v", public)
	}
}

// TestModelServiceTokenFourStates pins absent/null/blank/non-empty.
func TestModelServiceTokenFourStates(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})

	// A stored encrypted token is produced first so the "absent" case can prove
	// the raw stored value is preserved.
	encrypted, err := harness.service.encodeSecretForStorage(context.Background(), "stored-token")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	storedPayload, err := json.Marshal(encrypted)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	record, err := decodeModelServiceRecord(json.RawMessage(
		`{"enabled":true,"baseUrl":"http://x","internalToken":` + string(storedPayload) + `}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	absent, err := harness.service.resolveNextToken(context.Background(), record, optionalString{Kind: optionalStringAbsent})
	if err != nil {
		t.Fatalf("absent: %v", err)
	}
	if absent.kind != secretEncrypted {
		t.Fatalf("absent must keep the stored envelope, got kind %v", absent.kind)
	}
	if plain, ok := absent.resolvePlaintext(testKey(t), true); !ok || plain != "stored-token" {
		t.Fatalf("preserved token = %q, %v", plain, ok)
	}

	null, err := harness.service.resolveNextToken(context.Background(), record, optionalString{Kind: optionalStringNull})
	if err != nil {
		t.Fatalf("null: %v", err)
	}
	if null.kind != secretNull {
		t.Fatalf("null must clear the token, got kind %v", null.kind)
	}

	blank, err := harness.service.resolveNextToken(context.Background(), record, optionalString{Kind: optionalStringValue, Value: "   "})
	if err != nil {
		t.Fatalf("blank: %v", err)
	}
	if blank.kind != secretNull {
		t.Fatalf("blank must clear the token, got kind %v", blank.kind)
	}

	replacement, err := harness.service.resolveNextToken(context.Background(), record, optionalString{Kind: optionalStringValue, Value: "  new-token  "})
	if err != nil {
		t.Fatalf("new value: %v", err)
	}
	if replacement.kind != secretEncrypted {
		t.Fatalf("new value must be encrypted, got kind %v", replacement.kind)
	}
	if plain, ok := replacement.resolvePlaintext(testKey(t), true); !ok || plain != "new-token" {
		t.Fatalf("new token = %q, %v", plain, ok)
	}
}

// TestResolveNextTokenWithoutStoredRow pins the fresh-row behaviour.
func TestResolveNextTokenWithoutStoredRow(t *testing.T) {
	harness := newTestHarness(Config{SettingsEncryptionKeyRaw: testKeyHex})
	value, err := harness.service.resolveNextToken(context.Background(), modelServiceRecord{}, optionalString{Kind: optionalStringAbsent})
	if err != nil {
		t.Fatalf("absent without a row: %v", err)
	}
	if value.kind != secretNull {
		t.Fatalf("kind = %v, want null", value.kind)
	}
}

// TestModelServicePublicTokenSource pins source/tokenSource/hasToken.
func TestModelServicePublicTokenSource(t *testing.T) {
	harness := newTestHarness(Config{ModelServiceInternalToken: "env-token"})
	empty := harness.service.buildModelServicePublic(modelServiceRecord{})
	if empty.Source != settingsSourceEnv || empty.TokenSource != tokenSourceEnv || !empty.HasToken {
		t.Fatalf("env token projection = %+v", empty)
	}
	none := newTestHarness(Config{}).service.buildModelServicePublic(modelServiceRecord{})
	if none.TokenSource != tokenSourceNone || none.HasToken {
		t.Fatalf("no token projection = %+v", none)
	}

	stored, err := decodeModelServiceRecord(json.RawMessage(`{"internalToken":"stored-token"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	projected := harness.service.buildModelServicePublic(stored)
	if projected.Source != settingsSourceDB || projected.TokenSource != tokenSourceStored || !projected.HasToken {
		t.Fatalf("stored token projection = %+v", projected)
	}
	if projected.BaseURL != nil {
		t.Fatalf("baseUrl must be null when neither db nor env provides one")
	}
}
