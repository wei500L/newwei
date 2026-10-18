package llmgatewayprofiles

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
)

// messageOf returns the 400 message string of an error produced by the DTO
// layer, or "" when the error is not a coded 400.
func messageOf(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		return ""
	}
	var coded *httpError
	if !errors.As(err, &coded) {
		t.Fatalf("error %v is not an httpError", err)
	}
	if coded.status != 400 {
		t.Fatalf("error status = %d, want 400", coded.status)
	}
	return coded.message
}

func TestParseCreateProfileInputRequiresNameAndAPIBase(t *testing.T) {
	_, err := parseProfileInput(json.RawMessage(`{}`), true)
	want := "name must be a string; apiBase must be a URL address"
	if got := messageOf(t, err); got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}

	_, err = parseProfileInput(json.RawMessage(`{"bogus":1,"other":2}`), true)
	want = "property bogus should not exist; property other should not exist; name must be a string; apiBase must be a URL address"
	if got := messageOf(t, err); got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}

	input, err := parseProfileInput(json.RawMessage(`{"name":"gateway","apiBase":"http://localhost:4001"}`), true)
	if err != nil {
		t.Fatalf("valid create body rejected: %v", err)
	}
	if input.Name == nil || *input.Name != "gateway" {
		t.Fatalf("name = %v", input.Name)
	}
	// model is optional in the DTO; the service still rejects a missing model.
	if input.Model != nil {
		t.Fatalf("model = %v, want absent", input.Model)
	}
}

func TestParseUpdateProfileInputAcceptsEmptyBody(t *testing.T) {
	if _, err := parseProfileInput(json.RawMessage(`{}`), false); err != nil {
		t.Fatalf("empty update body rejected: %v", err)
	}
	if _, err := parseProfileInput(json.RawMessage(`{"name":null,"apiBase":null,"model":null}`), false); err != nil {
		t.Fatalf("null update body rejected: %v", err)
	}
}

func TestParseProfileInputConstraintOrder(t *testing.T) {
	body := `{
		"name": 1,
		"apiBase": "nope",
		"apiKey": 2,
		"model": 3,
		"embeddingModel": 4,
		"rerankModel": 5,
		"rerankFallbackModels": "abc",
		"assistantModel": 6,
		"assistantWebSearchEnabled": "x",
		"apiSurface": "bogus",
		"timeoutMs": "5000",
		"temperature": "hot",
		"topP": 2,
		"maxOutputTokens": 0,
		"maxRetries": 21,
		"fallbackModels": [1],
		"sendMetadata": "x",
		"responseFormatMode": "bogus",
		"enabled": "x"
	}`
	_, err := parseProfileInput(json.RawMessage(body), true)
	want := strings.Join([]string{
		"name must be a string",
		"apiBase must be a URL address",
		"apiKey must be a string",
		"model must be a string",
		"embeddingModel must be a string",
		"rerankModel must be a string",
		"rerankFallbackModels must contain no more than 20 elements",
		"rerankFallbackModels must be an array",
		"assistantModel must be a string",
		"assistantWebSearchEnabled must be a boolean value",
		"apiSurface must be one of the following values: chat_completions, responses",
		"timeoutMs must not be greater than 900000",
		"timeoutMs must not be less than 1000",
		"timeoutMs must be an integer number",
		"temperature must not be greater than 2",
		"temperature must not be less than 0",
		"topP must not be greater than 1",
		"maxOutputTokens must not be less than 1",
		"maxRetries must not be greater than 20",
		"each value in fallbackModels must be a string",
		"sendMetadata must be a boolean value",
		"responseFormatMode must be one of the following values: json_schema, json_object, none",
		"enabled must be a boolean value",
	}, "; ")
	if got := messageOf(t, err); got != want {
		t.Fatalf("message =\n%s\nwant\n%s", got, want)
	}
}

