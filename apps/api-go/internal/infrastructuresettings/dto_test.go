package infrastructuresettings

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// requireMessage asserts the joined class-validator message.
func requireMessage(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %q, got nil", want)
	}
	var coded *httpError
	if !errors.As(err, &coded) {
		t.Fatalf("expected *httpError, got %T (%v)", err, err)
	}
	if coded.message != want {
		t.Fatalf("message =\n  %q\nwant\n  %q", coded.message, want)
	}
}

// TestVectorDTOMessages locks the declaration order and the per-constraint
// message order of UpdateVectorServiceSettingsDto.
func TestVectorDTOMessages(t *testing.T) {
	valid := `{"enabled":false,"fallbackToMongo":true,"baseUrl":"http://vector:4010",` +
		`"token":"secret-token","timeoutMs":5000,"maxRetries":2}`
	if _, err := parseVectorSettingsRequest([]byte(valid)); err != nil {
		t.Fatalf("valid body rejected: %v", err)
	}
	if _, err := parseVectorSettingsRequest([]byte(`{"enabled":true,"fallbackToMongo":false,"timeoutMs":100,"maxRetries":0}`)); err != nil {
		t.Fatalf("optional baseUrl/token must be skippable: %v", err)
	}
	if _, err := parseVectorSettingsRequest([]byte(`null`)); err == nil {
		t.Fatal("a JSON null body must behave like {} and fail the required fields")
	}
	if _, err := parseVectorSettingsRequest([]byte(`{"enabled":false,"fallbackToMongo":false,"timeoutMs":100,"maxRetries":0,"extra":1}`)); err == nil {
		t.Fatal("unknown property must be rejected")
	}

	cases := []struct {
		body string
		want string
	}{
		{`{}`,
			"enabled must be a boolean value; fallbackToMongo must be a boolean value; " +
				"timeoutMs must not be less than 100; timeoutMs must be an integer number; " +
				"maxRetries must not be greater than 10; maxRetries must not be less than 0; " +
				"maxRetries must be an integer number"},
		{`{"enabled":"true","fallbackToMongo":1,"baseUrl":5,"token":false,"timeoutMs":"5000","maxRetries":11.5}`,
			"enabled must be a boolean value; fallbackToMongo must be a boolean value; " +
				"baseUrl must be a string; token must be a string; " +
				"timeoutMs must not be less than 100; timeoutMs must be an integer number; " +
				"maxRetries must not be greater than 10; maxRetries must be an integer number"},
		{`{"enabled":false,"fallbackToMongo":false,"timeoutMs":99,"maxRetries":0}`,
			"timeoutMs must not be less than 100"},
		{`{"enabled":false,"fallbackToMongo":false,"timeoutMs":100.5,"maxRetries":0}`,
			"timeoutMs must be an integer number"},
		{`{"enabled":false,"fallbackToMongo":false,"timeoutMs":100,"maxRetries":-1}`,
			"maxRetries must not be less than 0"},
		{`{"enabled":false,"fallbackToMongo":false,"timeoutMs":100,"maxRetries":0,"unknown":"x"}`,
			"property unknown should not exist"},
		{`{"enabled":false,"fallbackToMongo":false,"timeoutMs":100,"maxRetries":0,"token":null,"baseUrl":null}`,
			""},
	}
	for _, tc := range cases {
		_, err := parseVectorSettingsRequest([]byte(tc.body))
		if tc.want == "" {
			if err != nil {
				t.Fatalf("%s: unexpected error %v", tc.body, err)
			}
			continue
		}
		requireMessage(t, err, tc.want)
	}
}

// TestStorageDTOMessages locks the storage declaration order and the TTL
// constraint order (Max, Min, IsInt).
func TestStorageDTOMessages(t *testing.T) {
	if _, err := parseStorageSettingsRequest([]byte(`{}`)); err != nil {
		t.Fatalf("empty storage patch must validate: %v", err)
	}
	if _, err := parseStorageSettingsRequest([]byte(`null`)); err != nil {
		t.Fatalf("JSON null must behave like {}: %v", err)
	}
	if _, err := parseStorageSettingsRequest([]byte(`{"crawlImageStorage":"s3","forcePathStyle":false,` +
		`"presignedUrlTtlSeconds":30,"endpoint":"http://127.0.0.1:9000","publicBaseUrl":"https://cdn.example.com/x"}`)); err != nil {
		t.Fatalf("valid storage patch rejected: %v", err)
	}

	cases := []struct {
		body string
		want string
	}{
		{`{"crawlImageStorage":"S3"}`,
			"crawlImageStorage must be one of the following values: mysql, s3"},
		{`{"crawlImageStorage":"local"}`,
			"crawlImageStorage must be one of the following values: mysql, s3"},
		{`{"accessKeyId":5,"secretAccessKey":true,"region":[],"bucket":{}}`,
			"accessKeyId must be a string; secretAccessKey must be a string; region must be a string; bucket must be a string"},
		{`{"endpoint":"not-a-url","publicBaseUrl":"localhost:9000"}`,
			"endpoint must be a URL address; publicBaseUrl must be a URL address"},
		{`{"forcePathStyle":"false"}`,
			"forcePathStyle must be a boolean value"},
		{`{"presignedUrlTtlSeconds":"300"}`,
			"presignedUrlTtlSeconds must not be greater than 3600; " +
				"presignedUrlTtlSeconds must not be less than 30; " +
				"presignedUrlTtlSeconds must be an integer number"},
		{`{"presignedUrlTtlSeconds":29.5}`,
			"presignedUrlTtlSeconds must not be less than 30; presignedUrlTtlSeconds must be an integer number"},
		{`{"presignedUrlTtlSeconds":3601}`,
			"presignedUrlTtlSeconds must not be greater than 3600"},
		{`{"other":1}`,
			"property other should not exist"},
	}
	for _, tc := range cases {
		_, err := parseStorageSettingsRequest([]byte(tc.body))
		requireMessage(t, err, tc.want)
	}
}

