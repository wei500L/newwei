package situationsignals

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	insightsFinnhubQuoteURL     = "https://finnhub.io/api/v1/quote"
	insightsFredObservationsURL = "https://api.stlouisfed.org/fred/series/observations"
	insightsCoinGeckoURL        = "https://api.coingecko.com/api/v3/simple/price"
	insightsCoinGeckoIDs        = "bitcoin,ethereum,binancecoin,solana,xrp,cardano,dogecoin,toncoin"
	insightsExternalTimeout     = 12 * time.Second
)

type insightsMarketConfig struct {
	symbol string
	name   string
	kind   string
}

var insightsMarketIndexes = []insightsMarketConfig{
	{"SPY", "S&P 500", "index"}, {"QQQ", "NASDAQ 100", "index"},
	{"DIA", "Dow 30", "index"}, {"IWM", "Russell 2000", "index"},
}

var insightsMarketSectors = []insightsMarketConfig{
	{"XLK", "Technology", "sector"}, {"XLF", "Financials", "sector"},
	{"XLE", "Energy", "sector"}, {"XLV", "Healthcare", "sector"},
	{"XLI", "Industrials", "sector"}, {"XLY", "Consumer Disc.", "sector"},
}

var insightsMarketCommodities = []insightsMarketConfig{
	{"GLD", "Gold", "commodity"}, {"SLV", "Silver", "commodity"},
	{"USO", "Crude Oil", "commodity"}, {"DBA", "Agriculture", "commodity"},
}

type insightsFredSeries struct {
	seriesID string
	name     string
	unit     string
}

var insightsFredSeriesList = []insightsFredSeries{
	{"DFF", "Federal Funds Rate", "%"},
	{"T10Y2Y", "10Y-2Y Spread", "%"},
	{"T10YIE", "10Y Breakeven Inflation", "%"},
	{"DTB3", "3-Month T-Bill", "%"},
	{"WM2NS", "M2 Money Supply", "$B"},
}

// insightsExternalPayload is the subset of the response the external section
// contributes. A nil pointer means the allSettled branch was rejected and the
// field is absent.
type insightsExternalPayload struct {
	Crypto  *[]cryptoItem    `json:"crypto,omitempty"`
	Markets *marketsSnapshot `json:"markets,omitempty"`
	Fed     *fedSnapshot     `json:"fed,omitempty"`
}

func (s *insightsService) loadExternal(ctx context.Context) insightsExternalPayload {
	payload := insightsExternalPayload{}
	crypto := s.loadCryptoSnapshot(ctx)
	payload.Crypto = &crypto
	markets := s.loadMarketsSnapshot(ctx)
	payload.Markets = &markets
	fed := s.loadFedSnapshot(ctx)
	fedNews := []fedNewsItem{}
	fed.News = fedNews
	payload.Fed = &fed
	return payload
}

func applyExternalPayload(response *insightsResponse, external insightsExternalPayload) {
	if external.Crypto != nil {
		response.Crypto = external.Crypto
	}
	if external.Markets != nil {
		response.Markets = external.Markets
	}
	if external.Fed != nil {
		response.Fed = external.Fed
	}
}

func (s *insightsService) loadMarketsSnapshot(ctx context.Context) marketsSnapshot {
	snapshot := marketsSnapshot{Indices: []marketItem{}, Sectors: []marketItem{}, Commodities: []marketItem{}}
	apiKey := s.finnhubAPIKey(ctx)
	if apiKey == "" {
		return snapshot
	}
	snapshot.HasFinnhubAPIKey = true

	groups := []struct {
		entries []insightsMarketConfig
	}{{insightsMarketIndexes}, {insightsMarketSectors}, {insightsMarketCommodities}}
	total := 0
	for _, group := range groups {
		total += len(group.entries)
	}
	items := make([]*marketItem, total)
	failures := 0
	var wg sync.WaitGroup
	var mu sync.Mutex
	index := 0
	for _, group := range groups {
		for _, entry := range group.entries {
			position := index
			config := entry
			index++
			wg.Add(1)
			go func() {
				defer wg.Done()
				quote, err := s.fetchFinnhubQuote(ctx, apiKey, config.symbol)
				if err != nil {
					mu.Lock()
					failures++
					mu.Unlock()
					return
				}
				item := marketItem{Symbol: config.symbol, Name: config.name, Price: quote.price, Change: quote.change, ChangePercent: quote.changePercent, Type: config.kind}
				items[position] = &item
			}()
		}
	}
	wg.Wait()
	for _, item := range items {
		if item == nil {
			continue
		}
		switch item.Type {
		case "index":
			snapshot.Indices = append(snapshot.Indices, *item)
		case "sector":
			snapshot.Sectors = append(snapshot.Sectors, *item)
		case "commodity":
			snapshot.Commodities = append(snapshot.Commodities, *item)
		}
	}

	quote, err := s.fetchFinnhubQuote(ctx, apiKey, "VIXY")
	if err != nil {
		failures++
	} else {
		snapshot.VIX = &marketItem{Symbol: "VIX", Name: "VIX Volatility", Price: quote.price, Change: quote.change, ChangePercent: quote.changePercent, Type: "index"}
	}
	if failures > 0 {
		snapshot.Error = fmt.Sprintf("%d quote(s) failed to load", failures)
	}
	return snapshot
}

