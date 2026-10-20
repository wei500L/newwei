package newsnowhottest

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseBooleanFlag(t *testing.T) {
	truthy := []string{"true", "TRUE", "1", "yes", "y", "on", " on "}
	for _, value := range truthy {
		got, err := parseBooleanFlag(value)
		if err != nil || !got {
			t.Fatalf("parseBooleanFlag(%q) = %v %v", value, got, err)
		}
	}
	falsy := []string{"", "false", "FALSE", "0", "no", "n", "off", " off "}
	for _, value := range falsy {
		got, err := parseBooleanFlag(value)
		if err != nil || got {
			t.Fatalf("parseBooleanFlag(%q) = %v %v", value, got, err)
		}
	}
	if _, err := parseBooleanFlag("maybe"); err == nil ||
		err.Error() != "latest must be one of true/false, 1/0, yes/no, y/n, on/off" {
		t.Fatalf("invalid flag error = %v", err)
	}
}

func TestParseOptionalPositiveInt(t *testing.T) {
	value, err := parseOptionalPositiveInt("", "limit", 1, 100)
	if err != nil || value != nil {
		t.Fatalf("empty limit = %v %v", value, err)
	}
	value, err = parseOptionalPositiveInt(" 12abc", "limit", 1, 100)
	if err != nil || value == nil || *value != 12 {
		t.Fatalf("parseInt prefix = %v %v", value, err)
	}
	value, err = parseOptionalPositiveInt("3.9", "limit", 1, 100)
	if err != nil || value == nil || *value != 3 {
		t.Fatalf("parseInt truncation = %v %v", value, err)
	}
	value, err = parseOptionalPositiveInt("+5", "limit", 1, 100)
	if err != nil || value == nil || *value != 5 {
		t.Fatalf("parseInt sign = %v %v", value, err)
	}
	for _, invalid := range []string{"0", "101", "-1", "abc"} {
		if _, err := parseOptionalPositiveInt(invalid, "limit", 1, 100); err == nil {
			t.Fatalf("%q must be rejected", invalid)
		}
	}
	// Number.parseInt("1e3", 10) stops at the exponent marker and returns 1.
	if value, err := parseOptionalPositiveInt("1e3", "limit", 1, 100); err != nil || value == nil || *value != 1 {
		t.Fatalf("parseInt exponent = %v %v", value, err)
	}
	if _, err := parseOptionalPositiveInt("abc", "limit", 1, 100); err == nil ||
		err.Error() != "limit must be an integer between 1 and 100" {
		t.Fatalf("invalid limit error = %v", err)
	}
}

func TestHandlerValidatesBeforeAuthenticating(t *testing.T) {
	handler := NewHandler(nil, nil, &Service{})

	request := httptest.NewRequest(http.MethodGet, HottestAnalysisPath+"?latest=maybe", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid latest status = %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, RecommendedPath+"?limit=101", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid limit status = %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, RecommendedPath+"?limit=1&limit=2", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("repeated limit status = %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, HottestAnalysisPath, nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing bearer status = %d", recorder.Code)
	}
}
