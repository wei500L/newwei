package rsstranslation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// deepLxClient ports the RSS call path of SituationMonitorTranslationService:
// translateTextsToZhBestEffort -> translateHashesToZh -> requestZhTranslation
// -> requestViaDeepLx / requestViaFallbackApi. The situation insights callers
// are intentionally not migrated.
//
// The client is best-effort at the batch level exactly like NestJS: a settings
// read failure, a disabled runtime or any rejected task makes the whole batch
// return an empty map, while inner cache entries written by the tasks that
// already succeeded stay in Redis.
type deepLxClient struct {
	settings SettingsReader
	cache    *rssCache
	http     *http.Client
	sem      *semaphore
}

func newDeepLxClient(settings SettingsReader, cache *rssCache) *deepLxClient {
	return &deepLxClient{
		settings: settings,
		cache:    cache,
		http:     &http.Client{},
		sem:      newSemaphore(defaultLLMConcurrency),
	}
}

// TranslateBestEffort returns trimmed-text -> translated-text for the texts it
// could translate. It never returns an error: every failure is logged and the
// caller falls back to the original text.
func (c *deepLxClient) TranslateBestEffort(ctx context.Context, texts []string) map[string]string {
	targets := make(map[string]string, len(texts))
	order := make([]string, 0, len(texts))
	for _, text := range texts {
		normalized := strings.TrimSpace(text)
		if normalized == "" {
			continue
		}
		hash := sha256Hex(normalized)
		if _, exists := targets[hash]; exists {
			continue
		}
		targets[hash] = normalized
		order = append(order, hash)
	}
	if len(order) == 0 {
		return map[string]string{}
	}
	if c.settings == nil {
		log.Printf("api-go: RSS translation DeepLX runtime is not configured")
		return map[string]string{}
	}
	runtime, err := c.settings.TranslationRuntime(ctx)
	if err != nil {
		log.Printf("api-go: RSS translation DeepLX settings unavailable")
		return map[string]string{}
	}
	c.sem.setLimit(runtime.MaxConcurrency)
	if err := assertDeepLxRuntime(runtime); err != nil {
		log.Printf("api-go: RSS translation DeepLX runtime unavailable: %v", err)
		return map[string]string{}
	}
	translated, err := c.translateHashes(ctx, targets, order, runtime)
	if err != nil {
		log.Printf("api-go: RSS translation DeepLX request failed")
		return map[string]string{}
	}
	out := make(map[string]string, len(order))
	for _, hash := range order {
		if value := translated[hash]; value != "" {
			out[targets[hash]] = value
		}
	}
	return out
}

// translateHashes reads the inner 30 day cache and translates the misses under
// the shared concurrency limit. A single rejected task fails the batch, but the
// cache entries of the tasks that already completed are kept.
func (c *deepLxClient) translateHashes(ctx context.Context, targets map[string]string, order []string, runtime itemsreading.TranslationRuntimeConfig) (map[string]string, error) {
	translated := make(map[string]string, len(order))
	missing := make([]string, 0, len(order))
	for _, hash := range order {
		if cached, ok := c.cache.getString(ctx, deepLxInnerKey(targets[hash])); ok {
			translated[hash] = cached
			continue
		}
		missing = append(missing, hash)
	}
	if len(missing) == 0 {
		return translated, nil
	}

	var mu sync.Mutex
	var wait sync.WaitGroup
	var firstErr error
	var errOnce sync.Once
	recordErr := func(err error) {
		if err == nil {
			return
		}
		errOnce.Do(func() { firstErr = err })
	}
	for _, hash := range missing {
		wait.Add(1)
		go func(hash string) {
			defer wait.Done()
			var taskErr error
			permitErr := c.sem.withPermit(ctx, func() {
				text := targets[hash]
				zh, err := c.requestZhTranslation(ctx, text, runtime)
				if err != nil {
					taskErr = err
					return
				}
				if zh == "" {
					return
				}
				mu.Lock()
				translated[hash] = zh
				mu.Unlock()
				taskErr = c.cache.setString(ctx, deepLxInnerKey(text), zh, deepLxInnerCacheTTLSeconds)
			})
			if permitErr != nil {
				taskErr = permitErr
			}
			recordErr(taskErr)
		}(hash)
	}
	wait.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return translated, nil
}

