package modelaccesssettings

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// internalToken is the configured internal bearer token used by the handler tests.
const internalToken = "internal-token-0123456789"

// newInternalHandler builds a handler over in-memory ports with the internal token
// configured.
func newInternalHandler(t *testing.T) (*Handler, *testHarness) {
	t.Helper()
	harness := newTestHarness(Config{LiteLLMConfigInternalToken: internalToken, SettingsEncryptionKeyRaw: testKeyHex})
	authenticator := newAuthenticatorWithIdentity(nil, harness.identity)
	return NewHandler(authenticator, harness.service), harness
}

// TestHandlerInternalGetKeys pins route 9's guard, status and body.
func TestHandlerInternalGetKeys(t *testing.T) {
	handler, harness := newInternalHandler(t)
	harness.settings.seed(settingKeyOpenAiKeys, `{"openaiApiKeys":["sk-one","Bearer sk-two"]}`)

	request := httptest.NewRequest(http.MethodGet, pathInternalOpenAiKeys, nil)
	request.Header.Set("Authorization", "Bearer "+internalToken)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Body.String(); got != `{"openaiApiKeys":["sk-one","sk-two"]}` {
		t.Fatalf("body = %s", got)
	}

	// A JWT-shaped bearer is not privileged here: it simply fails the comparison.
	jwtRequest := httptest.NewRequest(http.MethodGet, pathInternalOpenAiKeys, nil)
	jwtRequest.Header.Set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")
	jwtRecorder := httptest.NewRecorder()
	handler.ServeHTTP(jwtRecorder, jwtRequest)
	if jwtRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("JWT on the internal route: status = %d", jwtRecorder.Code)
	}
	// An mtk_ machine token is not privileged either.
	machineRequest := httptest.NewRequest(http.MethodGet, pathInternalOpenAiKeys, nil)
	machineRequest.Header.Set("Authorization", "Bearer mtk_abc")
	machineRecorder := httptest.NewRecorder()
	handler.ServeHTTP(machineRecorder, machineRequest)
	if machineRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("mtk_ on the internal route: status = %d", machineRecorder.Code)
	}
}

// TestHandlerInternalReportRunsTheGuardBeforeTheDTO pins the ordering.
func TestHandlerInternalReportRunsTheGuardBeforeTheDTO(t *testing.T) {
	handler, harness := newInternalHandler(t)

	// Wrong token + invalid body: the guard must win.
	badToken := httptest.NewRequest(http.MethodPost, pathInternalOpenAiKeysApplied,
		strings.NewReader(`{"source":"nope"}`))
	badToken.Header.Set("Authorization", "Bearer wrong")
	badToken.Header.Set("content-type", "application/json")
	badTokenRecorder := httptest.NewRecorder()
	handler.ServeHTTP(badTokenRecorder, badToken)
	if badTokenRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", badTokenRecorder.Code, badTokenRecorder.Body.String())
	}

	// Correct token + invalid body: the DTO wins.
	badBody := httptest.NewRequest(http.MethodPost, pathInternalOpenAiKeysApplied,
		strings.NewReader(`{"source":"nope","keyFingerprints":[]}`))
	badBody.Header.Set("Authorization", "Bearer "+internalToken)
	badBody.Header.Set("content-type", "application/json")
	badBodyRecorder := httptest.NewRecorder()
	handler.ServeHTTP(badBodyRecorder, badBody)
	if badBodyRecorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", badBodyRecorder.Code, badBodyRecorder.Body.String())
	}
	if !strings.Contains(badBodyRecorder.Body.String(), "source must be one of the following values: db, env, none") {
		t.Fatalf("body = %s", badBodyRecorder.Body.String())
	}

	// Correct token + valid body: 201 {"ok":true}.
	valid := httptest.NewRequest(http.MethodPost, pathInternalOpenAiKeysApplied,
		strings.NewReader(`{"source":"db","keyFingerprints":["fp-1"]}`))
	valid.Header.Set("Authorization", "Bearer "+internalToken)
	valid.Header.Set("content-type", "application/json")
	validRecorder := httptest.NewRecorder()
	handler.ServeHTTP(validRecorder, valid)
	if validRecorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", validRecorder.Code, validRecorder.Body.String())
	}
	if validRecorder.Body.String() != `{"ok":true}` {
		t.Fatalf("body = %s", validRecorder.Body.String())
	}
	if !harness.settings.present[settingKeyAppliedStatus] {
		t.Fatalf("the applied row must be written")
	}
}

// TestHandlerInternalMethodMismatchIsNotFound pins the method table.
func TestHandlerInternalMethodMismatchIsNotFound(t *testing.T) {
	handler, _ := newInternalHandler(t)
	request := httptest.NewRequest(http.MethodDelete, pathInternalOpenAiKeys, nil)
	request.Header.Set("Authorization", "Bearer "+internalToken)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d", recorder.Code)
	}
}

// TestHandlerRoutingFallbackIsNotFound pins the in-package dispatch fallback.
func TestHandlerRoutingFallbackIsNotFound(t *testing.T) {
	handler, _ := newInternalHandler(t)
	request := httptest.NewRequest(http.MethodGet, "/api/system-settings/llm-gateways", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d", recorder.Code)
	}
}

// TestHandlerEmptyJSONBodyBecomesEmptyObject proves a zero-length JSON body is
// validated like {} (Express body-parser behaviour).
func TestHandlerEmptyJSONBodyBecomesEmptyObject(t *testing.T) {
	handler, _ := newInternalHandler(t)
	request := httptest.NewRequest(http.MethodPost, pathInternalOpenAiKeysApplied, strings.NewReader(""))
	request.Header.Set("Authorization", "Bearer "+internalToken)
	request.Header.Set("content-type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "source must be one of the following values") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

// TestHandlerInvalidJSONBody pins the syntax-error shape.
func TestHandlerInvalidJSONBody(t *testing.T) {
	handler, _ := newInternalHandler(t)
	request := httptest.NewRequest(http.MethodPost, pathInternalOpenAiKeysApplied, strings.NewReader("{"))
	request.Header.Set("Authorization", "Bearer "+internalToken)
	request.Header.Set("content-type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}
	var payload struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Message != "Unexpected token in JSON body" || payload.Error != "Bad Request" {
		t.Fatalf("payload = %+v", payload)
	}
}

// TestHandlerNotConfiguredInternalTokenIsForbidden proves a missing token does not
// break the route (403 contract).
func TestHandlerNotConfiguredInternalTokenIsForbidden(t *testing.T) {
	harness := newTestHarness(Config{})
	handler := NewHandler(newAuthenticatorWithIdentity(nil, harness.identity), harness.service)
	request := httptest.NewRequest(http.MethodGet, pathInternalOpenAiKeys, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "LITELLM_CONFIG_INTERNAL_TOKEN is not configured") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}
