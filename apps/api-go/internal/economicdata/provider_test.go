package economicdata

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func fakeResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:     http.Header{"content-type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func testService(responseBody string, keys map[string]string) *Service {
	return &Service{
		env: Env{AkshareEnabled: true, AkshareBaseURL: "http://akshare.test", AkshareTimeout: time.Second, AkshareMaxRetries: 1},
		http: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return fakeResponse(http.StatusOK, responseBody), nil
		})},
		keys: &keyResolver{overrides: keys},
	}
}

func TestAkshareProviderMapsLatestPoint(t *testing.T) {
	service := testService(`[{"time":"2026-10-19 10:00:00","current_price":"123.45"}]`, nil)
	item := ItemConfig{
		Slug:             "gold_futures_realtime",
		Endpoint:         "/futures_zh_spot",
		ValueType:        ValueTypePrice,
		DefaultFrequency: FrequencyRealtime,
		ProviderKind:     ProviderAkshare,
		ProviderConfig: ProviderConfig{
			Kind:          ProviderAkshare,
			FunctionName:  "ak.futures_zh_spot",
			Endpoint:      "/futures_zh_spot",
			Method:        "GET",
			DefaultParams: map[string]string{"symbol": "AU0"},
			Parser:        &ParserConfig{Type: ParserLatest, TimestampField: "time", ValueFields: []DataField{field("current_price", "最新价", "CNY", ValueTypePrice)}},
		},
	}
	result, err := (&akshareProvider{service: service}).Fetch(context.Background(), item)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Points) != 1 || result.Points[0].Value != 123.45 || result.Points[0].SourceField != "current_price" {
		t.Fatalf("points = %+v", result.Points)
	}
}

func TestAkshareDisabledIsConfigurationError(t *testing.T) {
	service := testService(`[]`, nil)
	service.env.AkshareEnabled = false
	_, err := (&akshareProvider{service: service}).Fetch(context.Background(), ItemConfig{Slug: "x", ProviderKind: ProviderAkshare, ProviderConfig: ProviderConfig{Kind: ProviderAkshare}})
	if _, ok := err.(*ProviderConfigurationError); !ok {
		t.Fatalf("error = %T %v", err, err)
	}
}

func TestFinnhubQuoteMappingAndMissingKey(t *testing.T) {
	service := testService(`{"c":250.5,"d":1.2,"dp":0.4,"h":251,"l":248,"o":249,"pc":249.3,"t":1700000000}`, map[string]string{"finnhubApiKey": "token"})
	item := ItemConfig{
		Slug:         "spy_proxy",
		ValueType:    ValueTypePrice,
		ProviderKind: ProviderFinnhub,
		ProviderConfig: ProviderConfig{
			Kind:        ProviderFinnhub,
			Symbol:      "SPY",
			Endpoint:    "/quote",
			SourceField: "price",
		},
	}
	result, err := (&finnhubProvider{service: service}).Fetch(context.Background(), item)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Points) != 1 || result.Points[0].Value != 250.5 || result.Points[0].SourceField != "price" {
		t.Fatalf("points = %+v", result.Points)
	}
	service.keys.overrides = nil
	_, err = (&finnhubProvider{service: service}).Fetch(context.Background(), item)
	configuration, ok := err.(*ProviderConfigurationError)
	if !ok || configuration.Message != "missing_api_key:finnhubApiKey" {
		t.Fatalf("missing key error = %v", err)
	}
}

func TestFredLatestMappingAndMissingKey(t *testing.T) {
	service := testService(`{"observations":[{"date":"2026-10-01","value":"4.25"},{"date":"2026-09-01","value":"4.00"}]}`, map[string]string{"fredApiKey": "token"})
	unit := "%"
	item := ItemConfig{
		Slug:         "us_fed_funds_rate",
		ValueType:    ValueTypePercent,
		DefaultUnit:  &unit,
		ProviderKind: ProviderFred,
		ProviderConfig: ProviderConfig{
			Kind:        ProviderFred,
			SeriesID:    "FEDFUNDS",
			Endpoint:    "/series/observations",
			Metric:      "latest",
			SourceField: "value",
		},
	}
	result, err := (&fredProvider{service: service}).Fetch(context.Background(), item)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Points) != 1 || result.Points[0].Value != 4.25 {
		t.Fatalf("points = %+v", result.Points)
	}
	service.keys.overrides = nil
	_, err = (&fredProvider{service: service}).Fetch(context.Background(), item)
	configuration, ok := err.(*ProviderConfigurationError)
	if !ok || configuration.Message != "missing_api_key:fredApiKey" {
		t.Fatalf("missing key error = %v", err)
	}
}

func TestYfinanceChartMappingAndCleanup(t *testing.T) {
	body := `{"chart":{"error":null,"result":[{"meta":{"currency":"USD","fullExchangeName":"SNP","instrumentType":"INDEX","regularMarketPrice":5000,"symbol":"^GSPC"},"timestamp":[1700000000,1700086400],"indicators":{"quote":[{"open":[1,2],"high":[2,3],"low":[0.5,1],"close":[1.5,null]}]}}]}}`
	service := testService(body, nil)
	item := ItemConfig{
		Slug:             "sp500_index",
		ValueType:        ValueTypeIndex,
		ProviderKind:     ProviderYfinance,
		DefaultFrequency: FrequencyDaily,
		ProviderConfig: ProviderConfig{
			Kind:     ProviderYfinance,
			Symbol:   "^GSPC",
			Endpoint: "/v8/finance/chart",
			Interval: "1d",
			Period1:  int64Ptr(0),
			Period2:  &Period2{Now: true},
		},
	}
	result, err := (&yfinanceProvider{service: service}).Fetch(context.Background(), item)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Points) != 4 || len(result.Cleanup) != 1 {
		t.Fatalf("points=%d cleanup=%d", len(result.Points), len(result.Cleanup))
	}
	if result.Points[0].SourceField != "open" || result.Points[0].Value != 1 {
		t.Fatalf("first point = %+v", result.Points[0])
	}
}

func TestParserRejectsMissingConfiguredField(t *testing.T) {
	_, err := parsePayload(ParserConfig{Type: ParserTimeseries, TimestampField: "日期", ValueFields: []DataField{field("收盘价", "收盘价", "", ValueTypePrice)}}, []any{map[string]any{"日期": "2026-01-01"}}, "fixture")
	if err == nil || !strings.Contains(err.Error(), "Missing configured field") {
		t.Fatalf("missing field error = %v", err)
	}
}

func int64Ptr(value int64) *int64 { return &value }