type finnhubQuote struct {
	price         float64
	change        float64
	changePercent float64
}

func (s *insightsService) fetchFinnhubQuote(ctx context.Context, apiKey, symbol string) (finnhubQuote, error) {
	requestURL := s.finnhubEndpoint() + "?symbol=" + url.QueryEscape(symbol) + "&token=" + url.QueryEscape(apiKey)
	body, status, err := s.getJSON(ctx, requestURL, insightsExternalTimeout)
	if err != nil {
		return finnhubQuote{}, err
	}
	if status < 200 || status >= 300 {
		return finnhubQuote{}, fmt.Errorf("Finnhub quote HTTP %d", status)
	}
	var payload struct {
		C  *float64 `json:"c"`
		D  *float64 `json:"d"`
		DP *float64 `json:"dp"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return finnhubQuote{}, err
	}
	if payload.C == nil || !finite(*payload.C) {
		return finnhubQuote{}, fmt.Errorf("Finnhub quote missing close for %s", symbol)
	}
	change := 0.0
	if payload.D != nil && finite(*payload.D) {
		change = *payload.D
	}
	changePercent := 0.0
	if payload.DP != nil && finite(*payload.DP) {
		changePercent = *payload.DP
	}
	return finnhubQuote{price: *payload.C, change: change, changePercent: changePercent}, nil
}

func (s *insightsService) loadFedSnapshot(ctx context.Context) fedSnapshot {
	snapshot := fedSnapshot{Indicators: []fedIndicator{}, News: []fedNewsItem{}}
	apiKey := s.fredAPIKey(ctx)
	if apiKey == "" {
		return snapshot
	}
	snapshot.HasFredAPIKey = true
	type result struct {
		index    int
		value    float64
		previous *float64
		ok       bool
	}
	results := make([]result, len(insightsFredSeriesList))
	var wg sync.WaitGroup
	for index, series := range insightsFredSeriesList {
		position := index
		config := series
		wg.Add(1)
		go func() {
			defer wg.Done()
			observation, err := s.fetchFredSeries(ctx, apiKey, config.seriesID)
			if err != nil {
				return
			}
			results[position] = result{index: position, value: observation.value, previous: observation.previous, ok: true}
		}()
	}
	wg.Wait()
	failures := 0
	var m2 *struct {
		value    float64
		previous *float64
	}
	for index, item := range results {
		if !item.ok {
			failures++
			continue
		}
		value := item.value
		previous := item.previous
		snapshot.Indicators = append(snapshot.Indicators, fedIndicator{
			SeriesID: insightsFredSeriesList[index].seriesID,
			Name:     insightsFredSeriesList[index].name,
			Value:    &value,
			Change:   previous,
			Unit:     insightsFredSeriesList[index].unit,
		})
		if insightsFredSeriesList[index].seriesID == "WM2NS" {
			m2 = &struct {
				value    float64
				previous *float64
			}{value: item.value, previous: item.previous}
		}
	}
	snapshot.MoneyPrinter = buildMoneyPrinter(m2)
	if failures > 0 {
		snapshot.Error = fmt.Sprintf("%d FRED series failed to load", failures)
	}
	return snapshot
}

type fredObservation struct {
	value    float64
	previous *float64
}

func (s *insightsService) fetchFredSeries(ctx context.Context, apiKey, seriesID string) (fredObservation, error) {
	requestURL := s.fredEndpoint() +
		"?series_id=" + url.QueryEscape(seriesID) +
		"&api_key=" + url.QueryEscape(apiKey) +
		"&file_type=json&sort_order=desc&limit=3"
	body, status, err := s.getJSON(ctx, requestURL, insightsExternalTimeout)
	if err != nil {
		return fredObservation{}, err
	}
	if status < 200 || status >= 300 {
		return fredObservation{}, fmt.Errorf("FRED HTTP %d for %s", status, seriesID)
	}
	var payload struct {
		Observations []struct {
			Value json.RawMessage `json:"value"`
		} `json:"observations"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return fredObservation{}, err
	}
	values := make([]float64, 0, len(payload.Observations))
	for _, observation := range payload.Observations {
		text, ok := insightsRawJSONString(observation.Value)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" || trimmed == "." {
			continue
		}
		parsed, err := parseInsightsFloat(trimmed)
		if err != nil || !finite(parsed) {
			continue
		}
		values = append(values, parsed)
	}
	if len(values) == 0 {
		return fredObservation{}, fmt.Errorf("FRED series %s has no observations", seriesID)
	}
	out := fredObservation{value: values[0]}
	if len(values) > 1 {
		previous := values[1]
		out.previous = &previous
	}
	return out, nil
}

