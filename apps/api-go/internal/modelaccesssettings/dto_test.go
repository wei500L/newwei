package modelaccesssettings

import (
	"strconv"
	"strings"
	"testing"
)

// messageOf extracts the "; " joined message of a validation error.
func messageOf(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a validation error, got nil")
	}
	var coded *httpError
	if !asHTTPError(err, &coded) {
		t.Fatalf("expected *httpError, got %T (%v)", err, err)
	}
	return coded.message
}

// asHTTPError is a tiny errors.As wrapper keeping the tests free of an import
// cycle on the standard library alias list.
func asHTTPError(err error, target **httpError) bool {
	coded, ok := err.(*httpError)
	if !ok {
		return false
	}
	*target = coded
	return true
}

// assertMessages asserts the exact "; " joined message and status.
func assertMessages(t *testing.T, err error, wantStatus int, wantMessages ...string) {
	t.Helper()
	coded, ok := err.(*httpError)
	if !ok {
		t.Fatalf("expected *httpError, got %T (%v)", err, err)
	}
	if coded.status != wantStatus {
		t.Fatalf("status = %d, want %d (message %q)", coded.status, wantStatus, coded.message)
	}
	want := strings.Join(wantMessages, "; ")
	if coded.message != want {
		t.Fatalf("message mismatch\n got: %q\nwant: %q", coded.message, want)
	}
}

// TestModelServiceDTOOrderAndMessages pins class-validator's message set and the
// order the ValidationPipe collects it in.
func TestModelServiceDTOOrderAndMessages(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{
			name: "empty object reports every required field in declaration order",
			body: `{}`,
			want: []string{
				"enabled must be a boolean value",
				"timeoutMs must not be less than 100",
				"timeoutMs must be an integer number",
				"maxRetries must not be greater than 10",
				"maxRetries must not be less than 0",
				"maxRetries must be an integer number",
			},
		},
		{
			name: "wrong types do not coerce",
			body: `{"enabled":"true","baseUrl":5,"internalToken":{},"timeoutMs":"100","maxRetries":"2"}`,
			want: []string{
				"enabled must be a boolean value",
				"baseUrl must be a string",
				"internalToken must be a string",
				"timeoutMs must not be less than 100",
				"timeoutMs must be an integer number",
				"maxRetries must not be greater than 10",
				"maxRetries must not be less than 0",
				"maxRetries must be an integer number",
			},
		},
		{
			name: "null baseUrl and internalToken are optional",
			body: `{"enabled":false,"baseUrl":null,"internalToken":null,"timeoutMs":100,"maxRetries":0}`,
			want: nil,
		},
		{
			name: "constraints run independently",
			body: `{"enabled":false,"timeoutMs":50,"maxRetries":50}`,
			want: []string{
				// Only the violated constraints report: maxRetries=50 is a
				// non-negative integer, so Min and IsInt pass.
				"timeoutMs must not be less than 100",
				"maxRetries must not be greater than 10",
			},
		},
		{
			name: "unknown properties are reported first in body order",
			body: `{"enabled":true,"zzz":1,"timeoutMs":100,"aaa":2,"maxRetries":1}`,
			want: []string{
				"property zzz should not exist",
				"property aaa should not exist",
			},
		},
		{
			name: "non-integer numbers fail IsInt",
			body: `{"enabled":false,"timeoutMs":100.5,"maxRetries":1}`,
			want: []string{"timeoutMs must be an integer number"},
		},
		{
			name: "infinity fails IsInt like JSON.parse",
			body: `{"enabled":false,"timeoutMs":1e999,"maxRetries":1}`,
			want: []string{"timeoutMs must be an integer number"},
		},
		{
			name: "array body reports indices as unknown properties",
			body: `[1,2]`,
			want: []string{
				"property 0 should not exist",
				"property 1 should not exist",
				"enabled must be a boolean value",
				"timeoutMs must not be less than 100",
				"timeoutMs must be an integer number",
				"maxRetries must not be greater than 10",
				"maxRetries must not be less than 0",
				"maxRetries must be an integer number",
			},
		},
		{
			name: "primitive body validates like an empty object",
			body: `5`,
			want: []string{
				"enabled must be a boolean value",
				"timeoutMs must not be less than 100",
				"timeoutMs must be an integer number",
				"maxRetries must not be greater than 10",
				"maxRetries must not be less than 0",
				"maxRetries must be an integer number",
			},
		},
		{
			name: "duplicate keys keep the last value and the first position",
			body: `{"enabled":true,"enabled":false,"timeoutMs":100,"maxRetries":1}`,
			want: nil,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request, err := parseUpdateModelServiceSettingsRequest([]byte(testCase.body))
			if len(testCase.want) == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				_ = request
				return
			}
			assertMessages(t, err, 400, testCase.want...)
		})
	}
}