// providerFailure carries an already formatted NestJS-style provider message.
type providerFailure struct {
	message string
}

func (e *providerFailure) Error() string { return e.message }

// requestZhTranslation ports requestZhTranslation.
func (c *deepLxClient) requestZhTranslation(ctx context.Context, text string, runtime itemsreading.TranslationRuntimeConfig) (string, error) {
	var deepLxErrorMessage string
	if canUseDeepLx(runtime) {
		translated, err := c.requestViaDeepLx(ctx, text, runtime)
		if err == nil {
			return translated, nil
		}
		deepLxErrorMessage = networkMessage(err, "DeepLX")
	} else {
		deepLxErrorMessage = deepLxConfigError(runtime)
	}

	if !canUseFallback(runtime) {
		if deepLxErrorMessage != "" {
			return "", &providerFailure{message: deepLxErrorMessage}
		}
		if fallbackError := fallbackConfigError(runtime); fallbackError != "" {
			return "", &providerFailure{message: fallbackError}
		}
		return "", &providerFailure{message: "No translation API is available"}
	}

	sourceLanguage := detectFallbackSourceLang(text)
	if sourceLanguage == "zh-CN" {
		return text, nil
	}
	if sourceLanguage == "" {
		const skipped = "Fallback translation API skipped: unsupported source language"
		if deepLxErrorMessage != "" {
			return "", &providerFailure{message: deepLxErrorMessage + "; " + skipped}
		}
		return "", &providerFailure{message: skipped}
	}

	translated, err := c.requestViaFallbackApi(ctx, text, sourceLanguage, runtime)
	if err != nil {
		fallbackErrorMessage := networkMessage(err, "Fallback translation API")
		if deepLxErrorMessage != "" {
			return "", &providerFailure{message: deepLxErrorMessage + "; " + fallbackErrorMessage}
		}
		return "", &providerFailure{message: fallbackErrorMessage}
	}
	return translated, nil
}

type deepLxRequest struct {
	Text       string `json:"text"`
	SourceLang string `json:"source_lang"`
	TargetLang string `json:"target_lang"`
}

type fallbackRequest struct {
	SourceLang string   `json:"source_lang"`
	TargetLang string   `json:"target_lang"`
	TextList   []string `json:"text_list"`
}

