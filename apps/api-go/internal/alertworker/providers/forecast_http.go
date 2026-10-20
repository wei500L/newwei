package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// ForecastHTTPConfig is the effective model-service configuration the alert
// worker uses. It mirrors the fields of ModelServiceSettingsService's effective
// config that forecastHoldoutLastBestEffort reads.
type ForecastHTTPConfig struct {
	Enabled       bool
	BaseURL       string
	InternalToken string
	TimeoutMs     int
	MaxRetries    int
}

// forecastHTTPRequest is the `/v1/forecast/holdout_last` body. Field names and
// omission rules match ModelServiceForecastHoldoutLastRequest.
type forecastHTTPRequest struct {
	Series          []SeriesPoint     `json:"series"`
	ConfidenceLevel float64           `json:"confidence_level"`
	Model           forecastHTTPModel `json:"model"`
	RequestID       string            `json:"request_id,omitempty"`
}

// forecastHTTPModel is the `model` object. ForecastRequest.Model.SeasonalPeriod
// is an int, so it is already truncated; Math.max(0, ...) is applied here. The
// NestJS client only omits the key when the value is not a finite number, which
// cannot happen with an int field, so the key is always sent.
type forecastHTTPModel struct {
	Kind           string `json:"kind"`
	SeasonalPeriod int    `json:"seasonal_period"`
}

// forecastHTTPForecast is the response `forecast` object.
type forecastHTTPForecast struct {
	Timestamp string  `json:"timestamp"`
	Expected  float64 `json:"expected"`
	Lower     float64 `json:"lower"`
	Upper     float64 `json:"upper"`
	Sigma     float64 `json:"sigma"`
}

// forecastHTTPResponse is the response the provider reads. model and diagnostics
// stay raw because they are copied into the event context verbatim.
type forecastHTTPResponse struct {
	Model       json.RawMessage       `json:"model"`
	Forecast    *forecastHTTPForecast `json:"forecast"`
	Diagnostics json.RawMessage       `json:"diagnostics"`
}

type forecastHTTPClient struct {
	config ForecastHTTPConfig
	client *http.Client
}

// NewForecastHTTPClient builds the HTTP ForecastClient. A nil client is
// replaced by an http.Client; when TimeoutMs is positive every attempt is also
// bounded by a context deadline, so a caller-supplied client keeps its own
// transport settings and still honours the configured timeout.
func NewForecastHTTPClient(config ForecastHTTPConfig, client *http.Client) ForecastClient {
	if client == nil {
		client = &http.Client{}
		if config.TimeoutMs > 0 {
			client.Timeout = time.Duration(config.TimeoutMs) * time.Millisecond
		}
	}
	return &forecastHTTPClient{config: config, client: client}
}

// ForecastHoldoutLastBestEffort mirrors the NestJS best-effort call: disabled,
// incomplete configuration, an exhausted retry budget or any transport/HTTP
// failure all return (nil, nil). No error is ever reported, because the alert
// evaluation falls back to the local detector.
func (c *forecastHTTPClient) ForecastHoldoutLastBestEffort(ctx context.Context, request ForecastRequest) (*ForecastResult, error) {
	if c == nil || !c.config.Enabled {
		return nil, nil
	}
	baseURL := strings.TrimRight(strings.TrimSpace(c.config.BaseURL), "/")
	if baseURL == "" || strings.TrimSpace(c.config.InternalToken) == "" {
		return nil, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	seasonalPeriod := request.Model.SeasonalPeriod
	if seasonalPeriod < 0 {
		seasonalPeriod = 0
	}
	body, err := json.Marshal(forecastHTTPRequest{
		Series:          request.Series,
		ConfidenceLevel: request.Model.ConfidenceLevel,
		Model: forecastHTTPModel{
			Kind:           request.Model.Kind,
			SeasonalPeriod: seasonalPeriod,
		},
		RequestID: request.RequestID,
	})
	if err != nil {
		return nil, nil
	}

	url := baseURL + "/v1/forecast/holdout_last"
	attempts := clampRetryCount(c.config.MaxRetries) + 1
	for attempt := 0; attempt < attempts; attempt++ {
		result, retryable := c.post(ctx, url, body)
		if result != nil || !retryable {
			return result, nil
		}
		if attempt == attempts-1 {
			return nil, nil
		}
		timer := time.NewTimer(forecastRetryDelay(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, nil
		case <-timer.C:
		}
	}
	return nil, nil
}

// post runs one attempt. A nil result with retryable=false stops the retry
// loop; retryable=true follows the NestJS classifyError decision.
func (c *forecastHTTPClient) post(ctx context.Context, url string, body []byte) (*ForecastResult, bool) {
	attemptCtx := ctx
	if c.config.TimeoutMs > 0 {
		var cancel context.CancelFunc
		attemptCtx, cancel = context.WithTimeout(ctx, time.Duration(c.config.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	httpRequest, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, false
	}
	httpRequest.Header.Set("content-type", "application/json")
	httpRequest.Header.Set("x-internal-token", c.config.InternalToken)

	response, err := c.client.Do(httpRequest)
	if err != nil {
		// Connect failures, timeouts and connection resets carry no HTTP
		// status and are retryable, like the NestJS classifyError fallback.
		return nil, true
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusUnauthorized {
		// 401 is "unauthorized" in NestJS: never retried.
		return nil, false
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, forecastStatusRetryable(response.StatusCode)
	}

	var decoded forecastHTTPResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		// A 2xx body that is not the expected JSON is a transport-level
		// failure for axios too (no status attached), i.e. retryable.
		return nil, true
	}
	if decoded.Forecast == nil {
		return nil, false
	}
	return &ForecastResult{
		Forecast: &ForecastValue{
			Expected: decoded.Forecast.Expected,
			Lower:    decoded.Forecast.Lower,
			Upper:    decoded.Forecast.Upper,
			Sigma:    decoded.Forecast.Sigma,
		},
		Model:       decoded.Model,
		Diagnostics: decoded.Diagnostics,
	}, false
}

// forecastStatusRetryable mirrors the status branch of classifyError: 408 and
// 429 retry, every other 4xx and any unexpected status does not, and 5xx retry.
func forecastStatusRetryable(status int) bool {
	if status == http.StatusRequestTimeout || status == http.StatusTooManyRequests {
		return true
	}
	return status >= 500 && status <= 599
}

// clampRetryCount mirrors Math.min(Math.max(Math.trunc(maxRetries), 0), 5).
func clampRetryCount(maxRetries int) int {
	if maxRetries < 0 {
		return 0
	}
	if maxRetries > 5 {
		return 5
	}
	return maxRetries
}

// forecastRetryDelay is computeRetryDelayMs without its 0..149ms random jitter:
// min(5000, 200 * 2^attempt) milliseconds. The jitter only spreads concurrent
// clients, so it is left out to keep retry timing deterministic in tests; the
// base and the cap are the same.
func forecastRetryDelay(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	delay := 200 * time.Millisecond
	for index := 0; index < attempt; index++ {
		if delay >= 5*time.Second {
			break
		}
		delay *= 2
	}
	if delay > 5*time.Second {
		delay = 5 * time.Second
	}
	return delay
}
