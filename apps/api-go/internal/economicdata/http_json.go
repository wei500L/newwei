package economicdata

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type httpJSONResult struct {
	Status int
	Body   []byte
	Header http.Header
}

func fetchJSON(ctx context.Context, client *http.Client, requestURL string, headers map[string]string, timeout time.Duration) (httpJSONResult, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, requestURL, nil)
	if err != nil {
		return httpJSONResult{}, err
	}
	request.Header.Set("accept", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := client.Do(request)
	if err != nil {
		return httpJSONResult{}, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return httpJSONResult{}, err
	}
	result := httpJSONResult{Status: response.StatusCode, Body: body, Header: response.Header}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, fmt.Errorf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	return result, nil
}

func decodeJSON[T any](raw []byte) (T, error) {
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, err
	}
	return value, nil
}