// requestViaDeepLx ports requestViaDeepLx including the per-endpoint retry
// budget (maxRetries+1 attempts), the 300ms*attempt backoff and the DeepLX
// numeric-code handling.
func (c *deepLxClient) requestViaDeepLx(ctx context.Context, text string, runtime itemsreading.TranslationRuntimeConfig) (string, error) {
	apiKey := strings.TrimSpace(runtime.APIKey)
	baseURL := strings.TrimRight(strings.TrimSpace(runtime.BaseURL), "/")
	if apiKey == "" {
		return "", &providerFailure{message: "DeepLX translation API key is not configured"}
	}
	if baseURL == "" {
		return "", &providerFailure{message: "DeepLX translation API base URL is not configured"}
	}
	timeout := translationTimeout(runtime)
	maxAttempts := translationMaxAttempts(runtime)
	endpoint := baseURL + "/" + url.PathEscape(apiKey) + "/translate"
	body, err := json.Marshal(deepLxRequest{Text: text, SourceLang: "auto", TargetLang: "ZH"})
	if err != nil {
		return "", err
	}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		status, payload, postErr := c.postJSON(ctx, endpoint, body, timeout)
		if postErr != nil {
			if attempt < maxAttempts && isRetryableNetworkFailure(postErr) {
				if sleepErr := sleepContext(ctx, translationBackoff(attempt)); sleepErr != nil {
					return "", sleepErr
				}
				continue
			}
			return "", &providerFailure{message: networkMessage(postErr, "DeepLX")}
		}
		if status < 200 || status >= 300 {
			message := buildHTTPErrorMessage("DeepLX", status, payload)
			if attempt < maxAttempts && canRetryStatus(status) {
				if sleepErr := sleepContext(ctx, translationBackoff(attempt)); sleepErr != nil {
					return "", sleepErr
				}
				continue
			}
			return "", &providerFailure{message: message}
		}
		if code, ok := extractNumericCode(payload); ok && code != 200 {
			message := buildCodeErrorMessage("DeepLX", code, payload)
			if attempt < maxAttempts && canRetryStatus(code) {
				if sleepErr := sleepContext(ctx, translationBackoff(attempt)); sleepErr != nil {
					return "", sleepErr
				}
				continue
			}
			return "", &providerFailure{message: message}
		}
		translated := extractDeepLxText(payload)
		if translated == "" {
			return "", &providerFailure{message: "DeepLX response missing translated text"}
		}
		return translated, nil
	}
	return "", &providerFailure{message: "DeepLX request failed"}
}

// requestViaFallbackApi ports requestViaFallbackApi.
func (c *deepLxClient) requestViaFallbackApi(ctx context.Context, text string, sourceLanguage string, runtime itemsreading.TranslationRuntimeConfig) (string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(runtime.FallbackBaseURL), "/")
	if baseURL == "" {
		return "", &providerFailure{message: "Fallback translation API base URL is not configured"}
	}
	timeout := translationTimeout(runtime)
	maxAttempts := translationMaxAttempts(runtime)
	body, err := json.Marshal(fallbackRequest{SourceLang: sourceLanguage, TargetLang: "zh-CN", TextList: []string{text}})
	if err != nil {
		return "", err
	}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		status, payload, postErr := c.postJSON(ctx, baseURL, body, timeout)
		if postErr != nil {
			if attempt < maxAttempts && isRetryableNetworkFailure(postErr) {
				if sleepErr := sleepContext(ctx, translationBackoff(attempt)); sleepErr != nil {
					return "", sleepErr
				}
				continue
			}
			return "", &providerFailure{message: networkMessage(postErr, "Fallback translation API")}
		}
		if status < 200 || status >= 300 {
			message := buildHTTPErrorMessage("Fallback translation API", status, payload)
			if attempt < maxAttempts && canRetryStatus(status) {
				if sleepErr := sleepContext(ctx, translationBackoff(attempt)); sleepErr != nil {
					return "", sleepErr
				}
				continue
			}
			return "", &providerFailure{message: message}
		}
		translated := extractFallbackText(payload)
		if translated == "" {
			return "", &providerFailure{message: "Fallback translation API response missing translated text"}
		}
		return translated, nil
	}
	return "", &providerFailure{message: "Fallback translation API request failed"}
}

func (c *deepLxClient) postJSON(ctx context.Context, endpoint string, body []byte, timeout time.Duration) (int, []byte, error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("content-type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return response.StatusCode, nil, err
	}
	return response.StatusCode, payload, nil
}

func translationTimeout(runtime itemsreading.TranslationRuntimeConfig) time.Duration {
	timeout := runtime.TimeoutMs
	if timeout < 1_000 {
		timeout = defaultDeepLxTimeoutMs
	}
	return time.Duration(timeout) * time.Millisecond
}

func translationMaxAttempts(runtime itemsreading.TranslationRuntimeConfig) int {
	retries := runtime.MaxRetries
	if retries < 0 {
		retries = defaultDeepLxMaxRetries
	}
	return retries + 1
}

