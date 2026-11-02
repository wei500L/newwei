// Package itemsingest tests for the POST /api/items body contract
// (GAP-ITEMS-BODY-001).
//
// The limits asserted here are the ones the NestJS route actually applies:
// apps/api/src/main.ts:107-117 installs express.json({limit: "10mb"}) before the
// router, so a create body of up to 10 * 1024 * 1024 bytes reaches
// ItemsController.create and anything larger fails in the parser.
package itemsingest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// createBody builds a POST /api/items body whose serialized size is exactly
// targetSize bytes, by padding the payload's summary string.
func createBody(t *testing.T, targetSize int) string {
	t.Helper()
	// The skeleton below is measured, then the padding fills the difference.
	skeleton := `{"externalId":"ext-1","name":"Large","payload":{"summary":"` + `"}}`
	padding := targetSize - len(skeleton)
	if padding < 0 {
		t.Fatalf("target size %d is smaller than the skeleton (%d bytes)", targetSize, len(skeleton))
	}
	body := `{"externalId":"ext-1","name":"Large","payload":{"summary":"` +
		strings.Repeat("x", padding) + `"}}`
	if len(body) != targetSize {
		t.Fatalf("built body is %d bytes, want %d", len(body), targetSize)
	}
	return body
}

// TestParseCreateBodyAcceptsBodiesUpToTheNestLimit is the regression for the
// 1 MiB ceiling this handler used to apply: a legitimate 2 MiB create body (over
// the old limit, under the NestJS limit) must parse and validate successfully.
func TestParseCreateBodyAcceptsBodiesUpToTheNestLimit(t *testing.T) {
	cases := []struct {
		name string
		size int
	}{
		{name: "well under the old 1 MiB ceiling", size: 64 << 10},
		{name: "just under the old 1 MiB ceiling", size: (1 << 20) - 1},
		{name: "one byte over the old ceiling", size: (1 << 20) + 1},
		{name: "2 MiB", size: 2 << 20},
		{name: "exactly the 10 MiB ceiling", size: 10 << 20},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := createBody(t, testCase.size)
			request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
			request.Header.Set("content-type", "application/json")
			input, messages, err := parseCreateBody(request)
			if err != nil {
				t.Fatalf("parseCreateBody(%d bytes) returned %v, want no error", testCase.size, err)
			}
			if len(messages) > 0 {
				t.Fatalf("parseCreateBody(%d bytes) reported validation messages: %v", testCase.size, messages)
			}
			if input.ExternalID != "ext-1" || input.Name != "Large" {
				t.Fatalf("parsed fields = %+v, want externalId ext-1 and name Large", input)
			}
			var payload map[string]any
			if err := json.Unmarshal(input.Payload, &payload); err != nil {
				t.Fatalf("payload is not an object: %v", err)
			}
			if got := len(payload["summary"].(string)); got != testCase.size-len(`{"externalId":"ext-1","name":"Large","payload":{"summary":""}}`) {
				t.Fatalf("payload summary length = %d, want the padding", got)
			}
		})
	}
}

// TestParseCreateBodyRejectsBodiesOverTheNestLimit proves a body one byte over the
// 10 MiB parser ceiling is a distinct outcome from malformed JSON: NestJS fails it
// in body-parser before any controller runs, so it must not be reported as
// "Invalid JSON body".
func TestParseCreateBodyRejectsBodiesOverTheNestLimit(t *testing.T) {
	body := createBody(t, (10<<20)+1)
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	request.Header.Set("content-type", "application/json")
	_, messages, err := parseCreateBody(request)
	if err == nil {
		t.Fatal("parseCreateBody accepted a body over 10 MiB")
	}
	if !isErrCreateBodyTooLarge(err) {
		t.Fatalf("error = %v, want errCreateBodyTooLarge", err)
	}
	if messages != nil {
		t.Fatalf("an oversized body reported validation messages: %v", messages)
	}
}

// TestParseCreateBodyKeepsMalformedJSONAndValidationSeparate proves the two other
// outcomes are unchanged: malformed JSON is still its own 400 message, and a
// well-formed body with an invalid field still returns the ValidationPipe list.
func TestParseCreateBodyKeepsMalformedJSONAndValidationSeparate(t *testing.T) {
	t.Run("malformed JSON", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`{"externalId":`))
		_, _, err := parseCreateBody(request)
		if err == nil || err.Error() != "Invalid JSON body" {
			t.Fatalf("error = %v, want Invalid JSON body", err)
		}
		if isErrCreateBodyTooLarge(err) {
			t.Fatal("malformed JSON was reported as oversized")
		}
	})
	t.Run("JSON null", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(`null`))
		_, _, err := parseCreateBody(request)
		if err == nil || err.Error() != "Invalid JSON body" {
			t.Fatalf("error = %v, want Invalid JSON body", err)
		}
	})
	t.Run("field validation", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, Path,
			strings.NewReader(`{"externalId":1,"payload":[],"extra":true}`))
		_, messages, err := parseCreateBody(request)
		if err != nil {
			t.Fatalf("unexpected parse error: %v", err)
		}
		want := []string{
			"externalId must be shorter than or equal to 128 characters",
			"externalId must be a string",
			"name must be shorter than or equal to 255 characters",
			"name must be a string",
			"payload must be an object",
			"property extra should not exist",
		}
		if len(messages) != len(want) {
			t.Fatalf("messages = %v, want %v", messages, want)
		}
		for index, message := range want {
			if messages[index] != message {
				t.Fatalf("messages[%d] = %q, want %q", index, messages[index], message)
			}
		}
	})
}

// TestWriteCreateBodyTooLargeMatchesTheNestOverflowShape pins the response bytes.
//
// body-parser raises a 413 "entity too large" error, NestJS does not classify it
// as an HttpException, and GlobalExceptionFilter therefore renders a
// non-HttpException as 500 with the masked production message. The migrated route
// reuses authhttp.WritePayloadTooLarge for exactly that shape, so this test also
// covers the shared helper's use from this route.
func TestWriteCreateBodyTooLargeMatchesTheNestOverflowShape(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, Path, nil)
	request.Header.Set("x-trace-id", "abcdef0123456789")
	writeCreateBodyTooLarge(recorder, request)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if got := recorder.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
	var body struct {
		StatusCode int     `json:"statusCode"`
		Message    string  `json:"message"`
		Error      *string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", recorder.Body.String(), err)
	}
	if body.StatusCode != http.StatusInternalServerError {
		t.Fatalf("body statusCode = %d, want 500", body.StatusCode)
	}
	if body.Message != "Internal server error" {
		t.Fatalf("message = %q, want the masked production message", body.Message)
	}
	if body.Error != nil {
		t.Fatalf("error field = %v, want it absent", *body.Error)
	}
	if strings.Contains(recorder.Body.String(), "Invalid JSON body") {
		t.Fatal("the overflow body must not claim the JSON was invalid")
	}
}

// isErrCreateBodyTooLarge reports whether err is the overflow sentinel, without
// importing errors at the call sites above.
func isErrCreateBodyTooLarge(err error) bool {
	return err == errCreateBodyTooLarge
}
