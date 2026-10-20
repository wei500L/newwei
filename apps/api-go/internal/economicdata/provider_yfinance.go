package economicdata

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type yfinanceProvider struct{ service *Service }

type yfinanceChartQuote struct {
	Open   []*float64 `json:"open"`
	High   []*float64 `json:"high"`
	Low    []*float64 `json:"low"`
	Close  []*float64 `json:"close"`
	Volume []*float64 `json:"volume"`
}

type yfinanceChartMeta struct {
	Currency           string   `json:"currency"`
	ExchangeName       string   `json:"exchangeName"`
	FullExchangeName   string   `json:"fullExchangeName"`
	InstrumentType     string   `json:"instrumentType"`
	RegularMarketPrice *float64 `json:"regularMarketPrice"`
	Symbol             string   `json:"symbol"`
}

type yfinanceChartResult struct {
	Indicators struct {
		Quote []yfinanceChartQuote `json:"quote"`
	} `json:"indicators"`
	Meta      yfinanceChartMeta `json:"meta"`
	Timestamp []int64           `json:"timestamp"`
}

type yfinanceChartError struct {
	Code        string `json:"code"`
	Description string `json:"description"`
}

type yfinanceChartResponse struct {
	Chart struct {
		Error  *yfinanceChartError   `json:"error"`
		Result []yfinanceChartResult `json:"result"`
	} `json:"chart"`
}

type yfinanceRequest struct {
	Symbol         string          `json:"symbol"`
	Interval       string          `json:"interval"`
	Period1        int64           `json:"period1"`
	Period2        json.RawMessage `json:"period2"`
	IncludePrePost bool            `json:"includePrePost"`
	Events         string          `json:"events"`
}

type yfinanceMeta struct {
	Currency           *string  `json:"currency"`
	DisplaySymbol      string   `json:"displaySymbol"`
	ExchangeName       *string  `json:"exchangeName"`
	InstrumentType     *string  `json:"instrumentType"`
	ProviderSymbol     string   `json:"providerSymbol"`
	RegularMarketPrice *float64 `json:"regularMarketPrice"`
}

func (p *yfinanceProvider) Kind() ProviderKind { return ProviderYfinance }

func (p *yfinanceProvider) Configured(context.Context) bool { return true }

func (p *yfinanceProvider) Fetch(ctx context.Context, item ItemConfig) (ProviderFetchResult, error) {
	config := item.ProviderConfig
	if config.Kind != ProviderYfinance {
		return ProviderFetchResult{}, fmt.Errorf("Expected yfinance provider config for %s", item.Slug)
	}
	requestParams := buildYfinanceRequest(config)
	payload, err := p.fetchChart(ctx, config)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	if payload.Chart.Error != nil {
		return ProviderFetchResult{}, fmt.Errorf("yfinance_chart_error:%s:%s", emptyFallback(payload.Chart.Error.Code, "unknown"), emptyFallback(payload.Chart.Error.Description, "unknown"))
	}
	if len(payload.Chart.Result) == 0 {
		return ProviderFetchResult{}, fmt.Errorf("yfinance_history_empty:%s", config.Symbol)
	}
	result := payload.Chart.Result[0]
	if len(result.Indicators.Quote) == 0 || len(result.Timestamp) == 0 {
		return ProviderFetchResult{}, fmt.Errorf("yfinance_history_empty:%s", config.Symbol)
	}
	quote := result.Indicators.Quote[0]
	sourceFields := config.SourceFields
	if sourceFields == nil {
		sourceFields = &YahooSourceFields{}
	}
	openField := sourceFields.Open
	if openField == "" {
		openField = "open"
	}
	highField := sourceFields.High
	if highField == "" {
		highField = "high"
	}
	lowField := sourceFields.Low
	if lowField == "" {
		lowField = "low"
	}
	closeField := sourceFields.Close
	if closeField == "" {
		closeField = "close"
	}
	displaySymbol := config.Symbol
	if item.Snapshot != nil && item.Snapshot.Symbol != "" {
		displaySymbol = item.Snapshot.Symbol
	}
	providerSymbol := config.Symbol
	if result.Meta.Symbol != "" {
		providerSymbol = result.Meta.Symbol
	}
	exchange := result.Meta.FullExchangeName
	if exchange == "" {
		exchange = result.Meta.ExchangeName
	}
	meta := yfinanceMeta{
		Currency:           nullableString(result.Meta.Currency),
		DisplaySymbol:      displaySymbol,
		ExchangeName:       nullableString(exchange),
		InstrumentType:     nullableString(result.Meta.InstrumentType),
		ProviderSymbol:     providerSymbol,
		RegularMarketPrice: result.Meta.RegularMarketPrice,
	}
	metaRaw, _ := json.Marshal(meta)
	dataType := item.ValueType
	if dataType == "" {
		dataType = ValueTypePrice
	}
	unit := optionalUnit(item.unitOr(""))
	incomplete := make([]time.Time, 0)
	points := make([]ParsedDataPoint, 0)
	for index, timestamp := range result.Timestamp {
		recordedAt := time.Unix(timestamp, 0).UTC()
		open := arrayValue(quote.Open, index)
		high := arrayValue(quote.High, index)
		low := arrayValue(quote.Low, index)
		close := arrayValue(quote.Close, index)
		if open == nil || high == nil || low == nil || close == nil {
			incomplete = append(incomplete, recordedAt)
			continue
		}
		entries := []struct {
			field string
			value *float64
		}{
			{openField, open}, {highField, high}, {lowField, low}, {closeField, close},
		}
		if sourceFields.Volume != "" {
			entries = append(entries, struct {
				field string
				value *float64
			}{sourceFields.Volume, arrayValue(quote.Volume, index)})
		}
		for _, entry := range entries {
			if entry.field == "" || entry.value == nil {
				continue
			}
			points = append(points, ParsedDataPoint{
				RecordedAt:  recordedAt,
				Value:       *entry.value,
				Unit:        unit,
				DataType:    dataType,
				SourceField: entry.field,
				Meta:        metaRaw,
			})
		}
	}
	if len(points) == 0 {
		return ProviderFetchResult{}, fmt.Errorf("yfinance_history_points_empty:%s", config.Symbol)
	}
	cleanup := uniqueSortedTimes(incomplete)
	payloadRaw, _ := json.Marshal(payload)
	requestRaw, _ := json.Marshal(requestParams)
	return ProviderFetchResult{
		Payload:          payloadRaw,
		Points:           points,
		Cleanup:          cleanup,
		RequestParams:    requestRaw,
		Method:           "GET",
		ProviderIdentity: config.Symbol,
	}, nil
}

