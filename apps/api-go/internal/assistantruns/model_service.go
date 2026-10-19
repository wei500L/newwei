package assistantruns

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
)

// ModelServiceForecastRequest is the /v1/forecast/holdout_last body. Field
// names match ModelServiceForecastHoldoutLastRequest.
type ModelServiceForecastRequest struct {
	Series          []SeriesPoint         `json:"series"`
	ConfidenceLevel float64               `json:"confidence_level"`
	Model           ModelServiceModelSpec `json:"model"`
	RequestID       string                `json:"request_id,omitempty"`
}

// ModelServiceModelSpec is the model object of the forecast request.
type ModelServiceModelSpec struct {
	Kind           string `json:"kind"`
	SeasonalPeriod *int   `json:"seasonal_period,omitempty"`
}

// ModelServiceForecastResponse is the typed model-service answer. model and
// diagnostics are extension JSON leaves and are stored verbatim.
type ModelServiceForecastResponse struct {
	Model       json.RawMessage `json:"model"`
	Forecast    ForecastPoint   `json:"forecast"`
	Diagnostics json.RawMessage `json:"diagnostics"`
}

// ModelServiceClient calls the external forecast service. It resolves the same
// model_service settings row NestJS reads (base URL, internal token, timeout,
// retries).
type ModelServiceClient struct {
	access ModelAccessReader
	http   *http.Client
}

// NewModelServiceClient builds the production client.
func NewModelServiceClient(access ModelAccessReader) *ModelServiceClient {
	return &ModelServiceClient{access: access, http: &http.Client{}}
}

// ForecastHoldoutLast calls forecastHoldoutLastOrThrow. Retry count, status
// classification and jittered exponential delay mirror ModelServiceClient.
func (c *ModelServiceClient) ForecastHoldoutLast(ctx context.Context, request ModelServiceForecastRequest) (ModelServiceForecastResponse, error) {
	config, err := c.access.AssistantModelServiceConfig(ctx)
	if err != nil {
		return ModelServiceForecastResponse{}, err
	}
	if !config.Enabled {
		return ModelServiceForecastResponse{}, errors.New("Model service is disabled")
	}
	if config.BaseURL == "" {
		return ModelServiceForecastResponse{}, errors.New("Model service baseUrl is not configured")
	}
	if config.InternalToken == "" {
		return ModelServiceForecastResponse{}, errors.New("Model service internal token is not configured")
	}
	url := strings.TrimRight(config.BaseURL, "/") + "/v1/forecast/holdout_last"
	body, err := json.Marshal(request)
	if err != nil {
		return ModelServiceForecastResponse{}, err
	}
	retries := config.MaxRetries
	if retries < 0 {
		retries = 0
	}
	if retries > 5 {
		retries = 5
	}
	attempts := retries + 1
	var last error
	for attempt := 0; attempt < attempts; attempt++ {
		response, status, detail, err := c.post(ctx, url, body, config)
		if err == nil {
			return response, nil
		}
		if status == http.StatusUnauthorized {
			return ModelServiceForecastResponse{}, errors.New("Model service request unauthorized")
		}
		if status != 0 && status < 500 && status != http.StatusRequestTimeout && status != http.StatusTooManyRequests {
			return ModelServiceForecastResponse{}, modelServiceError(status, detail, err)
		}
		last = modelServiceError(status, detail, err)
		if attempt+1 >= attempts {
			break
		}
		delay := time.Duration(mathMinInt(5_000, 200*(1<<attempt))) * time.Millisecond
		delay += time.Duration(rand.Intn(150)) * time.Millisecond
		if sleepErr := sleep(ctx, delay); sleepErr != nil {
			return ModelServiceForecastResponse{}, sleepErr
		}
	}
	if last == nil {
		last = errors.New("Model service request failed")
	}
	return ModelServiceForecastResponse{}, last
}

func (c *ModelServiceClient) post(ctx context.Context, url string, body []byte, config modelaccesssettings.AssistantModelServiceConfig) (ModelServiceForecastResponse, int, string, error) {
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return ModelServiceForecastResponse{}, 0, "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-internal-token", config.InternalToken)
	response, err := c.http.Do(request)
	if err != nil {
		return ModelServiceForecastResponse{}, 0, "", err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return ModelServiceForecastResponse{}, response.StatusCode, "", err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ModelServiceForecastResponse{}, response.StatusCode, modelServiceDetail(raw), errors.New("Model service request failed")
	}
	var parsed ModelServiceForecastResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ModelServiceForecastResponse{}, response.StatusCode, "", err
	}
	return parsed, response.StatusCode, "", nil
}

func modelServiceDetail(raw []byte) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	var record struct {
		Detail string `json:"detail"`
	}
	if json.Unmarshal(raw, &record) == nil && strings.TrimSpace(record.Detail) != "" {
		return strings.TrimSpace(record.Detail)
	}
	return trimmed
}

func modelServiceError(status int, detail string, err error) error {
	prefix := "Model service request failed"
	if status != 0 {
		prefix = fmt.Sprintf("%s (status=%d)", prefix, status)
	}
	if detail != "" {
		return fmt.Errorf("%s: %s", prefix, detail)
	}
	if err != nil {
		return fmt.Errorf("%s: %s", prefix, err.Error())
	}
	return errors.New(prefix)
}

func mathMinInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