func translationBackoff(attempt int) time.Duration {
	return time.Duration(translationRetryBackoffMs*attempt) * time.Millisecond
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func canRetryStatus(status int) bool {
	return status == 408 || status == 429 || status >= 500
}

func isRetryableNetworkFailure(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	return true
}

// networkMessage ports toNetworkErrorMessage: an already formatted provider
// message is returned as-is, a timeout gets the timeout wording and anything
// else is prefixed and truncated.
func networkMessage(err error, provider string) string {
	if err == nil {
		return ""
	}
	var failure *providerFailure
	if errors.As(err, &failure) {
		return failure.message
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return provider + " request timed out"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return provider + " request timed out"
	}
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return provider + " request failed"
	}
	return provider + " request failed: " + truncateProviderMessage(message)
}

func truncateProviderMessage(message string) string {
	if jsLength(message) > 200 {
		return jsSlice(message, 0, 200) + "..."
	}
	return message
}

func buildHTTPErrorMessage(provider string, status int, payload []byte) string {
	if detail := extractErrorDetail(payload); detail != "" {
		return fmt.Sprintf("%s request failed (HTTP %d): %s", provider, status, detail)
	}
	return fmt.Sprintf("%s request failed (HTTP %d)", provider, status)
}

func buildCodeErrorMessage(provider string, code int, payload []byte) string {
	if detail := extractErrorDetail(payload); detail != "" {
		return fmt.Sprintf("%s request failed (code %d): %s", provider, code, detail)
	}
	return fmt.Sprintf("%s request failed (code %d)", provider, code)
}

// extractErrorDetail reads the NestJS candidate fields (message/error/msg/detail)
// from an upstream error body.
func extractErrorDetail(payload []byte) string {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(payload, &text) != nil {
			return ""
		}
		message := strings.TrimSpace(text)
		if message == "" {
			return ""
		}
		return truncateProviderMessage(message)
	}
	var body struct {
		Message json.RawMessage `json:"message"`
		Error   json.RawMessage `json:"error"`
		Msg     json.RawMessage `json:"msg"`
		Detail  json.RawMessage `json:"detail"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	for _, candidate := range []json.RawMessage{body.Message, body.Error, body.Msg, body.Detail} {
		if value := rawTextValue(candidate); value != nil {
			return truncateProviderMessage(*value)
		}
	}
	return ""
}

func extractNumericCode(payload []byte) (int, bool) {
	var body struct {
		Code *float64 `json:"code"`
	}
	if json.Unmarshal(payload, &body) != nil || body.Code == nil {
		return 0, false
	}
	code := *body.Code
	if math.IsNaN(code) || math.IsInf(code, 0) {
		return 0, false
	}
	return int(math.Trunc(code)), true
}

// extractDeepLxText ports extractDeepLxTranslatedText: a bare string, then
// data, then translation, then the first string in alternatives.
func extractDeepLxText(payload []byte) string {
	var text string
	if json.Unmarshal(payload, &text) == nil {
		return strings.TrimSpace(text)
	}
	var body struct {
		Data         json.RawMessage   `json:"data"`
		Translation  json.RawMessage   `json:"translation"`
		Alternatives []json.RawMessage `json:"alternatives"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	if value := rawTextValue(body.Data); value != nil {
		return *value
	}
	if value := rawTextValue(body.Translation); value != nil {
		return *value
	}
	for _, alternative := range body.Alternatives {
		if value := rawTextValue(alternative); value != nil {
			return *value
		}
	}
	return ""
}

