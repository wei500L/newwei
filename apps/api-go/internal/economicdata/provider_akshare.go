package economicdata

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type akshareProvider struct{ service *Service }

func (p *akshareProvider) Kind() ProviderKind { return ProviderAkshare }

func (p *akshareProvider) Configured(context.Context) bool { return p.service.env.AkshareEnabled }

func (p *akshareProvider) Fetch(ctx context.Context, item ItemConfig) (ProviderFetchResult, error) {
	if !p.service.env.AkshareEnabled {
		return ProviderFetchResult{}, &ProviderConfigurationError{Code: "provider_disabled", Message: "akshare_disabled"}
	}
	config := item.ProviderConfig
	if config.Kind != ProviderAkshare || config.Parser == nil {
		return ProviderFetchResult{}, fmt.Errorf("Expected akshare provider config for %s", item.Slug)
	}
	params := resolveParamTemplates(config.DefaultParams)
	payload, err := p.execute(ctx, item, config, params)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	filtered, err := decodePayload(payload)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	filtered, err = applyPayloadFilter(filtered, config.Filter)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	points, err := parsePayload(*config.Parser, filtered, item.Slug)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	requestParams, _ := json.Marshal(params)
	method := config.Method
	if method == "" {
		method = "GET"
	}
	return ProviderFetchResult{
		Payload:          payload,
		Points:           points,
		RequestParams:    requestParams,
		Method:           method,
		ProviderIdentity: config.FunctionName,
	}, nil
}

func (p *akshareProvider) execute(ctx context.Context, item ItemConfig, config ProviderConfig, params map[string]string) (json.RawMessage, error) {
	endpoint := config.Endpoint
	var requestURL string
	if parsed, err := url.Parse(endpoint); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
		requestURL = endpoint
	} else {
		base := strings.TrimRight(p.service.env.AkshareBaseURL, "/")
		if strings.HasPrefix(endpoint, "/") {
			requestURL = base + endpoint
		} else {
			requestURL = base + "/" + endpoint
		}
	}
	method := config.Method
	if method == "" {
		method = "GET"
	}
	attempts := p.service.env.AkshareMaxRetries
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		raw, err := p.requestOnce(ctx, method, requestURL, params)
		if err == nil {
			return raw, nil
		}
		lastErr = err
		if attempt == attempts {
			break
		}
		delay := time.Duration(minInt(2000*attempt, 10000)) * time.Millisecond
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil, lastErr
}

func (p *akshareProvider) requestOnce(ctx context.Context, method, requestURL string, params map[string]string) (json.RawMessage, error) {
	var body io.Reader
	queryURL := requestURL
	if method == http.MethodPost {
		encoded, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(encoded)
	} else {
		parsed, err := url.Parse(requestURL)
		if err != nil {
			return nil, err
		}
		query := parsed.Query()
		for key, value := range params {
			query.Set(key, value)
		}
		parsed.RawQuery = query.Encode()
		queryURL = parsed.String()
	}
	timeout := p.service.env.AkshareTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, method, queryURL, body)
	if err != nil {
		return nil, err
	}
	if method == http.MethodPost {
		request.Header.Set("content-type", "application/json")
	}
	request.Header.Set("accept", "application/json")
	response, err := p.service.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	return json.RawMessage(raw), nil
}

func resolveParamTemplates(params map[string]string) map[string]string {
	out := make(map[string]string, len(params))
	for key, value := range params {
		out[key] = resolveParamTemplate(value)
	}
	return out
}

func resolveParamTemplate(value string) string {
	index := 0
	for {
		start := strings.Index(value[index:], "${TODAY_YYYYMMDD")
		if start < 0 {
			return value
		}
		start += index
		end := strings.IndexByte(value[start:], '}')
		if end < 0 {
			return value
		}
		end += start
		expression := value[start+len("${TODAY_YYYYMMDD") : end]
		delta := 0
		if expression != "" {
			if parsed, err := strconv.Atoi(expression); err == nil {
				delta = parsed
			}
		}
		replacement := shanghaiDateYYYYMMDD(delta)
		value = value[:start] + replacement + value[end+1:]
		index = start + len(replacement)
	}
}

func applyPayloadFilter(payload any, filter *PayloadFilter) (any, error) {
	if filter == nil {
		return payload, nil
	}
	records := recordArray(payload)
	if len(records) == 0 {
		return nil, fmt.Errorf("Payload filter expects record array (field=%s)", filter.Field)
	}
	matches := make([]map[string]any, 0)
	for _, record := range records {
		value := ""
		if raw, ok := record[filter.Field]; ok && raw != nil {
			value = strings.TrimSpace(fmt.Sprintf("%v", raw))
		}
		if value == filter.Equals {
			matches = append(matches, record)
		}
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("Expected record not found: %s=%s", filter.Field, filter.Equals)
	}
	switch filter.Mode {
	case "all":
		out := make([]any, 0, len(matches))
		for _, match := range matches {
			out = append(out, match)
		}
		return out, nil
	case "best":
		return selectBestRecord(matches, filter), nil
	default:
		return matches[0], nil
	}
}

func selectBestRecord(records []map[string]any, filter *PayloadFilter) map[string]any {
	best := records[0]
	bestScore := -1e308
	for _, record := range records {
		hasPreferred := true
		if filter.PreferNonZeroField != "" {
			preferred := normalizeNumber(record[filter.PreferNonZeroField])
			hasPreferred = preferred != nil && *preferred > 0
		}
		rank := float64(0)
		if filter.RankBy != "" {
			if value := normalizeNumber(record[filter.RankBy]); value != nil {
				rank = *value
			}
		}
		if filter.RankOrder == "asc" {
			rank = -rank
		}
		score := rank
		if hasPreferred {
			score += 1_000_000_000_000
		}
		if score > bestScore {
			best = record
			bestScore = score
		}
	}
	return best
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