func TestParseProfileInputNumericBoundaries(t *testing.T) {
	valid := `{"timeoutMs":1000,"temperature":0,"topP":0,"maxOutputTokens":1,"maxRetries":1,"fallbackModels":[],"rerankFallbackModels":[]}`
	input, err := parseProfileInput(json.RawMessage(valid), false)
	if err != nil {
		t.Fatalf("lower bounds rejected: %v", err)
	}
	if !input.TimeoutMs.isFinite() || input.TimeoutMs.value != 1000 {
		t.Fatalf("timeoutMs = %+v", input.TimeoutMs)
	}
	if input.Temperature.value != 0 || input.TopP.value != 0 {
		t.Fatalf("temperature/topP = %+v/%+v", input.Temperature, input.TopP)
	}

	validUpper := `{"timeoutMs":900000,"temperature":2,"topP":1,"maxOutputTokens":1000000,"maxRetries":20}`
	if _, err := parseProfileInput(json.RawMessage(validUpper), false); err != nil {
		t.Fatalf("upper bounds rejected: %v", err)
	}

	_, err = parseProfileInput(json.RawMessage(`{"timeoutMs":1000.5}`), false)
	if got := messageOf(t, err); got != "timeoutMs must be an integer number" {
		t.Fatalf("fractional int message = %q", got)
	}

	// A numeric string is not coerced by class-validator.
	_, err = parseProfileInput(json.RawMessage(`{"maxRetries":"3"}`), false)
	want := "maxRetries must not be greater than 20; maxRetries must not be less than 1; maxRetries must be an integer number"
	if got := messageOf(t, err); got != want {
		t.Fatalf("string int message = %q, want %q", got, want)
	}

	// temperature/topP have no @IsInt.
	_, err = parseProfileInput(json.RawMessage(`{"temperature":1.5,"topP":0.25}`), false)
	if err != nil {
		t.Fatalf("fractional temperature/topP rejected: %v", err)
	}
}

func TestParseProfileInputArrayConstraints(t *testing.T) {
	items := make([]string, 0, 21)
	for index := 0; index < 21; index++ {
		items = append(items, `"m"`)
	}
	body := `{"fallbackModels":[` + strings.Join(items, ",") + `]}`
	_, err := parseProfileInput(json.RawMessage(body), false)
	if got := messageOf(t, err); got != "fallbackModels must contain no more than 20 elements" {
		t.Fatalf("array max message = %q", got)
	}

	// 20 elements pass.
	body = `{"fallbackModels":[` + strings.Join(items[:20], ",") + `]}`
	if _, err := parseProfileInput(json.RawMessage(body), false); err != nil {
		t.Fatalf("20 elements rejected: %v", err)
	}

	// A non-array, non-string value fails all three constraints in order.
	_, err = parseProfileInput(json.RawMessage(`{"fallbackModels":5}`), false)
	want := "each value in fallbackModels must be a string; fallbackModels must contain no more than 20 elements; fallbackModels must be an array"
	if got := messageOf(t, err); got != want {
		t.Fatalf("non-array message = %q, want %q", got, want)
	}

	// A bare string passes @IsString({each:true}) as a single item.
	_, err = parseProfileInput(json.RawMessage(`{"fallbackModels":"abc"}`), false)
	want = "fallbackModels must contain no more than 20 elements; fallbackModels must be an array"
	if got := messageOf(t, err); got != want {
		t.Fatalf("string array message = %q, want %q", got, want)
	}
}

func TestParseProfileInputURLContract(t *testing.T) {
	for _, valid := range []string{
		"http://localhost:4001",
		"https://example.com",
		"http://localhost:4001/v1",
		"ftp://example.com",
		"http://127.0.0.1:8080",
	} {
		body, err := json.Marshal(struct {
			APIBase string `json:"apiBase"`
		}{APIBase: valid})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseProfileInput(body, false); err != nil {
			t.Fatalf("apiBase %q rejected: %v", valid, err)
		}
	}
	for _, invalid := range []string{
		"localhost:4001",
		"example.com",
		"not a url",
		"",
	} {
		body, err := json.Marshal(struct {
			APIBase string `json:"apiBase"`
		}{APIBase: invalid})
		if err != nil {
			t.Fatal(err)
		}
		_, err = parseProfileInput(body, false)
		if got := messageOf(t, err); got != "apiBase must be a URL address" {
			t.Fatalf("apiBase %q message = %q", invalid, got)
		}
	}
}

func TestParseProfileInputDuplicateKeysLastWins(t *testing.T) {
	input, err := parseProfileInput(json.RawMessage(`{"name":"first","name":"second"}`), false)
	if err != nil {
		t.Fatalf("duplicate keys rejected: %v", err)
	}
	if input.Name == nil || *input.Name != "second" {
		t.Fatalf("name = %v, want second", input.Name)
	}
}

func TestParseActiveSelectionDTO(t *testing.T) {
	input, err := parseActiveSelection(json.RawMessage(`{}`), false)
	if err != nil || input.ActiveID != nil {
		t.Fatalf("empty active body = %+v err=%v", input, err)
	}
	input, err = parseActiveSelection(json.RawMessage(`{"activeId":null}`), false)
	if err != nil || input.ActiveID != nil {
		t.Fatalf("null active body = %+v err=%v", input, err)
	}
	// An empty string is a legal DTO value and must survive as "".
	input, err = parseActiveSelection(json.RawMessage(`{"activeId":""}`), false)
	if err != nil || input.ActiveID == nil || *input.ActiveID != "" {
		t.Fatalf("empty string active body = %+v err=%v", input, err)
	}
	_, err = parseActiveSelection(json.RawMessage(`{"activeId":5}`), false)
	if got := messageOf(t, err); got != "activeId must be a string" {
		t.Fatalf("activeId message = %q", got)
	}
	// The completion DTO does not declare mode.
	_, err = parseActiveSelection(json.RawMessage(`{"mode":"use_default"}`), false)
	if got := messageOf(t, err); got != "property mode should not exist" {
		t.Fatalf("mode on completion body message = %q", got)
	}
}