// TestModelServiceDTOAcceptsBoundaries pins the accepted boundaries.
func TestModelServiceDTOAcceptsBoundaries(t *testing.T) {
	request, err := parseUpdateModelServiceSettingsRequest([]byte(
		`{"enabled":true,"baseUrl":"http://x","internalToken":"t","timeoutMs":100,"maxRetries":10}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if request.TimeoutMs != 100 || request.MaxRetries != 10 {
		t.Fatalf("boundaries not accepted: %+v", request)
	}
	if request.BaseURL.Kind != optionalStringValue || request.BaseURL.Value != "http://x" {
		t.Fatalf("baseUrl not parsed: %+v", request.BaseURL)
	}
	if request.InternalToken.Kind != optionalStringValue || request.InternalToken.Value != "t" {
		t.Fatalf("internalToken not parsed: %+v", request.InternalToken)
	}
}

// TestModelServiceDTOPresenceStates distinguishes absent, null and empty values.
func TestModelServiceDTOPresenceStates(t *testing.T) {
	absent, err := parseUpdateModelServiceSettingsRequest([]byte(`{"enabled":false,"timeoutMs":100,"maxRetries":2}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if absent.InternalToken.Kind != optionalStringAbsent {
		t.Fatalf("absent internalToken kind = %v", absent.InternalToken.Kind)
	}
	null, err := parseUpdateModelServiceSettingsRequest([]byte(`{"enabled":false,"internalToken":null,"timeoutMs":100,"maxRetries":2}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if null.InternalToken.Kind != optionalStringNull {
		t.Fatalf("null internalToken kind = %v", null.InternalToken.Kind)
	}
	blank, err := parseUpdateModelServiceSettingsRequest([]byte(`{"enabled":false,"internalToken":"   ","timeoutMs":100,"maxRetries":2}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if blank.InternalToken.Kind != optionalStringValue || blank.InternalToken.Value != "   " {
		t.Fatalf("blank internalToken = %+v", blank.InternalToken)
	}
}

// keysBody builds a {"keys":[...]} body with exactly count distinct strings.
func keysBody(count int) string {
	parts := make([]string, 0, count)
	for index := 0; index < count; index++ {
		parts = append(parts, `"sk-`+strconv.Itoa(index)+`"`)
	}
	return `{"keys":[` + strings.Join(parts, ",") + `]}`
}

// TestOpenAiKeysDTOMessages pins the keys DTO's independent constraints.
func TestOpenAiKeysDTOMessages(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{
			name: "absent keys reports every constraint",
			body: `{}`,
			want: []string{
				"each value in keys must be a string",
				"keys must contain no more than 100 elements",
				"keys must be an array",
			},
		},
		{
			name: "non-array value",
			body: `{"keys":"sk-a"}`,
			want: []string{
				"keys must contain no more than 100 elements",
				"keys must be an array",
			},
		},
		{
			name: "non-string element",
			body: `{"keys":[1,"sk-a"]}`,
			want: []string{"each value in keys must be a string"},
		},
		{
			name: "101 elements only trips ArrayMaxSize",
			body: keysBody(101),
			want: []string{"keys must contain no more than 100 elements"},
		},
		{
			name: "100 elements is accepted",
			body: keysBody(100),
			want: nil,
		},
		{
			name: "unknown property first",
			body: `{"nope":1,"keys":[]}`,
			want: []string{"property nope should not exist"},
		},
		{
			name: "empty array is valid",
			body: `{"keys":[]}`,
			want: nil,
		},
		{
			name: "empty strings and duplicates pass the DTO",
			body: `{"keys":["","sk-a","sk-a","   "]}`,
			want: nil,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request, err := parseUpdateOpenAiKeysSettingsRequest([]byte(testCase.body))
			if len(testCase.want) == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if request.Keys == nil {
					t.Fatalf("keys must be a non-nil slice")
				}
				return
			}
			assertMessages(t, err, 400, testCase.want...)
		})
	}
}

// TestAppliedDTOMessages pins the applied-status DTO, including the isIn/isString
// order.
func TestAppliedDTOMessages(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		want       []string
		wantSource appliedSource
	}{
		{
			name: "absent everything",
			body: `{}`,
			want: []string{
				"source must be one of the following values: db, env, none",
				"source must be a string",
				"each value in keyFingerprints must be a string",
				"keyFingerprints must contain no more than 100 elements",
				"keyFingerprints must be an array",
			},
		},
		{
			name: "wrong source type",
			body: `{"source":5,"keyFingerprints":[]}`,
			want: []string{
				"source must be one of the following values: db, env, none",
				"source must be a string",
			},
		},
		{
			name: "unknown source value",
			body: `{"source":"both","keyFingerprints":[]}`,
			want: []string{"source must be one of the following values: db, env, none"},
		},
		{
			name: "unknown property first",
			body: `{"extra":1,"source":"db","keyFingerprints":[]}`,
			want: []string{"property extra should not exist"},
		},
		{
			name:       "valid db report",
			body:       `{"source":"db","keyFingerprints":["a","b"]}`,
			wantSource: appliedSourceDB,
		},
		{
			name:       "valid none report with empty fingerprints",
			body:       `{"source":"none","keyFingerprints":[]}`,
			wantSource: appliedSourceNone,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request, err := parseReportAppliedRequest([]byte(testCase.body))
			if len(testCase.want) == 0 {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if request.Source != testCase.wantSource {
					t.Fatalf("source = %q, want %q", request.Source, testCase.wantSource)
				}
				return
			}
			assertMessages(t, err, 400, testCase.want...)
		})
	}
}

