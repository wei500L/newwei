package assistantruns

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
)

func TestModelServiceClientRequestRetryAndResponse(t *testing.T) {
	calls := 0
	var received ModelServiceForecastRequest
	token := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/forecast/holdout_last" {
			t.Errorf("path = %s", r.URL.Path)
		}
		token = r.Header.Get("x-internal-token")
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &received); err != nil {
			t.Errorf("body: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"model":{"kind":"ets","seasonal_period":7},"forecast":{"timestamp":"2026-10-20T00:00:00.000Z","expected":9,"lower":8,"upper":10,"sigma":0.5},"diagnostics":{"aic":1.2}}`))
	}))
	defer server.Close()

	client := NewModelServiceClient(fakeModelAccess{config: modelaccesssettings.AssistantModelServiceConfig{
		Enabled:       true,
		BaseURL:       server.URL,
		InternalToken: "internal-token",
		Timeout:       time.Second,
		MaxRetries:    1,
	}})
	seasonal := 7
	response, err := client.ForecastHoldoutLast(context.Background(), ModelServiceForecastRequest{
		Series:          []SeriesPoint{{Timestamp: "2026-10-19T00:00:00.000Z", Value: 8}},
		ConfidenceLevel: 0.9,
		Model:           ModelServiceModelSpec{Kind: "ets", SeasonalPeriod: &seasonal},
		RequestID:       "run-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
	if token != "internal-token" {
		t.Fatalf("token header = %q", token)
	}
	if received.ConfidenceLevel != 0.9 || received.Model.Kind != "ets" || received.Model.SeasonalPeriod == nil || *received.Model.SeasonalPeriod != 7 {
		t.Fatalf("request = %+v", received)
	}
	if received.RequestID != "run-1" || len(received.Series) != 1 {
		t.Fatalf("request = %+v", received)
	}
	if response.Forecast.Expected != 9 || response.Forecast.Sigma != 0.5 {
		t.Fatalf("forecast = %+v", response.Forecast)
	}
	if string(response.Model) == "" || string(response.Diagnostics) == "" {
		t.Fatalf("model/diagnostics = %s %s", response.Model, response.Diagnostics)
	}
}

func TestModelServiceClientRejectsDisabledConfig(t *testing.T) {
	client := NewModelServiceClient(fakeModelAccess{config: modelaccesssettings.AssistantModelServiceConfig{Enabled: false}})
	if _, err := client.ForecastHoldoutLast(context.Background(), ModelServiceForecastRequest{}); err == nil || err.Error() != "Model service is disabled" {
		t.Fatalf("error = %v", err)
	}
}