func TestParseActiveSelectionModeDTO(t *testing.T) {
	input, err := parseActiveSelection(json.RawMessage(`{"mode":"use_default"}`), true)
	if err != nil {
		t.Fatalf("valid mode rejected: %v", err)
	}
	if input.Mode == nil || *input.Mode != string(EmbeddingModeUseDefault) {
		t.Fatalf("mode = %v", input.Mode)
	}
	input, err = parseActiveSelection(json.RawMessage(`{"mode":null}`), true)
	if err != nil || input.Mode != nil || !input.ModeSet {
		t.Fatalf("null mode = %+v err=%v", input, err)
	}
	// The enum constraint was declared after @IsString, so its message is first.
	_, err = parseActiveSelection(json.RawMessage(`{"mode":5}`), true)
	want := "mode must be one of the following values: follow_completion, use_default; mode must be a string"
	if got := messageOf(t, err); got != want {
		t.Fatalf("mode message = %q, want %q", got, want)
	}
	_, err = parseActiveSelection(json.RawMessage(`{"mode":"bogus"}`), true)
	want = "mode must be one of the following values: follow_completion, use_default"
	if got := messageOf(t, err); got != want {
		t.Fatalf("mode enum message = %q, want %q", got, want)
	}
}

func TestParseProfileInputRejectsNonObjectBody(t *testing.T) {
	for _, body := range []string{`[]`, `5`, `"x"`, `null`, `true`} {
		_, err := parseProfileInput(json.RawMessage(body), false)
		if got := messageOf(t, err); got != "an unknown value was passed to the validate function" {
			t.Fatalf("body %s message = %q", body, got)
		}
	}
}

func TestParseJSNumberSemantics(t *testing.T) {
	cases := []struct {
		raw       string
		wantValue float64
		wantNaN   bool
	}{
		{raw: `null`, wantValue: 0},
		{raw: `true`, wantValue: 1},
		{raw: `false`, wantValue: 0},
		{raw: `""`, wantValue: 0},
		{raw: `" 12 "`, wantValue: 12},
		{raw: `"abc"`, wantNaN: true},
		{raw: `[]`, wantValue: 0},
		{raw: `[5]`, wantValue: 5},
		{raw: `[1,2]`, wantNaN: true},
		{raw: `{}`, wantNaN: true},
		{raw: `0x10`, wantNaN: true},
		{raw: `"1e999"`, wantValue: math.Inf(1)},
	}
	for _, tc := range cases {
		got := parseJSNumber(json.RawMessage(tc.raw))
		if tc.wantNaN {
			if got.kind != jsNumberNaN {
				t.Fatalf("parseJSNumber(%s) = %+v, want NaN", tc.raw, got)
			}
			continue
		}
		if got.kind != jsNumberValue || got.value != tc.wantValue {
			t.Fatalf("parseJSNumber(%s) = %+v, want %v", tc.raw, got, tc.wantValue)
		}
	}
	if got := parseJSNumber(json.RawMessage(`"0x10"`)); got.kind != jsNumberValue || got.value != 16 {
		t.Fatalf("parseJSNumber hex string = %+v, want 16", got)
	}
	if asPositiveInt(parseJSNumber(json.RawMessage(`true`)), 7) != 1 {
		t.Fatalf("asPositiveInt(true) must be 1")
	}
	if asPositiveInt(parseJSNumber(json.RawMessage(`null`)), 7) != 7 {
		t.Fatalf("asPositiveInt(null) must fall back")
	}
}

func TestStripBearerPrefix(t *testing.T) {
	cases := map[string]string{
		"  sk-abc  ":      "sk-abc",
		"Bearer sk-abc":   "sk-abc",
		"bearer   sk-abc": "sk-abc",
		"BEARER sk-abc":   "sk-abc",
		"bearer":          "",
		"Bearer":          "",
		"  bearer  ":      "",
		"sk-abc":          "sk-abc",
		"Bearer bearer x": "bearer x",
		"":                "",
	}
	for input, want := range cases {
		if got := stripBearerPrefix(input); got != want {
			t.Fatalf("stripBearerPrefix(%q) = %q, want %q", input, got, want)
		}
	}
}
