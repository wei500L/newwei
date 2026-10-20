package situationsignals

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

const (
	insightsTranslationCachePrefix = "situation-monitor:translation:v3:zh-cn:multi"
	insightsTranslationCacheTTL    = 30 * 24 * 60 * 60 * time.Second
)

var (
	translationJapanesePattern = regexp.MustCompile(`[\x{3040}-\x{30ff}]`)
	translationKoreanPattern   = regexp.MustCompile(`[\x{ac00}-\x{d7af}\x{1100}-\x{11ff}]`)
	translationChinesePattern  = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)
	translationFrenchAccents   = regexp.MustCompile(`(?i)[àâçéèêëîïôûùüÿœæ]`)
	translationFrenchWords     = regexp.MustCompile(`(?i)\b(le|la|les|des|du|de|une|un|bonjour|merci|avec|pour|dans|est|sont)\b`)
	translationGermanAccents   = regexp.MustCompile(`(?i)[äöüß]`)
	translationGermanWords     = regexp.MustCompile(`(?i)\b(der|die|das|und|ist|mit|nicht|ein|eine|für|auf|von|den)\b`)
	translationLatinLetter     = regexp.MustCompile(`(?i)[a-z]`)
)

type insightsTranslationTaskError struct {
	index int
	err   error
}

// applyZhTranslationsBestEffort mirrors applyZhTranslationsBestEffort. Every
// failure is returned as {applied:false,error}; the response body is never
// discarded.
func (s *insightsService) applyZhTranslationsBestEffort(ctx context.Context, response *insightsResponse) insightsTranslationResult {
	targets := collectTranslationTargets(response)
	if len(targets) == 0 {
		return insightsTranslationResult{Applied: true}
	}
	runtime, err := s.getTranslationRuntime(ctx)
	if err != nil {
		return insightsTranslationResult{Applied: false, Error: err.Error()}
	}
	if err := assertTranslationConfig(runtime); err != nil {
		return insightsTranslationResult{Applied: false, Error: err.Error()}
	}
	translated, err := s.translateHashesToZh(ctx, targets, runtime)
	if err != nil {
		return insightsTranslationResult{Applied: false, Error: err.Error()}
	}
	applyTranslationMap(response, translated)
	return insightsTranslationResult{Applied: true}
}

func collectTranslationTargets(response *insightsResponse) map[string]string {
	targets := map[string]string{}
	collect := func(text string) {
		normalized := strings.TrimSpace(text)
		if normalized == "" {
			return
		}
		targets[translationHash(normalized)] = normalized
	}
	collectHeadline := func(headline analysis.Headline) {
		collect(headline.Title)
		collect(headline.Summary)
		for _, point := range headline.KeyPoints {
			collect(point)
		}
	}

	if response.Headlines != nil {
		for _, category := range analysis.Categories {
			bucket := response.Headlines.Bucket(category)
			if bucket == nil {
				continue
			}
			for _, headline := range *bucket {
				collectHeadline(headline)
			}
		}
	}
	if response.Clusters != nil {
		for _, category := range analysis.Categories {
			bucket := response.Clusters.Bucket(category)
			if bucket == nil {
				continue
			}
			for _, cluster := range *bucket {
				collectHeadline(cluster.Lead)
				for _, item := range cluster.Items {
					collectHeadline(item)
				}
			}
		}
	}
	if response.Alerts != nil {
		for _, alert := range *response.Alerts {
			collectHeadline(alert.Headline)
		}
	}
	if response.Leaders != nil {
		for _, leader := range *response.Leaders {
			for _, headline := range leader.Headlines {
				collect(headline.Title)
			}
		}
	}
	if response.Situations != nil {
		for _, panel := range *response.Situations {
			collect(panel.Title)
			collect(panel.Subtitle)
			for _, headline := range panel.Headlines {
				collect(headline.Title)
			}
		}
	}
	if response.Fed != nil {
		for _, entry := range response.Fed.News {
			collect(entry.Title)
			collect(entry.Description)
			collect(entry.TypeLabel)
		}
	}
	if response.Correlation != nil && response.Correlation.Value != nil {
		correlation := response.Correlation.Value
		for _, entry := range correlation.EmergingPatterns {
			collect(entry.Name)
			for _, headline := range entry.Headlines {
				collect(headline.Title)
			}
		}
		for _, entry := range correlation.MomentumSignals {
			collect(entry.Name)
			for _, headline := range entry.Headlines {
				collect(headline.Title)
			}
		}
		for _, entry := range correlation.CrossSourceCorrelations {
			collect(entry.Name)
			for _, headline := range entry.Headlines {
				collect(headline.Title)
			}
		}
		for _, entry := range correlation.PredictiveSignals {
			collect(entry.Name)
			collect(entry.Prediction)
			for _, headline := range entry.Headlines {
				collect(headline.Title)
			}
		}
	}
	if response.CorrelationSummary != nil {
		collect(response.CorrelationSummary.Status)
	}
	if response.Narrative != nil && response.Narrative.Value != nil {
		narrative := response.Narrative.Value
		for _, bucket := range [][]analysis.NarrativeData{
			narrativeDataOfFringe(narrative.EmergingFringe),
			narrativeDataOfCrossing(narrative.FringeToMainstream),
			narrative.NarrativeWatch,
			narrative.DisinfoSignals,
		} {
			for _, entry := range bucket {
				collect(entry.Name)
				for _, headline := range entry.Headlines {
					collect(headline.Title)
				}
			}
		}
	}
	if response.NarrativeSummary != nil {
		collect(response.NarrativeSummary.Status)
	}
	if response.MainCharacterSummary != nil {
		collect(response.MainCharacterSummary.Status)
	}
	return targets
}

