package economicdata

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

const (
	economicProviderResponseCollection = "economicproviderresponses"
	akshareResponseCollection          = "akshareresponses"
)

type storedProviderRequest struct {
	DataItemID       string    `bson:"dataItemId"`
	ProviderKind     string    `bson:"providerKind"`
	ProviderIdentity string    `bson:"providerIdentity"`
	Endpoint         string    `bson:"endpoint"`
	Method           string    `bson:"method"`
	RequestParams    any       `bson:"requestParams"`
	Payload          any       `bson:"payload"`
	Status           string    `bson:"status"`
	FetchedAt        time.Time `bson:"fetchedAt"`
	CreatedAt        time.Time `bson:"createdAt"`
	UpdatedAt        time.Time `bson:"updatedAt"`
}

type storedAkshareRequest struct {
	DataItemID    string    `bson:"dataItemId"`
	Endpoint      string    `bson:"endpoint"`
	Method        string    `bson:"method"`
	RequestParams any       `bson:"requestParams"`
	Payload       any       `bson:"payload"`
	FetchedAt     time.Time `bson:"fetchedAt"`
	CreatedAt     time.Time `bson:"createdAt"`
	UpdatedAt     time.Time `bson:"updatedAt"`
}

// archiveProviderResponse mirrors archiveProviderResponse: archive first, then
// (for AkShare only) the legacy AkshareResponse collection. An insert failure is
// returned so the fetch does not report success without its archive.
func (s *Service) archiveProviderResponse(ctx context.Context, item ItemConfig, result ProviderFetchResult) error {
	if s == nil || s.mongo == nil {
		return fmt.Errorf("economicdata: mongo is not configured")
	}
	now := time.Now().UTC()
	requestParams := decodeJSONValue(result.RequestParams)
	payload := decodeJSONValue(result.Payload)
	method := result.Method
	if method == "" {
		method = "GET"
	}
	document := storedProviderRequest{
		DataItemID:       item.Slug,
		ProviderKind:     string(item.ProviderKind),
		ProviderIdentity: providerIdentity(item),
		Endpoint:         item.Endpoint,
		Method:           method,
		RequestParams:    requestParams,
		Payload:          payload,
		Status:           "success",
		FetchedAt:        now,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if _, err := s.mongo.Collection(economicProviderResponseCollection).InsertOne(ctx, document); err != nil {
		return fmt.Errorf("archive economic provider response: %w", err)
	}
	if item.ProviderKind == ProviderAkshare {
		legacy := storedAkshareRequest{
			DataItemID:    item.Slug,
			Endpoint:      item.Endpoint,
			Method:        method,
			RequestParams: requestParams,
			Payload:       payload,
			FetchedAt:     now,
			CreatedAt:     now,
			UpdatedAt:     now,
		}
		if _, err := s.mongo.Collection(akshareResponseCollection).InsertOne(ctx, legacy); err != nil {
			return fmt.Errorf("archive akshare response: %w", err)
		}
	}
	return nil
}

type providerFailureDocument struct {
	Name    string `json:"name,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

func (s *Service) archiveProviderFailure(ctx context.Context, item ItemConfig, fetchErr error) error {
	if s == nil || s.mongo == nil {
		return fmt.Errorf("economicdata: mongo is not configured")
	}
	status := "failed"
	payload := providerFailureDocument{Message: fetchErr.Error()}
	if configurationErr, ok := fetchErr.(*ProviderConfigurationError); ok {
		status = "skipped"
		payload = providerFailureDocument{Name: "FinancialDataProviderConfigurationError", Code: configurationErr.Code, Message: configurationErr.Message}
	}
	now := time.Now().UTC()
	document := storedProviderRequest{
		DataItemID:       item.Slug,
		ProviderKind:     string(item.ProviderKind),
		ProviderIdentity: providerIdentity(item),
		Endpoint:         item.Endpoint,
		Method:           "GET",
		RequestParams:    failureRequestParams(item),
		Payload:          payload,
		Status:           status,
		FetchedAt:        now,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if _, err := s.mongo.Collection(economicProviderResponseCollection).InsertOne(ctx, document); err != nil {
		return fmt.Errorf("archive economic provider failure: %w", err)
	}
	return nil
}

func failureRequestParams(item ItemConfig) any {
	config := item.ProviderConfig
	switch config.Kind {
	case ProviderAkshare:
		if config.DefaultParams != nil {
			return config.DefaultParams
		}
		return map[string]string{}
	case ProviderFinnhub:
		return map[string]string{"symbol": config.Symbol}
	case ProviderFred:
		return map[string]any{"series_id": config.SeriesID, "metric": config.Metric, "limit": config.Lookback}
	case ProviderYfinance:
		raw, _ := json.Marshal(buildYfinanceRequest(config))
		return decodeJSONValue(raw)
	default:
		return map[string]string{}
	}
}

func providerIdentity(item ItemConfig) string {
	config := item.ProviderConfig
	switch config.Kind {
	case ProviderAkshare:
		return config.FunctionName
	case ProviderFinnhub:
		return config.Symbol
	case ProviderFred:
		return config.SeriesID
	case ProviderYfinance:
		return config.Symbol
	default:
		return "unknown"
	}
}

func decodeJSONValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}