// TestStorageURLRules locks the validator.js isURL behaviour with
// require_protocol enabled and every other option at its default.
func TestStorageURLRules(t *testing.T) {
	cases := []struct {
		value string
		valid bool
	}{
		{"http://127.0.0.1:9000", true},
		{"http://localhost:9000", false},
		{"http://[::1]:9000", true},
		{"https://cdn.example.com/path", true},
		{"ftp://files.example.com/x", true},
		{"s3://bucket.example.com", false},
		{"not-a-url", false},
		{"http://host:70000", false},
		{"http://host:0", false},
		{"http://host:abc", false},
		{"http://", false},
		{"example.com:9000", false},
		{"http://exa mple.com", false},
		{"http://example.com/<x>", false},
		{"http://example.com/x?a=1&b=2#frag", true},
		{"http://", false},
		{"https://single-label", false},
		{"http://example.com.", false},
		{"mailto:user@example.com", false},
		{"//example.com", false},
		{"http://example.com/" + strings.Repeat("a", 2085), false},
		{"http://example.com/" + strings.Repeat("a", 2000), true},
		{"http://example.com:80", true},
		{"http://example.com_underscore.com", false},
		{"http://example.com/path with space", false},
	}
	for _, tc := range cases {
		if got := isURLValue(tc.value); got != tc.valid {
			t.Fatalf("isURLValue(%q) = %v, want %v", tc.value, got, tc.valid)
		}
	}
}

// TestRuntimeSecretsDTOMessages locks the nested property paths and the order
// NestJS's flattenValidationErrors produces.
func TestRuntimeSecretsDTOMessages(t *testing.T) {
	if _, err := parseRuntimeSecretsRequest([]byte(`{}`)); err != nil {
		t.Fatalf("empty body must validate: %v", err)
	}
	if _, err := parseRuntimeSecretsRequest([]byte(`{"upserts":null,"removes":null}`)); err != nil {
		t.Fatalf("explicit nulls must be skipped: %v", err)
	}
	valid := `{"upserts":[{"sourceId":"Example_1","key":"cookie","value":"v"}],"removes":[{"sourceId":"a","key":"k"}]}`
	if _, err := parseRuntimeSecretsRequest([]byte(valid)); err != nil {
		t.Fatalf("valid body rejected: %v", err)
	}

	cases := []struct {
		body string
		want string
	}{
		{`{"upserts":"x"}`,
			"upserts must contain no more than 500 elements; upserts must be an array; " +
				"each value in nested property upserts must be either object or array"},
		{`{"upserts":["x"]}`,
			"upserts.each value in nested property upserts must be either object or array"},
		{`{"removes":[null]}`,
			"removes.each value in nested property removes must be either object or array"},
		{`{"upserts":[{"sourceId":1}]}`,
			"upserts.0.sourceId must match /^[a-z0-9_-]+$/i regular expression; " +
				"upserts.0.sourceId must be a string; " +
				"upserts.0.key must be shorter than or equal to 128 characters; " +
				"upserts.0.key must match /^[a-zA-Z0-9._:-]+$/ regular expression; " +
				"upserts.0.key must be a string; " +
				"upserts.0.value must be shorter than or equal to 8192 characters; " +
				"upserts.0.value must be a string"},
		{`{"upserts":[{"sourceId":"a"}]}`,
			"upserts.0.key must be shorter than or equal to 128 characters; " +
				"upserts.0.key must match /^[a-zA-Z0-9._:-]+$/ regular expression; upserts.0.key must be a string; " +
				"upserts.0.value must be shorter than or equal to 8192 characters; upserts.0.value must be a string"},
		{`{"upserts":[{"sourceId":"a","key":"a b","value":"v"}]}`,
			"upserts.0.key must match /^[a-zA-Z0-9._:-]+$/ regular expression"},
		{`{"upserts":[{"sourceId":"a","key":"k","value":5}]}`,
			"upserts.0.value must be shorter than or equal to 8192 characters; upserts.0.value must be a string"},
		{`{"removes":[{"sourceId":"a","key":"k","extra":1}]}`,
			"removes.0.property extra should not exist"},
		{`{"top":1}`, "property top should not exist"},
		{`{"upserts":[{"sourceId":"a","key":"k","value":"v","x":1}]}`,
			"upserts.0.property x should not exist"},
	}
	for _, tc := range cases {
		_, err := parseRuntimeSecretsRequest([]byte(tc.body))
		requireMessage(t, err, tc.want)
	}

	// 500 elements pass the array bound; 501 fail it without per-element noise.
	okBody := buildRuntimeBody("upserts", 500, false)
	if _, err := parseRuntimeSecretsRequest([]byte(okBody)); err != nil {
		t.Fatalf("500 upserts must validate: %v", err)
	}
	tooMany := buildRuntimeBody("upserts", 501, false)
	_, err := parseRuntimeSecretsRequest([]byte(tooMany))
	requireMessage(t, err, "upserts must contain no more than 500 elements")
}