func narrativeDataOfFringe(values []analysis.EmergingFringe) []analysis.NarrativeData {
	out := make([]analysis.NarrativeData, 0, len(values))
	for _, value := range values {
		out = append(out, value.NarrativeData)
	}
	return out
}

func narrativeDataOfCrossing(values []analysis.FringeToMainstream) []analysis.NarrativeData {
	out := make([]analysis.NarrativeData, 0, len(values))
	for _, value := range values {
		out = append(out, value.NarrativeData)
	}
	return out
}

func (s *insightsService) translateHashesToZh(ctx context.Context, targets map[string]string, runtime insightsTranslationRuntime) (map[string]string, error) {
	translated := map[string]string{}
	missing := make([]struct {
		hash string
		text string
	}, 0)
	for hash, text := range targets {
		var cached string
		found, err := insightsCacheGetInto(ctx, s.cache, insightsTranslationCacheKey(hash), &cached)
		if err != nil {
			return nil, err
		}
		if found && cached != "" {
			translated[hash] = cached
			continue
		}
		missing = append(missing, struct {
			hash string
			text string
		}{hash: hash, text: text})
	}
	if len(missing) == 0 {
		return translated, nil
	}

	limit := runtime.MaxConcurrency
	if limit < 1 {
		limit = 1
	}
	semaphore := make(chan struct{}, limit)
	var wg sync.WaitGroup
	var mu sync.Mutex
	taskErrors := make([]error, len(missing))
	for index, task := range missing {
		index, task := index, task
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				taskErrors[index] = ctx.Err()
				return
			}
			zh, err := s.requestZhTranslation(ctx, task.text, runtime)
			if err != nil {
				taskErrors[index] = err
				return
			}
			if zh == "" {
				return
			}
			if _, ok := targets[task.hash]; !ok {
				return
			}
			mu.Lock()
			translated[task.hash] = zh
			mu.Unlock()
			if err := insightsCacheSetString(ctx, s.cache, insightsTranslationCacheKey(task.hash), zh, insightsTranslationCacheTTL); err != nil {
				taskErrors[index] = err
			}
		}()
	}
	wg.Wait()
	for _, err := range taskErrors {
		if err != nil {
			return nil, err
		}
	}
	return translated, nil
}

func insightsCacheGetInto(ctx context.Context, cache insightsCache, key string, target *string) (bool, error) {
	raw, found, err := cache.get(ctx, key)
	if err != nil || !found {
		return false, err
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return false, nil
	}
	return true, json.Unmarshal([]byte(raw), target)
}

func insightsCacheSetString(ctx context.Context, cache insightsCache, key, value string, ttl time.Duration) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return cache.set(ctx, key, payload, ttl)
}

func insightsTranslationCacheKey(hash string) string {
	return insightsTranslationCachePrefix + ":" + hash
}

func translationHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func assertTranslationConfig(runtime insightsTranslationRuntime) error {
	if !runtime.Enabled && !runtime.FallbackEnabled {
		return errors.New("Translation APIs are disabled")
	}
	if canUseDeepLX(runtime) || canUseFallback(runtime) {
		return nil
	}
	deepLXError := deepLXConfigError(runtime)
	fallbackError := fallbackConfigError(runtime)
	if deepLXError != "" && fallbackError != "" {
		return fmt.Errorf("%s; %s", deepLXError, fallbackError)
	}
	if deepLXError != "" {
		return errors.New(deepLXError)
	}
	if fallbackError != "" {
		return errors.New(fallbackError)
	}
	return errors.New("No translation API is available")
}

func canUseDeepLX(runtime insightsTranslationRuntime) bool {
	return runtime.Enabled && strings.TrimSpace(runtime.BaseURL) != "" && strings.TrimSpace(runtime.APIKey) != ""
}

func canUseFallback(runtime insightsTranslationRuntime) bool {
	return runtime.FallbackEnabled && strings.TrimSpace(runtime.FallbackBaseURL) != ""
}

func deepLXConfigError(runtime insightsTranslationRuntime) string {
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

func fallbackConfigError(runtime insightsTranslationRuntime) string {
	if !runtime.FallbackEnabled {
		return "Fallback translation API is disabled"
	}
	if strings.TrimSpace(runtime.FallbackBaseURL) == "" {
		return "Fallback translation API base URL is not configured"
	}
	return ""
}

func (s *insightsService) requestZhTranslation(ctx context.Context, text string, runtime insightsTranslationRuntime) (string, error) {
	deepLXError := ""
	if canUseDeepLX(runtime) {
		translated, err := s.requestViaDeepLX(ctx, text, runtime)
		if err == nil {
			return translated, nil
		}
		deepLXError = err.Error()
	} else {
		deepLXError = deepLXConfigError(runtime)
	}
	if !canUseFallback(runtime) {
		if deepLXError != "" {
			return "", errors.New(deepLXError)
		}
		if message := fallbackConfigError(runtime); message != "" {
			return "", errors.New(message)
		}
		return "", errors.New("No translation API is available")
	}
	sourceLang := detectFallbackSourceLang(text)
	if sourceLang == "zh-CN" {
		return text, nil
	}
	if sourceLang == "" {
		skipped := "Fallback translation API skipped: unsupported source language"
		if deepLXError != "" {
			return "", fmt.Errorf("%s; %s", deepLXError, skipped)
		}
		return "", errors.New(skipped)
	}
	translated, err := s.requestViaFallback(ctx, text, sourceLang, runtime)
	if err != nil {
		if deepLXError != "" {
			return "", fmt.Errorf("%s; %s", deepLXError, err.Error())
		}
		return "", err
	}
	return translated, nil
}

func (s *insightsService) requestViaDeepLX(ctx context.Context, text string, runtime insightsTranslationRuntime) (string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(runtime.BaseURL), "/")
	apiKey := strings.TrimSpace(runtime.APIKey)
	if apiKey == "" {
		return "", errors.New("DeepLX translation API key is not configured")
	}
	if baseURL == "" {
		return "", errors.New("DeepLX translation API base URL is not configured")
	}
	endpoint := baseURL + "/" + encodeTranslationPathSegment(apiKey) + "/translate"
	requestBody, _ := json.Marshal(struct {
		Text       string `json:"text"`
		SourceLang string `json:"source_lang"`
		TargetLang string `json:"target_lang"`
	}{Text: text, SourceLang: "auto", TargetLang: "ZH"})
	timeout := maxTranslationTimeout(runtime.TimeoutMS)
	maxAttempts := maxTranslationAttempts(runtime.MaxRetries)
	var lastError error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		body, status, err := s.postJSON(ctx, endpoint, requestBody, timeout)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				lastError = errors.New("DeepLX request timed out")
			} else {
				lastError = fmt.Errorf("%s request failed: %s", "DeepLX", truncateTranslationMessage(err.Error()))
			}
			if attempt < maxAttempts {
				sleepTranslation(ctx, attempt)
				continue
			}
			return "", lastError
		}
		if status < 200 || status >= 300 {
			message := buildTranslationHTTPError("DeepLX", status, body)
			if attempt < maxAttempts && retryableTranslationStatus(status) {
				sleepTranslation(ctx, attempt)
				continue
			}
			return "", errors.New(message)
		}
		code, hasCode := extractTranslationNumericCode(body)
		if hasCode && code != 200 {
			message := buildTranslationCodeError("DeepLX", code, body)
			if attempt < maxAttempts && retryableTranslationStatus(code) {
				sleepTranslation(ctx, attempt)
				continue
			}
			return "", errors.New(message)
		}
		translated := extractDeepLXText(body)
		if translated == "" {
			return "", errors.New("DeepLX response missing translated text")
		}
		return translated, nil
	}
	if lastError != nil {
		return "", lastError
	}
	return "", errors.New("DeepLX request failed")
}