// TestInvalidJSONBodyIsBadRequest pins the invalid-body shape.
func TestInvalidJSONBodyIsBadRequest(t *testing.T) {
	_, err := parseUpdateModelServiceSettingsRequest([]byte(`{`))
	coded, ok := err.(*httpError)
	if !ok || coded.status != 400 {
		t.Fatalf("expected 400 httpError, got %v", err)
	}
	if coded.message != "Invalid request body" {
		t.Fatalf("message = %q", coded.message)
	}
}

// TestUnknownProtoPropertyIsStripped mirrors stripProtoKeys deleting __proto__
// before whitelisting.
func TestUnknownProtoPropertyIsStripped(t *testing.T) {
	request, err := parseUpdateModelServiceSettingsRequest([]byte(
		`{"__proto__":1,"enabled":false,"timeoutMs":100,"maxRetries":1}`))
	if err != nil {
		t.Fatalf("__proto__ must not be reported as an unknown property: %v", err)
	}
	if request.Enabled {
		t.Fatalf("enabled = true, want false")
	}
}

// TestMessageHelper checks the assertion helper itself.
func TestMessageHelper(t *testing.T) {
	_, err := parseUpdateModelServiceSettingsRequest([]byte(`{}`))
	if messageOf(t, err) == "" {
		t.Fatalf("empty message")
	}
}
