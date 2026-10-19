package providers

import (
	"context"
	"encoding/json"
)

// Model kinds accepted by the forecast endpoint.
const (
	ModelKindARIMA = "arima"
	ModelKindETS   = "ets"
)

// SeriesPoint is one timestamped sample of a forecast request: the same shape as
// ModelServiceSeriesPoint.
type SeriesPoint struct {
	Timestamp string  `json:"timestamp"`
	Value     float64 `json:"value"`
}

// ForecastModel is the model selection of a forecast request.
type ForecastModel struct {
	Kind            string
	SeasonalPeriod  int
	ConfidenceLevel float64
}

// ForecastRequest is the subset of the forecast endpoint input the economic
// anomaly provider uses.
type ForecastRequest struct {
	Series    []SeriesPoint
	Model     ForecastModel
	RequestID string
}

// ForecastValue is the holdout forecast of the last point.
type ForecastValue struct {
	Expected float64
	Lower    float64
	Upper    float64
	Sigma    float64
}

// ForecastResult is the endpoint response the provider reads. Model and
// Diagnostics stay as raw JSON because they are copied into the event context
// verbatim.
type ForecastResult struct {
	Forecast    *ForecastValue
	Model       json.RawMessage
	Diagnostics json.RawMessage
}

// ForecastClient is the model service port. ForecastHoldoutLastBestEffort must
// never fail the evaluation: a disabled service, a missing token, a timeout or
// a non-retryable error all return (nil, nil), exactly like
// ModelServiceClient.forecastHoldoutLastBestEffort returning null.
type ForecastClient interface {
	ForecastHoldoutLastBestEffort(ctx context.Context, request ForecastRequest) (*ForecastResult, error)
}