func buildYfinanceRequest(config ProviderConfig) yfinanceRequest {
	period2 := time.Now().Unix()
	if config.Period2 != nil {
		if config.Period2.Now {
			period2 = time.Now().Unix()
		} else if config.Period2.Seconds != nil {
			period2 = *config.Period2.Seconds
		}
	}
	period1 := int64(0)
	if config.Period1 != nil {
		period1 = *config.Period1
	}
	includePrePost := false
	if config.IncludePrePost != nil {
		includePrePost = *config.IncludePrePost
	}
	events := config.Events
	if events == "" {
		events = "div,splits"
	}
	return yfinanceRequest{
		Symbol:         config.Symbol,
		Interval:       config.Interval,
		Period1:        period1,
		Period2:        json.RawMessage(strconv.FormatInt(period2, 10)),
		IncludePrePost: includePrePost,
		Events:         events,
	}
}

func (p *yfinanceProvider) fetchChart(ctx context.Context, config ProviderConfig) (yfinanceChartResponse, error) {
	requestParams := buildYfinanceRequest(config)
	base := "https://query1.finance.yahoo.com"
	chartURL, err := url.Parse(base + config.Endpoint + "/" + url.PathEscape(config.Symbol))
	if err != nil {
		return yfinanceChartResponse{}, err
	}
	query := chartURL.Query()
	query.Set("interval", requestParams.Interval)
	query.Set("period1", strconv.FormatInt(requestParams.Period1, 10))
	query.Set("period2", string(requestParams.Period2))
	query.Set("includePrePost", strconv.FormatBool(requestParams.IncludePrePost))
	query.Set("events", requestParams.Events)
	chartURL.RawQuery = query.Encode()
	client := &http.Client{
		Transport: p.service.http.Transport,
		Timeout:   12 * time.Second,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		response, err := fetchYfinanceJSON(ctx, client, chartURL.String())
		if err == nil {
			return response, nil
		}
		lastErr = err
		if attempt == 3 || !isYfinanceRetryable(err) {
			break
		}
		select {
		case <-ctx.Done():
			return yfinanceChartResponse{}, ctx.Err()
		case <-time.After(time.Duration(minInt(500*attempt, 1500)) * time.Millisecond):
		}
	}
	return yfinanceChartResponse{}, lastErr
}

func fetchYfinanceJSON(ctx context.Context, client *http.Client, requestURL string) (yfinanceChartResponse, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, requestURL, nil)
	if err != nil {
		return yfinanceChartResponse{}, err
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("accept-language", "en-US,en;q=0.9")
	request.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
	response, err := client.Do(request)
	if err != nil {
		return yfinanceChartResponse{}, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return yfinanceChartResponse{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 160 {
			snippet = snippet[:160]
		}
		return yfinanceChartResponse{}, fmt.Errorf("HTTP %d %s: %s", response.StatusCode, http.StatusText(response.StatusCode), snippet)
	}
	var decoded yfinanceChartResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return yfinanceChartResponse{}, fmt.Errorf("yfinance_invalid_json:%v", err)
	}
	return decoded, nil
}

func isYfinanceRetryable(err error) bool {
	message := strings.ToLower(err.Error())
	for _, token := range []string{"http 429", "http 502", "http 503", "http 504", "timed out", "timeout", "fetch failed", "aborted"} {
		if strings.Contains(message, token) {
			return true
		}
	}
	return false
}

func arrayValue(values []*float64, index int) *float64 {
	if index < 0 || index >= len(values) {
		return nil
	}
	value := values[index]
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	return value
}

func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func emptyFallback(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func uniqueSortedTimes(values []time.Time) []time.Time {
	seen := map[int64]bool{}
	out := make([]time.Time, 0, len(values))
	for _, value := range values {
		if value.IsZero() || seen[value.UnixMilli()] {
			continue
		}
		seen[value.UnixMilli()] = true
		out = append(out, value)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Before(out[j-1]); j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}