// extractFallbackText ports extractFallbackTranslatedText: the first non-empty
// translations[].text.
func extractFallbackText(payload []byte) string {
	var body struct {
		Translations []struct {
			Text json.RawMessage `json:"text"`
		} `json:"translations"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	for _, entry := range body.Translations {
		if value := rawTextValue(entry.Text); value != nil {
			return *value
		}
	}
	return ""
}

// canUseDeepLx / canUseFallback mirror the situation monitor helpers.
func canUseDeepLx(runtime itemsreading.TranslationRuntimeConfig) bool {
	return runtime.Enabled && strings.TrimSpace(runtime.BaseURL) != "" && strings.TrimSpace(runtime.APIKey) != ""
}

func canUseFallback(runtime itemsreading.TranslationRuntimeConfig) bool {
	return runtime.FallbackEnabled && strings.TrimSpace(runtime.FallbackBaseURL) != ""
}

func deepLxConfigError(runtime itemsreading.TranslationRuntimeConfig) string {
	if !runtime.Enabled {
		return "DeepLX translation API is disabled"
	}
	if strings.TrimSpace(runtime.BaseURL) == "" {
		return "DeepLX translation API base URL is not configured"
	}
	if strings.TrimSpace(runtime.APIKey) == "" {
		return "DeepLX translation API key is not configured"
	}
	return ""
}

func fallbackConfigError(runtime itemsreading.TranslationRuntimeConfig) string {
	if !runtime.FallbackEnabled {
		return "Fallback translation API is disabled"
	}
	if strings.TrimSpace(runtime.FallbackBaseURL) == "" {
		return "Fallback translation API base URL is not configured"
	}
	return ""
}

// assertDeepLxRuntime ports assertRuntimeConfig.
func assertDeepLxRuntime(runtime itemsreading.TranslationRuntimeConfig) error {
	if !runtime.Enabled && !runtime.FallbackEnabled {
		return errors.New("Translation APIs are disabled")
	}
	if canUseDeepLx(runtime) || canUseFallback(runtime) {
		return nil
	}
	deepLxError := deepLxConfigError(runtime)
	fallbackError := fallbackConfigError(runtime)
	if deepLxError != "" && fallbackError != "" {
		return errors.New(deepLxError + "; " + fallbackError)
	}
	if deepLxError != "" {
		return errors.New(deepLxError)
	}
	if fallbackError != "" {
		return errors.New(fallbackError)
	}
	return errors.New("No translation API is available")
}

var (
	fallbackJapanesePattern = regexp.MustCompile(`[\x{3040}-\x{30ff}]`)
	fallbackKoreanPattern   = regexp.MustCompile(`[\x{ac00}-\x{d7af}\x{1100}-\x{11ff}]`)
	fallbackChinesePattern  = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)
	fallbackFrenchAccents   = regexp.MustCompile(`(?i)[àâçéèêëîïôûùüÿœæ]`)
	fallbackFrenchWords     = regexp.MustCompile(`\b(le|la|les|des|du|de|une|un|bonjour|merci|avec|pour|dans|est|sont)\b`)
	fallbackGermanAccents   = regexp.MustCompile(`(?i)[äöüß]`)
	fallbackGermanWords     = regexp.MustCompile(`\b(der|die|das|und|ist|mit|nicht|ein|eine|für|auf|von|den)\b`)
	fallbackLatinPattern    = regexp.MustCompile(`(?i)[a-z]`)
)

// detectFallbackSourceLang ports detectFallbackSourceLang with the same
// Japanese -> Korean -> Chinese -> French -> German -> English order.
func detectFallbackSourceLang(text string) string {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return ""
	}
	if fallbackJapanesePattern.MatchString(normalized) {
		return "ja"
	}
	if fallbackKoreanPattern.MatchString(normalized) {
		return "ko"
	}
	if fallbackChinesePattern.MatchString(normalized) {
		return "zh-CN"
	}
	lower := strings.ToLower(normalized)
	if fallbackFrenchAccents.MatchString(normalized) || fallbackFrenchWords.MatchString(lower) {
		return "fr"
	}
	if fallbackGermanAccents.MatchString(normalized) || fallbackGermanWords.MatchString(lower) {
		return "de"
	}
	if fallbackLatinPattern.MatchString(normalized) {
		return "en"
	}
	return ""
}
