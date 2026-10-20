package economicdata

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"time"
)

type finnhubProvider struct{ service *Service }

type finnhubQuote struct {
	Current       *float64 `json:"c"`
	Change        *float64 `json:"d"`
	ChangePercent *float64 `json:"dp"`
	High          *float64 `json:"h"`
	Low           *float64 `json:"l"`
	Open          *float64 `json:"o"`
	PreviousClose *float64 `json:"pc"`
	Timestamp     *float64 `json:"t"`
}

type finnhubMeta struct {
	DisplaySymbol  string   `json:"displaySymbol"`
	ProviderSymbol string   `json:"providerSymbol"`
	Change         *float64 `json:"change"`
	ChangePercent  *float64 `json:"changePercent"`
	Open           *float64 `json:"open"`
	High           *float64 `json:"high"`
	Low            *float64 `json:"low"`
	PreviousClose  *float64 `json:"previousClose"`
}

type finnhubRequest struct {
	Symbol string `json:"symbol"`
}

func (p *finnhubProvider) Kind() ProviderKind { return ProviderFinnhub }

func (p *finnhubProvider) Configured(ctx context.Context) bool {
	key, err := p.service.keys.resolve(ctx, "finnhubApiKey")
	return err == nil && key != ""
}

func (p *finnhubProvider) Fetch(ctx context.Context, item ItemConfig) (ProviderFetchResult, error) {
	config := item.ProviderConfig
	if config.Kind != ProviderFinnhub {
		return ProviderFetchResult{}, fmt.Errorf("Expected finnhub provider config for %s", item.Slug)
	}
	apiKey, err := p.service.keys.resolve(ctx, "finnhubApiKey")
	if err != nil {
		return ProviderFetchResult{}, err
	}
	if apiKey == "" {
		return ProviderFetchResult{}, &ProviderConfigurationError{Code: "missing_api_key", Message: "missing_api_key:finnhubApiKey"}
	}
	endpoint := "https://finnhub.io/api/v1" + config.Endpoint
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	query := parsed.Query()
	query.Set("symbol", config.Symbol)
	query.Set("token", apiKey)
	parsed.RawQuery = query.Encode()
	result, err := fetchJSON(ctx, p.service.http, parsed.String(), nil, 10*time.Second)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	quote, err := decodeJSON[finnhubQuote](result.Body)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	if quote.Current == nil {
		return ProviderFetchResult{}, fmt.Errorf("finnhub_quote_missing_price:%s", config.Symbol)
	}
	timestamp := time.Now().Unix()
	if quote.Timestamp != nil && *quote.Timestamp > 0 {
		timestamp = int64(*quote.Timestamp)
	}
	unit := item.unitOr("USD")
	dataType := item.ValueType
	if dataType == "" {
		dataType = ValueTypePrice
	}
	sourceField := config.SourceField
	if sourceField == "" {
		sourceField = "price"
	}
	displaySymbol := config.Symbol
	if item.Snapshot != nil && item.Snapshot.Symbol != "" {
		displaySymbol = item.Snapshot.Symbol
	}
	meta := finnhubMeta{
		DisplaySymbol:  displaySymbol,
		ProviderSymbol: config.Symbol,
		Change:         quote.Change,
		ChangePercent:  quote.ChangePercent,
		Open:           quote.Open,
		High:           quote.High,
		Low:            quote.Low,
		PreviousClose:  quote.PreviousClose,
	}
	metaRaw, _ := json.Marshal(meta)
	requestParams, _ := json.Marshal(finnhubRequest{Symbol: config.Symbol})
	return ProviderFetchResult{
		Payload:          json.RawMessage(result.Body),
		Points:           []ParsedDataPoint{{RecordedAt: time.Unix(timestamp, 0).UTC(), Value: *quote.Current, Unit: optionalUnit(unit), DataType: dataType, SourceField: sourceField, Meta: metaRaw}},
		RequestParams:    requestParams,
		Method:           "GET",
		ProviderIdentity: config.Symbol,
	}, nil
}