func buildMoneyPrinter(observation *struct {
	value    float64
	previous *float64
}) *moneyPrinter {
	if observation == nil || !finite(observation.value) {
		return nil
	}
	valueTrillions := observation.value / 1000
	changeTrillions := 0.0
	if observation.previous != nil {
		changeTrillions = (observation.value - *observation.previous) / 1000
	}
	changePercent := 0.0
	if observation.previous != nil && *observation.previous != 0 {
		changePercent = ((observation.value - *observation.previous) / *observation.previous) * 100
	}
	return &moneyPrinter{
		ValueTrillions:  round2(valueTrillions),
		ChangeTrillions: round2(changeTrillions),
		ChangePercent:   round2(changePercent),
		PercentOfMax:    round2((valueTrillions / 22.5) * 100),
	}
}

func (s *insightsService) loadCryptoSnapshot(ctx context.Context) []cryptoItem {
	requestURL := s.coinGeckoEndpoint() + "?ids=" + url.QueryEscape(insightsCoinGeckoIDs) + "&vs_currencies=usd&include_24hr_change=true"
	body, status, err := s.getJSON(ctx, requestURL, insightsExternalTimeout)
	if err != nil || status < 200 || status >= 300 {
		return []cryptoItem{}
	}
	var payload map[string]struct {
		USD       json.RawMessage `json:"usd"`
		Change24h json.RawMessage `json:"usd_24h_change"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return []cryptoItem{}
	}
	ids := strings.Split(insightsCoinGeckoIDs, ",")
	out := make([]cryptoItem, 0, len(ids))
	for _, id := range ids {
		entry, ok := payload[id]
		if !ok {
			continue
		}
		price, err := insightsRawJSONFloat(entry.USD)
		if err != nil || !finite(price) || price <= 0 {
			continue
		}
		change, err := insightsRawJSONFloat(entry.Change24h)
		if err != nil || !finite(change) {
			change = 0
		}
		out = append(out, cryptoItem{
			ID: id, Symbol: strings.ToUpper(id), Name: id,
			CurrentPriceUSD: price, Change24hPercent: change,
		})
	}
	return out
}

func insightsRawJSONFloat(raw json.RawMessage) (float64, error) {
	if len(raw) == 0 {
		return 0, fmt.Errorf("missing number")
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0, err
	}
	return number, nil
}

func parseInsightsFloat(value string) (float64, error) {
	var number float64
	if err := json.Unmarshal([]byte(value), &number); err == nil {
		return number, nil
	}
	return 0, fmt.Errorf("not a number")
}

func (s *insightsService) getJSON(ctx context.Context, requestURL string, timeout time.Duration) ([]byte, int, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := s.httpClient().Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return body, response.StatusCode, nil
}

func (s *insightsService) httpClient() *http.Client {
	if s.client != nil {
		return s.client
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (s *insightsService) finnhubEndpoint() string {
	if s.finnhubURL != "" {
		return s.finnhubURL
	}
	return insightsFinnhubQuoteURL
}

func (s *insightsService) fredEndpoint() string {
	if s.fredURL != "" {
		return s.fredURL
	}
	return insightsFredObservationsURL
}

func (s *insightsService) coinGeckoEndpoint() string {
	if s.coinGeckoURL != "" {
		return s.coinGeckoURL
	}
	return insightsCoinGeckoURL
}

func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}