// buildRuntimeBody renders `{"<field>":[{...}, ...]}` with `count` entries.
func buildRuntimeBody(field string, count int, invalid bool) string {
	entries := make([]string, 0, count)
	for index := 0; index < count; index++ {
		if invalid {
			entries = append(entries, `{"sourceId":1}`)
			continue
		}
		entries = append(entries, `{"sourceId":"s","key":"k`+itoa(index)+`","value":"v"}`)
	}
	return `{"` + field + `":[` + strings.Join(entries, ",") + `]}`
}

// itoa is a tiny helper so the test does not need strconv at the call site.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// TestSystemSettingsKeyDecoding locks the accepted key encodings.
func TestSystemSettingsKeyDecoding(t *testing.T) {
	raw := make([]byte, systemSettingsKeyBytes)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	hexKey := hex.EncodeToString(raw)
	base64Key := base64.StdEncoding.EncodeToString(raw)

	if got, err := decodeSystemSettingsKey(hexKey); err != nil || hex.EncodeToString(got) != hexKey {
		t.Fatalf("hex key: %v %v", got, err)
	}
	if got, err := decodeSystemSettingsKey("0x" + hexKey); err != nil || hex.EncodeToString(got) != hexKey {
		t.Fatalf("0x hex key: %v %v", got, err)
	}
	if got, err := decodeSystemSettingsKey("  " + base64Key + "  "); err != nil || hex.EncodeToString(got) != hexKey {
		t.Fatalf("base64 key: %v %v", got, err)
	}
	if _, err := decodeSystemSettingsKey("   "); !errors.Is(err, errKeyEmpty) {
		t.Fatalf("blank key error = %v", err)
	}
	if _, err := decodeSystemSettingsKey("short-key"); !errors.Is(err, errKeyLength) {
		t.Fatalf("short key error = %v", err)
	}
	if _, err := decodeSystemSettingsKey(hexKey[:60]); !errors.Is(err, errKeyLength) {
		t.Fatalf("truncated hex error = %v", err)
	}
}

// TestEncryptDecryptV1 locks the envelope shape, the random IV and the
// authentication failure path.
func TestEncryptDecryptV1(t *testing.T) {
	key := make([]byte, systemSettingsKeyBytes)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	first, err := encryptStringValueV1("super-secret", key)
	if err != nil {
		t.Fatal(err)
	}
	second, err := encryptStringValueV1("super-secret", key)
	if err != nil {
		t.Fatal(err)
	}
	if !first.valid() {
		t.Fatalf("envelope not recognised: %+v", first)
	}
	if first.Enc != settingsEncTag || first.Alg != encryptionAlgorithm {
		t.Fatalf("envelope tags = %q %q", first.Enc, first.Alg)
	}
	if first.IV == nil || first.Tag == nil || first.Data == nil {
		t.Fatal("envelope members must all be present")
	}
	if *first.IV == *second.IV || *first.Data == *second.Data {
		t.Fatal("each encryption must use a fresh random IV")
	}

	encoded, err := first.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip encryptedStringValueV1
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if !roundTrip.valid() {
		t.Fatalf("round-tripped envelope invalid: %s", encoded)
	}
	plain, err := decryptStringValueV1(roundTrip, key)
	if err != nil || plain != "super-secret" {
		t.Fatalf("decrypt = %q %v", plain, err)
	}

	tampered := roundTrip
	otherTag := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef"))
	tampered.Tag = &otherTag
	if _, err := decryptStringValueV1(tampered, key); err == nil {
		t.Fatal("a tampered tag must fail authentication")
	}
	broken := roundTrip
	notBase64 := "!!!"
	broken.Data = &notBase64
	if _, err := decryptStringValueV1(broken, key); err == nil {
		t.Fatal("invalid base64 data must fail")
	}
	wrongKey := make([]byte, systemSettingsKeyBytes)
	if _, err := decryptStringValueV1(roundTrip, wrongKey); err == nil {
		t.Fatal("a wrong key must fail")
	}
	if _, err := decryptStringValueV1(encryptedStringValueV1{}, key); err == nil {
		t.Fatal("an incomplete envelope must be rejected")
	}
}