func (s *insightsService) requestViaFallback(ctx context.Context, text, sourceLang string, runtime insightsTranslationRuntime) (string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(runtime.FallbackBaseURL), "/")
	if baseURL == "" {
		return "", errors.New("Fallback translation API base URL is not configured")
	}
	requestBody, _ := json.Marshal(struct {
		SourceLang string   `json:"source_lang"`
		TargetLang string   `json:"target_lang"`
		TextList   []string `json:"text_list"`
	}{SourceLang: sourceLang, TargetLang: "zh-CN", TextList: []string{text}})
	timeout := maxTranslationTimeout(runtime.TimeoutMS)
	maxAttempts := maxTranslationAttempts(runtime.MaxRetries)
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		body, status, err := s.postJSON(ctx, baseURL, requestBody, timeout)
		if err != nil {
			message := fmt.Sprintf("Fallback translation API request failed: %s", truncateTranslationMessage(err.Error()))
			if errors.Is(err, context.DeadlineExceeded) {
				message = "Fallback translation API request timed out"
			}
			if attempt < maxAttempts {
				sleepTranslation(ctx, attempt)
				continue
			}
			return "", errors.New(message)
		}
		if status < 200 || status >= 300 {
			message := buildTranslationHTTPError("Fallback translation API", status, body)
			if attempt < maxAttempts && retryableTranslationStatus(status) {
				sleepTranslation(ctx, attempt)
				continue
			}
			return "", errors.New(message)
		}
		translated := extractFallbackText(body)
		if translated == "" {
			return "", errors.New("Fallback translation API response missing translated text")
		}
		return translated, nil
	}
	return "", errors.New("Fallback translation API request failed")
}

func (s *insightsService) postJSON(ctx context.Context, endpoint string, payload []byte, timeout time.Duration) ([]byte, int, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("content-type", "application/json")
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

func buildTranslationHTTPError(provider string, status int, payload []byte) string {
	detail := extractTranslationErrorDetail(payload)
	if detail != "" {
		return fmt.Sprintf("%s request failed (HTTP %d): %s", provider, status, detail)
	}
	return fmt.Sprintf("%s request failed (HTTP %d)", provider, status)
}

func buildTranslationCodeError(provider string, code int, payload []byte) string {
	detail := extractTranslationErrorDetail(payload)
	if detail != "" {
		return fmt.Sprintf("%s request failed (code %d): %s", provider, code, detail)
	}
	return fmt.Sprintf("%s request failed (code %d)", provider, code)
}

func extractTranslationErrorDetail(payload []byte) string {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(payload, &text); err == nil {
			text = strings.TrimSpace(text)
			if text != "" {
				return truncateTranslationMessage(text)
			}
		}
		return ""
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(payload, &record); err != nil {
		return ""
	}
	for _, key := range []string{"message", "error", "msg", "detail"} {
		raw, ok := record[key]
		if !ok {
			continue
		}
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			if normalized := strings.TrimSpace(text); normalized != "" {
				return truncateTranslationMessage(normalized)
			}
		}
	}
	return ""
}

func extractTranslationNumericCode(payload []byte) (int, bool) {
	var record struct {
		Code *float64 `json:"code"`
	}
	if err := json.Unmarshal(payload, &record); err != nil || record.Code == nil {
		return 0, false
	}
	return int(*record.Code), true
}

func extractDeepLXText(payload []byte) string {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(payload, &text); err == nil {
			return strings.TrimSpace(text)
		}
		return ""
	}
	var record struct {
		Data         json.RawMessage   `json:"data"`
		Translation  json.RawMessage   `json:"translation"`
		Alternatives []json.RawMessage `json:"alternatives"`
	}
	if err := json.Unmarshal(payload, &record); err != nil {
		return ""
	}
	for _, raw := range []json.RawMessage{record.Data, record.Translation} {
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			if normalized := strings.TrimSpace(text); normalized != "" {
				return normalized
			}
		}
	}
	for _, raw := range record.Alternatives {
		var text string
		if err := json.Unmarshal(raw, &text); err == nil {
			if normalized := strings.TrimSpace(text); normalized != "" {
				return normalized
			}
		}
	}
	return ""
}

