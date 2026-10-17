package adminlogs

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestRedactSensitiveFieldsDelegatesSharedPatterns(t *testing.T) {
	cases := map[string]string{
		"Bearer secret.jwt.token": "Bearer [REDACTED]",
		"token=abcdef":            "token=[REDACTED]",
		"api_key=plain-key":       "api_key=[REDACTED]",
		"no secrets here":         "no secrets here",
	}
	for input, want := range cases {
		if got := RedactSensitiveFields(input); got != want {
			t.Fatalf("RedactSensitiveFields(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestQualityTaskLogOverviewJSONShape(t *testing.T) {
	payload := QualityTaskLogOverview{
		SinceMinutes: 60,
		Items:        []TaskLogItemJSON{},
		Summary: taskLogSummary{
			Totals:    taskLogTotals{},
			ByStage:   []stageCount{},
			TopErrors: []taskTopError{},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"sinceMinutes":60,"items":[],"summary":{"totals":{"total":0,"pending":0,"processing":0,"completed":0,"failed":0},"byStage":[],"topErrors":[]}}`
	if string(encoded) != want {
		t.Fatalf("overview JSON = %s, want %s", encoded, want)
	}
}

func TestHTTPStatusReportsMachineTokenError(t *testing.T) {
	status, message, ok := HTTPStatus(newStatus(401, "Invalid machine token"))
	if !ok || status != 401 || message != "Invalid machine token" {
		t.Fatalf("HTTPStatus = %d %q %v", status, message, ok)
	}
	if _, _, ok := HTTPStatus(errors.New("boom")); ok {
		t.Fatal("untyped error should not report an HTTP status")
	}
}