func extractFallbackText(payload []byte) string {
	var record struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}
	if err := json.Unmarshal(payload, &record); err != nil {
		return ""
	}
	for _, entry := range record.Translations {
		if normalized := strings.TrimSpace(entry.Text); normalized != "" {
			return normalized
		}
	}
	return ""
}

func detectFallbackSourceLang(text string) string {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return ""
	}
	if translationJapanesePattern.MatchString(normalized) {
		return "ja"
	}
	if translationKoreanPattern.MatchString(normalized) {
		return "ko"
	}
	if translationChinesePattern.MatchString(normalized) {
		return "zh-CN"
	}
	lower := strings.ToLower(normalized)
	if translationFrenchAccents.MatchString(normalized) || translationFrenchWords.MatchString(lower) {
		return "fr"
	}
	if translationGermanAccents.MatchString(normalized) || translationGermanWords.MatchString(lower) {
		return "de"
	}
	if translationLatinLetter.MatchString(normalized) {
		return "en"
	}
	return ""
}

func retryableTranslationStatus(status int) bool {
	return status == 408 || status == 429 || status >= 500
}

func maxTranslationTimeout(value int) time.Duration {
	if value < 1000 {
		value = 1000
	}
	return time.Duration(value) * time.Millisecond
}

func maxTranslationAttempts(retries int) int {
	if retries < 0 {
		retries = 0
	}
	return retries + 1
}

func sleepTranslation(ctx context.Context, attempt int) {
	timer := time.NewTimer(time.Duration(300*attempt) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func truncateTranslationMessage(message string) string {
	if len(message) > 200 {
		return message[:200] + "..."
	}
	return message
}

func encodeTranslationPathSegment(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

// applyTranslationMap mirrors applyTranslationMap, including the rule that
// keyPointsZh is only attached when at least one point was translated.
func applyTranslationMap(response *insightsResponse, translated map[string]string) {
	translateText := func(text string) (string, bool) {
		normalized := strings.TrimSpace(text)
		if normalized == "" {
			return "", false
		}
		value, ok := translated[translationHash(normalized)]
		return value, ok && value != ""
	}
	translateKeyPoints := func(points []string) ([]string, bool) {
		if points == nil {
			return nil, false
		}
		out := make([]string, 0, len(points))
		any := false
		for _, point := range points {
			normalized := strings.TrimSpace(point)
			if normalized == "" {
				continue
			}
			if zh, ok := translateText(normalized); ok {
				any = true
				out = append(out, zh)
			} else {
				out = append(out, normalized)
			}
		}
		if !any {
			return nil, false
		}
		return out, true
	}
	applyHeadline := func(headline *analysis.Headline) {
		if zh, ok := translateText(headline.Title); ok {
			headline.TitleZh = zh
		}
		if zh, ok := translateText(headline.Summary); ok {
			headline.SummaryZh = zh
		}
		if points, ok := translateKeyPoints(headline.KeyPoints); ok {
			headline.KeyPointsZh = points
		}
	}
	applyRefTitle := func(ref *analysis.HeadlineRef) {
		if zh, ok := translateText(ref.Title); ok {
			ref.TitleZh = zh
		}
	}
	applySignalHeadline := func(ref *analysis.SignalHeadline) {
		if zh, ok := translateText(ref.Title); ok {
			ref.TitleZh = zh
		}
	}
	applyName := func(name string) string {
		zh, _ := translateText(name)
		return zh
	}

	if response.Headlines != nil {
		for _, category := range analysis.Categories {
			bucket := response.Headlines.Bucket(category)
			if bucket == nil {
				continue
			}
			for index := range *bucket {
				applyHeadline(&(*bucket)[index])
			}
		}
	}
	if response.Clusters != nil {
		for _, category := range analysis.Categories {
			bucket := response.Clusters.Bucket(category)
			if bucket == nil {
				continue
			}
			for index := range *bucket {
				applyHeadline(&(*bucket)[index].Lead)
				for itemIndex := range (*bucket)[index].Items {
					applyHeadline(&(*bucket)[index].Items[itemIndex])
				}
			}
		}
	}
	if response.Alerts != nil {
		for index := range *response.Alerts {
			applyHeadline(&(*response.Alerts)[index].Headline)
		}
	}
	if response.Leaders != nil {
		for leaderIndex := range *response.Leaders {
			for headlineIndex := range (*response.Leaders)[leaderIndex].Headlines {
				applyRefTitle(&(*response.Leaders)[leaderIndex].Headlines[headlineIndex])
			}
		}
	}
	if response.Situations != nil {
		for panelIndex := range *response.Situations {
			panel := &(*response.Situations)[panelIndex]
			if zh, ok := translateText(panel.Title); ok {
				panel.TitleZh = zh
			}
			if zh, ok := translateText(panel.Subtitle); ok {
				panel.SubtitleZh = zh
			}
			for headlineIndex := range panel.Headlines {
				applyRefTitle(&panel.Headlines[headlineIndex])
			}
		}
	}
	if response.Fed != nil {
		for index := range response.Fed.News {
			entry := &response.Fed.News[index]
			if zh, ok := translateText(entry.Title); ok {
				entry.TitleZh = zh
			}
			if zh, ok := translateText(entry.Description); ok {
				entry.DescriptionZh = zh
			}
			if zh, ok := translateText(entry.TypeLabel); ok {
				entry.TypeLabelZh = zh
			}
		}
	}
	if response.Correlation != nil && response.Correlation.Value != nil {
		correlation := response.Correlation.Value
		for index := range correlation.EmergingPatterns {
			if zh := applyName(correlation.EmergingPatterns[index].Name); zh != "" {
				correlation.EmergingPatterns[index].NameZh = zh
			}
			for headlineIndex := range correlation.EmergingPatterns[index].Headlines {
				applySignalHeadline(&correlation.EmergingPatterns[index].Headlines[headlineIndex])
			}
		}
		for index := range correlation.MomentumSignals {
			if zh := applyName(correlation.MomentumSignals[index].Name); zh != "" {
				correlation.MomentumSignals[index].NameZh = zh
			}
			for headlineIndex := range correlation.MomentumSignals[index].Headlines {
				applySignalHeadline(&correlation.MomentumSignals[index].Headlines[headlineIndex])
			}
		}
		for index := range correlation.CrossSourceCorrelations {
			if zh := applyName(correlation.CrossSourceCorrelations[index].Name); zh != "" {
				correlation.CrossSourceCorrelations[index].NameZh = zh
			}
			for headlineIndex := range correlation.CrossSourceCorrelations[index].Headlines {
				applySignalHeadline(&correlation.CrossSourceCorrelations[index].Headlines[headlineIndex])
			}
		}
		for index := range correlation.PredictiveSignals {
			if zh := applyName(correlation.PredictiveSignals[index].Name); zh != "" {
				correlation.PredictiveSignals[index].NameZh = zh
			}
			if zh, ok := translateText(correlation.PredictiveSignals[index].Prediction); ok {
				correlation.PredictiveSignals[index].PredictionZh = zh
			}
			for headlineIndex := range correlation.PredictiveSignals[index].Headlines {
				applySignalHeadline(&correlation.PredictiveSignals[index].Headlines[headlineIndex])
			}
		}
	}
	if response.CorrelationSummary != nil {
		if zh, ok := translateText(response.CorrelationSummary.Status); ok {
			response.CorrelationSummary.StatusZh = zh
		}
	}
	if response.Narrative != nil && response.Narrative.Value != nil {
		narrative := response.Narrative.Value
		applyNarrative := func(entry *analysis.NarrativeData) {
			if zh := applyName(entry.Name); zh != "" {
				entry.NameZh = zh
			}
			for index := range entry.Headlines {
				if zh, ok := translateText(entry.Headlines[index].Title); ok {
					entry.Headlines[index].TitleZh = zh
				}
			}
		}
		for index := range narrative.EmergingFringe {
			applyNarrative(&narrative.EmergingFringe[index].NarrativeData)
		}
		for index := range narrative.FringeToMainstream {
			applyNarrative(&narrative.FringeToMainstream[index].NarrativeData)
		}
		for index := range narrative.NarrativeWatch {
			applyNarrative(&narrative.NarrativeWatch[index])
		}
		for index := range narrative.DisinfoSignals {
			applyNarrative(&narrative.DisinfoSignals[index])
		}
	}
	if response.NarrativeSummary != nil {
		if zh, ok := translateText(response.NarrativeSummary.Status); ok {
			response.NarrativeSummary.StatusZh = zh
		}
	}
	if response.MainCharacterSummary != nil {
		if zh, ok := translateText(response.MainCharacterSummary.Status); ok {
			response.MainCharacterSummary.StatusZh = zh
		}
	}
}
