package crawlexecution

// This file ports apps/api/src/modules/crawl/crawl-anti-bot.service.ts:
// runCrawlWithHeadedFallback, retryForBotChallengeIfNeeded (challenge detection,
// hardened retry profile, warmup, candidate selection) and the empty-markdown
// fallback profiles.

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

const (
	antiBotRetryAttempts  = 3
	antiBotWarmupURLLimit = 4
)

// botChallengeInput is retryForBotChallengeIfNeeded's option object.
type botChallengeInput struct {
	Task             *taskRow
	OrgID            string
	Options          normalizedOptions
	Response         crawl4ai.PipelineResponse
	Successes        []crawl4ai.PipelineArticle
	Failures         []Failure
	LowSignal        []crawl4ai.PipelineArticle
	RequestTimeoutMs int
}

// fallbackProfile is buildEmptyMarkdownFallbackProfiles' entry.
type fallbackProfile struct {
	Label   string
	Options normalizedOptions
	Summary map[string]any
}

// antiBotCandidate is CrawlRetryCandidate.
type antiBotCandidate struct {
	FromRetry             bool
	Response              crawl4ai.PipelineResponse
	Successes             []crawl4ai.PipelineArticle
	Failures              []Failure
	LowSignal             []crawl4ai.PipelineArticle
	Options               normalizedOptions
	QualityScore          float64
	ChallengeFailureCount int
}

// runCrawlWithHeadedFallback is runCrawlWithHeadedFallback: when headless=false
// fails with a display-dependency error the request is retried once with
// headless=true.
func (s *Service) runCrawlWithHeadedFallback(ctx context.Context, call crawlCall) (crawlRun, error) {
	if call.RequestTimeoutMs > 0 {
		call.Request.RequestTimeoutMs = call.RequestTimeoutMs
	}
	call.Request.Options = call.Options
	response, err := s.executePipelineCrawl(ctx, call.Request)
	if err == nil {
		return partitionCrawlRun(response, call.Options), nil
	}
	if !shouldFallbackToHeadless(call.Options, err) {
		return crawlRun{}, err
	}
	fallbackOptions := s.normalizer().Normalize(withHeadless(optionsToInput(call.Options), true))
	fallbackRequest := call.Request
	fallbackRequest.Options = fallbackOptions
	response, err = s.executePipelineCrawl(ctx, fallbackRequest)
	if err != nil {
		return crawlRun{}, err
	}
	return partitionCrawlRun(response, fallbackOptions), nil
}

func (s *Service) executePipelineCrawl(ctx context.Context, payload requestPayload) (crawl4ai.PipelineResponse, error) {
	request := crawl4ai.PipelineRequest{
		URL:              payload.URL,
		URLs:             payload.URLs,
		Keywords:         payload.Keywords,
		Options:          crawlOptionsForRequest(payload.Options),
		RequestTimeoutMs: payload.RequestTimeoutMs,
	}
	return s.client.CrawlPipeline(ctx, request, s.crawlClientSettings(ctx))
}

// crawlClientSettings loads the shared crawl_client:settings values the crawl
// client needs.
func (s *Service) crawlClientSettings(ctx context.Context) crawl4ai.Settings {
	settings := crawl4ai.DefaultSettings()
	if s.settings == nil {
		return settings
	}
	normalized := s.settings.ReadNormalized(ctx)
	if normalized.Settings.RequestTimeoutNormalMs > 0 {
		settings.RequestTimeoutNormalMs = normalized.Settings.RequestTimeoutNormalMs
	}
	if normalized.Settings.HealthCheckTTLMs > 0 {
		settings.HealthCheckTTLMs = normalized.Settings.HealthCheckTTLMs
	}
	return settings
}

// normalizer builds the option normalizer for the configured crawl base URL.
func (s *Service) normalizer() *crawloptions.Normalizer {
	return crawloptions.NewNormalizer(s.cfg.CrawlBaseURL)
}

// withHeadless sets the headless override on an options input.
func withHeadless(input *crawloptions.OptionsInput, headless bool) *crawloptions.OptionsInput {
	input.Headless = boolPtr(headless)
	return input
}

// shouldFallbackToHeadless is shouldFallbackToHeadless.
func shouldFallbackToHeadless(options normalizedOptions, err error) bool {
	if options.Headless == nil || *options.Headless {
		return false
	}
	return isDisplayDependencyErrorMessage(extractCrawlErrorMessage(err))
}

// isDisplayDependencyErrorMessage is isDisplayDependencyErrorMessage.
func isDisplayDependencyErrorMessage(message string) bool {
	normalized := strings.ToLower(strings.TrimSpace(message))
	if normalized == "" {
		return false
	}
	if strings.Contains(normalized, "cannot open display") ||
		strings.Contains(normalized, "missing x server") ||
		strings.Contains(normalized, "display/xvfb") ||
		strings.Contains(normalized, "$display") {
		return true
	}
	if strings.Contains(normalized, "display") && strings.Contains(normalized, "not available") {
		return true
	}
	if strings.Contains(normalized, "display") && strings.Contains(normalized, "failed") {
		return true
	}
	if strings.Contains(normalized, "xvfb") &&
		(strings.Contains(normalized, "display") || strings.Contains(normalized, "x server") ||
			strings.Contains(normalized, "not available") || strings.Contains(normalized, "failed to start")) {
		return true
	}
	if strings.Contains(normalized, "x11") && strings.Contains(normalized, "display") {
		return true
	}
	return strings.Contains(normalized, "headless=false") && strings.Contains(normalized, "display")
}

// extractCrawlErrorMessage is extractCrawlErrorMessage.
func extractCrawlErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}

// partitionCrawlRun projects one response into the partitioned result sets.
func partitionCrawlRun(response crawl4ai.PipelineResponse, options normalizedOptions) crawlRun {
	partition := partitionCrawlerResults(response.Results)
	return crawlRun{
		Response:  response,
		Options:   options,
		Successes: partition.Successes,
		Failures:  partition.Failures,
		LowSignal: partition.LowSignalCandidates,
	}
}

// classifyResult is classifyResult: HTTP errors, bot challenge pages and
// low-signal markdown become failures/low-signal; the inline and metadata
// success flags resolve the remaining entries.
func classifyResult(article crawl4ai.PipelineArticle) (kind string, hasMarkdown bool, lowSignalMarkdown bool, challenge bool, statusCode *int) {
	markdown := extractMarkdownResult(article.Markdown)
	primary := ""
	if markdown.Primary != nil {
		primary = strings.TrimSpace(*markdown.Primary)
	}
	hasMarkdown = primary != ""
	lowSignalMarkdown = true
	if hasMarkdown {
		lowSignalMarkdown = isLowSignalMarkdown(primary)
	}
	statusCode = extractResultStatusCode(article)
	challenge = primary != "" && isLikelyBotChallengeMarkdown(primary)

	if statusCode != nil && *statusCode >= 400 {
		return "failure", hasMarkdown, lowSignalMarkdown, challenge, statusCode
	}
	if challenge {
		return "failure", hasMarkdown, lowSignalMarkdown, challenge, statusCode
	}
	if lowSignalMarkdown {
		return "low_signal", hasMarkdown, lowSignalMarkdown, challenge, statusCode
	}
	if article.Success != nil {
		if *article.Success && hasMarkdown {
			return "success", hasMarkdown, lowSignalMarkdown, challenge, statusCode
		}
		return "failure", hasMarkdown, lowSignalMarkdown, challenge, statusCode
	}
	if inline, ok := pickMetadataBool(article.Metadata, "success", "isSuccess", "ok"); ok {
		if inline && hasMarkdown {
			return "success", hasMarkdown, lowSignalMarkdown, challenge, statusCode
		}
		return "failure", hasMarkdown, lowSignalMarkdown, challenge, statusCode
	}
	if hasMarkdown {
		return "success", hasMarkdown, lowSignalMarkdown, challenge, statusCode
	}
	return "failure", hasMarkdown, lowSignalMarkdown, challenge, statusCode
}

// extractResultStatusCode is extractStatusCode: the inline status code first,
// then the metadata variants.
func extractResultStatusCode(article crawl4ai.PipelineArticle) *int {
	if article.StatusCode != nil {
		return article.StatusCode
	}
	return pickMetadataInt(article.Metadata, "statusCode", "status_code", "status")
}

func extractResultErrorMessage(article crawl4ai.PipelineArticle) string {
	for _, key := range []string{"error", "errorMessage", "error_message", "message"} {
		if value := pickMetadataString(article.Metadata, key); value != "" {
			return value
		}
	}
	return article.Error
}

// buildFailureDetail is buildFailureDetail.
func buildFailureDetail(article crawl4ai.PipelineArticle) Failure {
	_, hasMarkdown, lowSignalMarkdown, challenge, statusCode := classifyResult(article)
	errorMessage := extractResultErrorMessage(article)
	fallback := defaultFailureMessage(hasMarkdown, statusCode, challenge, lowSignalMarkdown)
	message := errorMessage
	if message == "" {
		message = fallback
	}
	return Failure{
		URL:        article.URL,
		Message:    message,
		StatusCode: statusCode,
		Retryable:  isRetryableStatus(statusCode, message),
	}
}

// defaultFailureMessage is buildDefaultFailureMessage.
func defaultFailureMessage(hasMarkdown bool, statusCode *int, challenge, lowSignalMarkdown bool) string {
	if challenge {
		if statusCode != nil {
			return fmt.Sprintf("crawl4ai received HTTP %d and captured an anti-bot verification page instead of article content.", *statusCode)
		}
		return "crawl4ai captured an anti-bot verification page instead of article content."
	}
	if statusCode != nil && *statusCode >= 400 {
		if *statusCode == 401 || *statusCode == 403 {
			return fmt.Sprintf("crawl4ai received HTTP %d; target may be blocked by anti-bot or require verification/login.", *statusCode)
		}
		return fmt.Sprintf("crawl4ai received HTTP %d from target URL.", *statusCode)
	}
	if hasMarkdown {
		if lowSignalMarkdown {
			return "crawl4ai returned low-signal markdown (reference-only/placeholder content). Triggering fallback and detail expansion."
		}
		return "Unknown crawl error"
	}
	return "crawl4ai returned an empty markdown result. Check wordCountThreshold/cssSelector/cleanMarkdown and pruning settings."
}

// retryForBotChallengeIfNeeded is retryForBotChallengeIfNeeded. It returns nil
// when the baseline response is kept.
func (s *Service) retryForBotChallengeIfNeeded(ctx context.Context, input botChallengeInput) *crawlRun {
	if len(input.Failures) == 0 {
		return nil
	}
	antiBotMode := input.Options.AntiBotMode
	if antiBotMode == "" {
		antiBotMode = "auto"
	}
	if antiBotMode == "disabled" {
		return nil
	}
	initialChallengeCount := countBotChallengeFailures(input.Failures)
	forceRetry := antiBotMode == "enabled"
	if !forceRetry && initialChallengeCount == 0 {
		return nil
	}
	retryStartReason := "challenge_detected"
	retryStartMessage := "Detected anti-bot challenge; retrying with hardened stealth profile"
	if forceRetry && initialChallengeCount == 0 {
		retryStartReason = "anti_bot_mode_enabled"
		retryStartMessage = "Anti-bot mode enabled; retrying with hardened stealth profile"
	}

	baseRetryOptions := s.buildHardenedAntiBotOptions(input.Options, input.Task.TargetURL)
	warmedOptions, warmupSummary := s.runAntiBotWarmupIfNeeded(ctx, input, baseRetryOptions)

	candidates := make([]antiBotCandidate, 0, antiBotRetryAttempts+1)
	attemptSummaries := make([]map[string]any, 0, antiBotRetryAttempts)
	hasCompletedAttempt := false
	for attempt := 1; attempt <= antiBotRetryAttempts; attempt++ {
		attemptOptions := s.buildAntiBotAttemptOptions(warmedOptions, input.Task.TargetURL, attempt)
		payload := s.buildRequestPayload(input.Task, s.normalizer(), attemptOptions)
		run, err := s.runCrawlWithHeadedFallback(ctx, crawlCall{
			Request:          payload,
			Options:          payload.Options,
			RequestTimeoutMs: input.RequestTimeoutMs,
			TaskID:           input.Task.ID,
			OrgID:            input.OrgID,
			Stage:            "anti_bot_retry",
			Reason:           fmt.Sprintf("retry_attempt_%d", attempt),
		})
		if err != nil {
			attemptSummaries = append(attemptSummaries, map[string]any{
				"attempt":     attempt,
				"result":      "failed",
				"maxAttempts": antiBotRetryAttempts,
				"error":       nullableError(extractCrawlErrorMessage(err)),
				"options":     summarizeAntiBotOptions(attemptOptions),
			})
			if attempt < antiBotRetryAttempts {
				sleepWithContext(ctx, antiBotAttemptDelay(attempt))
			}
			continue
		}
		hasCompletedAttempt = true
		challengeCount := countBotChallengeFailures(run.Failures)
		quality := scoreMarkdownQuality(run.Successes)
		candidates = append(candidates, antiBotCandidate{
			FromRetry:             true,
			Response:              run.Response,
			Successes:             run.Successes,
			Failures:              run.Failures,
			LowSignal:             run.LowSignal,
			Options:               run.Options,
			QualityScore:          quality,
			ChallengeFailureCount: challengeCount,
		})
		attemptSummaries = append(attemptSummaries, map[string]any{
			"attempt":             attempt,
			"result":              "completed",
			"maxAttempts":         antiBotRetryAttempts,
			"successes":           len(run.Successes),
			"failures":            len(run.Failures),
			"lowSignalCandidates": len(run.LowSignal),
			"challengeFailures":   challengeCount,
			"qualityScore":        roundTo(quality, 3),
			"runId":               nullableRunID(run.Response.RunID),
			"options":             summarizeAntiBotOptions(attemptOptions),
		})
		if len(run.Successes) > 0 && challengeCount == 0 {
			break
		}
		if attempt < antiBotRetryAttempts && challengeCount > 0 {
			sleepWithContext(ctx, antiBotAttemptDelay(attempt))
		}
	}

	baseline := antiBotCandidate{
		FromRetry:             false,
		Response:              input.Response,
		Successes:             input.Successes,
		Failures:              input.Failures,
		LowSignal:             input.LowSignal,
		Options:               input.Options,
		QualityScore:          scoreMarkdownQuality(input.Successes),
		ChallengeFailureCount: initialChallengeCount,
	}
	pool := make([]antiBotCandidate, 0, len(candidates)+1)
	pool = append(pool, baseline)
	pool = append(pool, candidates...)
	selected := selectBestAntiBotCandidate(pool)
	status := "failed"
	if hasCompletedAttempt {
		status = "completed"
	}
	selectedFromRetry := selected != nil && selected.FromRetry
	message := retryStartMessage
	if selectedFromRetry {
		message = "Selected anti-bot retry candidate"
	} else if hasCompletedAttempt {
		message = "Anti-bot retry completed; kept baseline crawl response"
	}
	s.writeTaskLog(ctx, taskLogEntry{
		Queue:   crawlQueueName,
		JobID:   input.Task.ID,
		OrgID:   input.OrgID,
		Stage:   "anti_bot_retry",
		Status:  status,
		Message: stringPtr(message),
		Data: map[string]any{
			"reason":                    retryStartReason,
			"initialFailures":           len(input.Failures),
			"initialChallengeFailures":  initialChallengeCount,
			"attempts":                  antiBotRetryAttempts,
			"warmup":                    warmupSummary,
			"selectedFromRetry":         selectedFromRetry,
			"selectedSuccesses":         selectedSuccessCount(selected),
			"selectedFailures":          selectedFailureCount(selected),
			"selectedChallengeFailures": selectedChallengeFailureCount(selected),
			"selectedQualityScore":      selectedQualityScore(selected),
			"baselineSuccesses":         len(baseline.Successes),
			"baselineFailures":          len(baseline.Failures),
			"baselineChallengeFailures": baseline.ChallengeFailureCount,
			"baselineQualityScore":      roundTo(baseline.QualityScore, 3),
			"retryCandidates":           len(candidates),
			"attemptSummaries":          attemptSummaries,
		},
	})
	if selected == nil || !selected.FromRetry {
		return nil
	}
	return &crawlRun{
		Response:  selected.Response,
		Options:   selected.Options,
		Successes: selected.Successes,
		Failures:  selected.Failures,
		LowSignal: selected.LowSignal,
	}
}

func selectedSuccessCount(selected *antiBotCandidate) int {
	if selected == nil {
		return 0
	}
	return len(selected.Successes)
}

func selectedFailureCount(selected *antiBotCandidate) int {
	if selected == nil {
		return 0
	}
	return len(selected.Failures)
}

func selectedChallengeFailureCount(selected *antiBotCandidate) int {
	if selected == nil {
		return 0
	}
	return selected.ChallengeFailureCount
}

func selectedQualityScore(selected *antiBotCandidate) any {
	if selected == nil {
		return nil
	}
	return roundTo(selected.QualityScore, 3)
}

func nullableError(message string) any {
	if message == "" {
		return nil
	}
	return message
}

func roundTo(value float64, digits int) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	factor := math.Pow(10, float64(digits))
	return math.Round(value*factor) / factor
}

// selectBestAntiBotCandidate is selectBestAntiBotRetryCandidate (stable sort on
// the NestJS comparator).
func selectBestAntiBotCandidate(candidates []antiBotCandidate) *antiBotCandidate {
	if len(candidates) == 0 {
		return nil
	}
	sorted := make([]antiBotCandidate, len(candidates))
	copy(sorted, candidates)
	for left := 0; left < len(sorted); left++ {
		for right := left + 1; right < len(sorted); right++ {
			if lessAntiBotCandidate(sorted[right], sorted[left]) {
				sorted[left], sorted[right] = sorted[right], sorted[left]
			}
		}
	}
	return &sorted[0]
}

func lessAntiBotCandidate(left, right antiBotCandidate) bool {
	if left.ChallengeFailureCount != right.ChallengeFailureCount {
		return left.ChallengeFailureCount < right.ChallengeFailureCount
	}
	if len(left.Successes) != len(right.Successes) {
		return len(left.Successes) > len(right.Successes)
	}
	if left.QualityScore != right.QualityScore {
		return left.QualityScore > right.QualityScore
	}
	if len(left.Failures) != len(right.Failures) {
		return len(left.Failures) < len(right.Failures)
	}
	if left.FromRetry != right.FromRetry {
		return left.FromRetry
	}
	return false
}

// countBotChallengeFailures is countBotChallengeFailures.
func countBotChallengeFailures(failures []Failure) int {
	count := 0
	for _, failure := range failures {
		if isBotChallengeFailure(failure) {
			count++
		}
	}
	return count
}

// isBotChallengeFailure is isBotChallengeFailure.
func isBotChallengeFailure(failure Failure) bool {
	if failure.StatusCode != nil {
		switch *failure.StatusCode {
		case 401, 403, 429:
			return true
		}
	}
	normalized := strings.ToLower(failure.Message)
	for _, needle := range []string{
		"anti-bot", "verification page", "cloudflare", "captcha", "datadome",
		"verifying the device", "please enable js and disable any ad blocker",
		"デバイスの確認", "access denied", "bot detection",
	} {
		if strings.Contains(normalized, needle) {
			return true
		}
	}
	return false
}

// buildHardenedAntiBotOptions is buildHardenedAntiBotOptions.
func (s *Service) buildHardenedAntiBotOptions(options normalizedOptions, targetURL string) normalizedOptions {
	input := optionsToInput(options)
	input.SessionID = options.SessionID
	input.Headless = boolPtr(false)
	input.EnableUndetectedBrowser = boolPtr(true)
	input.EnableStealthMode = boolPtr(true)
	input.SimulateUser = boolPtr(true)
	input.OverrideNavigator = boolPtr(true)
	if options.UserAgent == nil {
		input.UserAgentMode = stringPtr("random")
	}
	if options.WaitUntil == nil {
		input.WaitUntil = stringPtr("domcontentloaded")
	}
	if options.WaitForScript == nil && options.WaitForSelector == nil {
		waitFor := resolveAntiBotWaitForSelector(targetURL, options.PageTypeHint)
		input.WaitForSelector = &waitFor
	}
	input.WaitForTimeoutMs = maxIntPtr(options.WaitForTimeoutMs, 10_000)
	input.PageTimeoutMs = maxIntPtr(options.PageTimeoutMs, 120_000)
	input.DelayBeforeReturnHTMLMs = maxIntPtr(options.DelayBeforeReturnHTMLMs, 2_000)
	input.MeanDelayMs = maxIntPtr(options.MeanDelayMs, 700)
	input.MaxDelayRangeMs = maxIntPtr(options.MaxDelayRangeMs, 1_400)
	input.ScanFullPage = boolPtr(false)
	if options.VirtualScroll == nil {
		scrollCount := 8
		scrollBy := `"page_height"`
		waitAfterScroll := 700
		input.VirtualScroll = &crawloptions.VirtualScroll{
			ContainerSelector: "body",
			ScrollCount:       &scrollCount,
			ScrollBy:          []byte(scrollBy),
			WaitAfterScrollMs: &waitAfterScroll,
		}
	}
	return s.normalizer().Normalize(input)
}

// buildAntiBotAttemptOptions is buildAntiBotAttemptOptions.
func (s *Service) buildAntiBotAttemptOptions(options normalizedOptions, targetURL string, attempt int) normalizedOptions {
	clamped := attempt
	if clamped < 1 {
		clamped = 1
	}
	if clamped > 6 {
		clamped = 6
	}
	input := optionsToInput(options)
	if options.WaitForScript == nil {
		if clamped >= 3 {
			input.WaitForSelector = nil
		} else if options.WaitForSelector != nil {
			value := *options.WaitForSelector
			input.WaitForSelector = &value
		} else {
			waitFor := resolveAntiBotWaitForSelector(targetURL, options.PageTypeHint)
			input.WaitForSelector = &waitFor
		}
	} else {
		input.WaitForSelector = nil
	}
	waitUntil := "load"
	if clamped < 2 {
		if options.WaitUntil != nil {
			waitUntil = *options.WaitUntil
		} else {
			waitUntil = "domcontentloaded"
		}
	}
	input.WaitUntil = &waitUntil
	input.WaitForTimeoutMs = maxIntPtr(options.WaitForTimeoutMs, 10_000+(clamped-1)*4_000)
	input.PageTimeoutMs = maxIntPtr(options.PageTimeoutMs, 120_000+(clamped-1)*10_000)
	input.DelayBeforeReturnHTMLMs = maxIntPtr(options.DelayBeforeReturnHTMLMs, 2_000+(clamped-1)*350)
	input.MeanDelayMs = maxIntPtr(options.MeanDelayMs, 700+(clamped-1)*120)
	input.MaxDelayRangeMs = maxIntPtr(options.MaxDelayRangeMs, 1_400+(clamped-1)*140)
	return s.normalizer().Normalize(input)
}

func maxIntPtr(value *int, minimum int) *int {
	result := minimum
	if value != nil && *value > result {
		result = *value
	}
	return &result
}

// antiBotAttemptDelay is resolveAntiBotAttemptDelayMs.
func antiBotAttemptDelay(attempt int) time.Duration {
	clamped := attempt
	if clamped < 1 {
		clamped = 1
	}
	if clamped > 6 {
		clamped = 6
	}
	delay := 900 + (clamped-1)*850
	if delay > 4_000 {
		delay = 4_000
	}
	return time.Duration(delay) * time.Millisecond
}

// summarizeAntiBotOptions is summarizeAntiBotOptions.
func summarizeAntiBotOptions(options normalizedOptions) map[string]any {
	return map[string]any{
		"sessionId":               nullableStringValue(options.SessionID),
		"antiBotMode":             nullableStringValue(stringPtrOrNil(options.AntiBotMode)),
		"headless":                nullableBoolValue(options.Headless),
		"enableUndetectedBrowser": options.EnableUndetectedBrowser,
		"enableStealthMode":       options.EnableStealthMode,
		"simulateUser":            options.SimulateUser,
		"overrideNavigator":       options.OverrideNavigator,
		"userAgentMode":           nullableStringValue(options.UserAgentMode),
		"waitUntil":               nullableStringValue(options.WaitUntil),
		"waitForSelector":         nullableStringValue(options.WaitForSelector),
		"waitForTimeoutMs":        intPtrValue(options.WaitForTimeoutMs),
		"pageTimeoutMs":           intPtrValue(options.PageTimeoutMs),
		"delayBeforeReturnHtmlMs": intPtrValue(options.DelayBeforeReturnHTMLMs),
	}
}

func stringPtrOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func nullableBoolValue(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

// runAntiBotWarmupIfNeeded is runAntiBotWarmupIfNeeded. It crawls same-site
// section pages first so the shared browser session carries cookies.
func (s *Service) runAntiBotWarmupIfNeeded(ctx context.Context, input botChallengeInput, options normalizedOptions) (normalizedOptions, map[string]any) {
	warmupURLs := buildAntiBotWarmupURLs(input.Task.TargetURL)
	if len(warmupURLs) == 0 {
		return options, nil
	}
	warmupInput := optionsToInput(options)
	warmupInput.CacheMode = stringPtr("bypass")
	warmupInput.WaitForScript = nil
	warmupSelector := "main"
	warmupInput.WaitForSelector = &warmupSelector
	warmupPageType := "list"
	warmupInput.PageTypeHint = &warmupPageType
	warmupOptions := s.normalizer().Normalize(warmupInput)
	payload := s.buildRequestPayload(input.Task, s.normalizer(), warmupOptions)
	payload.URLs = warmupURLs
	run, err := s.runCrawlWithHeadedFallback(ctx, crawlCall{
		Request:          payload,
		Options:          warmupOptions,
		RequestTimeoutMs: input.RequestTimeoutMs,
		TaskID:           input.Task.ID,
		OrgID:            input.OrgID,
		Stage:            "anti_bot_retry",
		Reason:           "session_warmup",
	})
	if err != nil {
		return options, map[string]any{
			"result":     "failed",
			"warmupUrls": warmupURLs,
			"count":      len(warmupURLs),
			"sessionId":  nullableStringValue(warmupOptions.SessionID),
			"error":      nullableError(extractCrawlErrorMessage(err)),
		}
	}
	return options, map[string]any{
		"result":            "completed",
		"warmupUrls":        warmupURLs,
		"count":             len(warmupURLs),
		"sessionId":         nullableStringValue(warmupOptions.SessionID),
		"runId":             nullableRunID(run.Response.RunID),
		"successes":         len(run.Successes),
		"failures":          len(run.Failures),
		"challengeFailures": countBotChallengeFailures(run.Failures),
	}
}

// resolveAntiBotWaitForSelector is resolveAntiBotWaitForSelector.
func resolveAntiBotWaitForSelector(targetURL string, hint *string) string {
	if hint != nil {
		switch *hint {
		case "detail":
			return "article"
		case "list":
			return "main"
		}
	}
	normalized := normalizeComparableURL(targetURL)
	if normalized == "" {
		normalized = targetURL
	}
	if isLikelyDetailArticleURL(normalized, normalized, false, true) {
		return "article"
	}
	return "main"
}

// buildAntiBotWarmupURLs is buildAntiBotWarmupUrls.
func buildAntiBotWarmupURLs(targetURL string) []string {
	parsed, err := url.Parse(targetURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil
	}
	targetNormalized := normalizeComparableURL(targetURL)
	pathSegments := make([]string, 0, 8)
	for _, entry := range strings.Split(strings.TrimRight(parsed.Path, "/"), "/") {
		if entry != "" {
			pathSegments = append(pathSegments, entry)
		}
	}
	candidates := make([]string, 0, antiBotWarmupURLLimit)
	addCandidate := func(value string) {
		normalized := normalizeComparableURL(value)
		if normalized == "" {
			return
		}
		if targetNormalized != "" && normalized == targetNormalized {
			return
		}
		for _, existing := range candidates {
			if existing == normalized {
				return
			}
		}
		candidates = append(candidates, normalized)
	}
	origin := parsed.Scheme + "://" + parsed.Host
	addCandidate(origin + "/")
	if len(pathSegments) > 0 {
		addCandidate(origin + "/" + pathSegments[0] + "/")
	}
	second := ""
	if len(pathSegments) > 1 {
		second = pathSegments[1]
	}
	if second != "" && isLikelyWarmupSectionSegment(second) {
		addCandidate(origin + "/" + pathSegments[0] + "/" + second + "/")
	}
	third := ""
	if len(pathSegments) > 2 {
		third = pathSegments[2]
	}
	if second != "" && third != "" && isLikelyWarmupSectionSegment(second) && isLikelyWarmupSectionSegment(third) {
		addCandidate(origin + "/" + pathSegments[0] + "/" + second + "/" + third + "/")
	}
	if len(candidates) > antiBotWarmupURLLimit {
		candidates = candidates[:antiBotWarmupURLLimit]
	}
	return candidates
}

// isLikelyWarmupSectionSegment is isLikelyWarmupSectionSegment.
func isLikelyWarmupSectionSegment(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return false
	}
	if _, blocked := blockedDetailPathSegments[normalized]; blocked {
		return false
	}
	if len(normalized) > 24 {
		return false
	}
	for _, r := range normalized {
		if r >= '0' && r <= '9' {
			return false
		}
	}
	parts := 0
	for _, entry := range strings.Split(normalized, "-") {
		if entry != "" {
			parts++
		}
	}
	return parts < 4
}

// shouldAttemptEmptyMarkdownFallback is shouldAttemptEmptyMarkdownFallback.
func (s *Service) shouldAttemptEmptyMarkdownFallback(successes []crawl4ai.PipelineArticle, failures []Failure) bool {
	if len(successes) > 0 || len(failures) == 0 {
		return false
	}
	for _, failure := range failures {
		if !isEmptyMarkdownFailure(failure) {
			return false
		}
	}
	return true
}

// isEmptyMarkdownFailure is isEmptyMarkdownFailure.
func isEmptyMarkdownFailure(failure Failure) bool {
	normalized := strings.ToLower(failure.Message)
	lowSignal := strings.Contains(normalized, "low-signal markdown") ||
		strings.Contains(normalized, "reference-only") ||
		strings.Contains(normalized, "placeholder content")
	return (failure.StatusCode == nil || *failure.StatusCode == 200) &&
		(strings.Contains(normalized, "empty markdown") || lowSignal)
}

// buildEmptyMarkdownFallbackProfiles is buildEmptyMarkdownFallbackProfiles.
func (s *Service) buildEmptyMarkdownFallbackProfiles(options normalizedOptions) []fallbackProfile {
	cleanMarkdown := options.CleanMarkdown
	relaxedClean := &crawloptions.CleanMarkdownInput{
		RemoveOverlayElements: boolPtr(true),
		WordCountThreshold:    intPtrOf(0),
	}
	if cleanMarkdown != nil {
		relaxedClean.ExcludedTags = cleanMarkdown.ExcludedTags
		relaxedClean.TargetElements = cleanMarkdown.TargetElements
		if cleanMarkdown.RemoveOverlayElements != nil {
			relaxedClean.RemoveOverlayElements = cleanMarkdown.RemoveOverlayElements
		}
	}
	citations := true
	if options.MarkdownOptions != nil && options.MarkdownOptions.Citations != nil {
		citations = *options.MarkdownOptions.Citations
	}

	rawRelaxedInput := optionsToInput(options)
	rawRelaxedInput.OnlyMainContent = boolPtr(false)
	rawRelaxedInput.MarkdownFilter = nil
	rawRelaxedInput.MarkdownOptions = fallbackMarkdownOptionsInput(options.MarkdownOptions, "raw_html", citations)
	rawRelaxedInput.CleanMarkdown = relaxedClean
	rawRelaxedInput.CSSSelector = nil
	rawRelaxedInput.WordCountThreshold = intPtrOf(10)
	rawRelaxed := s.normalizer().Normalize(rawRelaxedInput)

	balancedClean := &crawloptions.CleanMarkdownInput{
		RemoveOverlayElements: boolPtr(true),
		WordCountThreshold:    intPtrOf(20),
	}
	if cleanMarkdown != nil {
		balancedClean.ExcludedTags = cleanMarkdown.ExcludedTags
		balancedClean.TargetElements = cleanMarkdown.TargetElements
		if cleanMarkdown.RemoveOverlayElements != nil {
			balancedClean.RemoveOverlayElements = cleanMarkdown.RemoveOverlayElements
		}
		if cleanMarkdown.WordCountThreshold != nil && *cleanMarkdown.WordCountThreshold < 40 {
			balancedClean.WordCountThreshold = intPtrOf(*cleanMarkdown.WordCountThreshold)
		}
	}
	balancedInput := optionsToInput(options)
	balancedInput.OnlyMainContent = boolPtr(false)
	balancedInput.ExtractLinks = boolPtr(true)
	balancedInput.MarkdownFilter = &crawloptions.MarkdownFilter{
		Type:             "pruning",
		ThresholdType:    stringPtr("dynamic"),
		Threshold:        floatPtr(0.2),
		MinWordThreshold: intPtrOf(5),
	}
	balancedInput.MarkdownOptions = fallbackMarkdownOptionsInput(options.MarkdownOptions, "cleaned_html", citations)
	balancedInput.CleanMarkdown = balancedClean
	balancedInput.CSSSelector = nil
	balancedInput.WordCountThreshold = intPtrOf(minIntPtrValue(options.WordCountThreshold, 80, 40))
	balanced := s.normalizer().Normalize(balancedInput)

	linkscanInput := optionsToInput(rawRelaxed)
	linkscanInput.ExtractLinks = boolPtr(true)
	linkscanInput.OnlyMainContent = boolPtr(false)
	linkscanInput.CleanMarkdown = &crawloptions.CleanMarkdownInput{
		ExcludedTags:          relaxedClean.ExcludedTags,
		TargetElements:        relaxedClean.TargetElements,
		RemoveOverlayElements: boolPtr(false),
		WordCountThreshold:    intPtrOf(0),
	}
	linkscanInput.ExcludeExternalLinks = boolPtr(false)
	linkscanInput.MarkdownOptions = markdownOptionsToInput(&crawloptions.MarkdownOptions{
		ContentSource: stringPtr("raw_html"),
		Citations:     boolPtr(citations),
	})
	linkscan := s.normalizer().Normalize(linkscanInput)

	profiles := []fallbackProfile{
		{
			Label:   "raw_relaxed",
			Options: rawRelaxed,
			Summary: map[string]any{
				"contentSource":                   contentSourceOf(rawRelaxed.MarkdownOptions),
				"markdownFilter":                  markdownFilterType(rawRelaxed.MarkdownFilter),
				"wordCountThreshold":              intPtrValue(rawRelaxed.WordCountThreshold),
				"cleanMarkdownWordCountThreshold": cleanMarkdownWordCount(rawRelaxed.CleanMarkdown),
			},
		},
		{
			Label:   "cleaned_balanced",
			Options: balanced,
			Summary: map[string]any{
				"contentSource":                   contentSourceOf(balanced.MarkdownOptions),
				"markdownFilter":                  markdownFilterType(balanced.MarkdownFilter),
				"wordCountThreshold":              intPtrValue(balanced.WordCountThreshold),
				"cleanMarkdownWordCountThreshold": cleanMarkdownWordCount(balanced.CleanMarkdown),
			},
		},
		{
			Label:   "raw_relaxed_linkscan",
			Options: linkscan,
			Summary: map[string]any{
				"contentSource":                   "raw_html",
				"markdownFilter":                  nil,
				"extractLinks":                    true,
				"onlyMainContent":                 false,
				"cleanMarkdownWordCountThreshold": 0,
				"removeOverlayElements":           false,
				"excludeExternalLinks":            false,
			},
		},
	}
	sourceFilter := options.MarkdownFilter
	if sourceFilter != nil && sourceFilter.Type == "bm25" &&
		sourceFilter.UserQuery != nil && strings.TrimSpace(*sourceFilter.UserQuery) != "" {
		bm25Input := optionsToInput(options)
		bm25Input.OnlyMainContent = boolPtr(false)
		bm25Threshold := floatPtr(0.6)
		if sourceFilter.BM25Threshold != nil {
			bm25Threshold = sourceFilter.BM25Threshold
		}
		bm25Input.MarkdownFilter = &crawloptions.MarkdownFilter{
			Type:          "bm25",
			UserQuery:     sourceFilter.UserQuery,
			BM25Threshold: bm25Threshold,
			Language:      sourceFilter.Language,
		}
		bm25Input.MarkdownOptions = markdownOptionsToInput(&crawloptions.MarkdownOptions{
			ContentSource: stringPtr("cleaned_html"),
			Citations:     boolPtr(citations),
		})
		bm25Input.CleanMarkdown = relaxedClean
		bm25Input.CSSSelector = nil
		bm25Input.WordCountThreshold = intPtrOf(minIntPtrValue(options.WordCountThreshold, 80, 30))
		bm25 := s.normalizer().Normalize(bm25Input)
		profiles = append(profiles, fallbackProfile{
			Label:   "bm25_focus",
			Options: bm25,
			Summary: map[string]any{
				"contentSource":                   contentSourceOf(bm25.MarkdownOptions),
				"markdownFilter":                  markdownFilterType(bm25.MarkdownFilter),
				"wordCountThreshold":              intPtrValue(bm25.WordCountThreshold),
				"cleanMarkdownWordCountThreshold": cleanMarkdownWordCount(bm25.CleanMarkdown),
			},
		})
	}
	return profiles
}

// runEmptyMarkdownFallback is the empty-markdown fallback branch of runTask.
func (s *Service) runEmptyMarkdownFallback(ctx context.Context, task *taskRow, orgID string, options normalizedOptions, requestTimeoutMs int) (*crawlRun, error) {
	profiles := s.buildEmptyMarkdownFallbackProfiles(options)
	type fallbackCandidate struct {
		label        string
		run          crawlRun
		qualityScore float64
	}
	candidates := make([]fallbackCandidate, 0, len(profiles))
	attempts := make([]map[string]any, 0, len(profiles))
	var lowSignalRun *crawlRun
	for _, profile := range profiles {
		payload := s.buildRequestPayload(task, s.normalizer(), profile.Options)
		run, err := s.runCrawlWithHeadedFallback(ctx, crawlCall{
			Request:          payload,
			Options:          payload.Options,
			RequestTimeoutMs: requestTimeoutMs,
			TaskID:           task.ID,
			OrgID:            orgID,
			Stage:            "fallback",
			Reason:           "markdown_profile_" + profile.Label,
		})
		if err != nil {
			attempts = append(attempts, map[string]any{
				"profile":  profile.Label,
				"result":   "failed",
				"fallback": profile.Summary,
				"error":    nullableError(extractCrawlErrorMessage(err)),
			})
			continue
		}
		quality := scoreMarkdownQuality(run.Successes)
		if len(run.Successes) > 0 {
			candidates = append(candidates, fallbackCandidate{
				label:        profile.Label,
				run:          run,
				qualityScore: quality,
			})
		} else if len(run.LowSignal) > 0 {
			lowSignalRun = &run
		}
		attempts = append(attempts, map[string]any{
			"profile":             profile.Label,
			"result":              "completed",
			"fallback":            profile.Summary,
			"successes":           len(run.Successes),
			"failures":            len(run.Failures),
			"qualityScore":        roundTo(quality, 3),
			"lowSignalCandidates": len(run.LowSignal),
			"failureSamples":      failureSamples(run.Failures, 5),
		})
	}
	var best *fallbackCandidate
	for index := range candidates {
		if best == nil || candidates[index].qualityScore > best.qualityScore {
			best = &candidates[index]
		}
	}
	completed := 0
	for _, attempt := range attempts {
		if attempt["result"] == "completed" {
			completed++
		}
	}
	status := "failed"
	if completed > 0 {
		status = "completed"
	}
	message := "Markdown fallback failed for all profiles"
	if best != nil {
		message = "Selected markdown fallback profile: " + best.label
	} else if completed > 0 {
		message = "Markdown fallback completed without selecting an improved profile"
	}
	var selectedProfile any
	var selectedQuality any
	selectedSuccesses := 0
	selectedFailures := 0
	if best != nil {
		selectedProfile = best.label
		selectedQuality = roundTo(best.qualityScore, 3)
		selectedSuccesses = len(best.run.Successes)
		selectedFailures = len(best.run.Failures)
	}
	s.writeTaskLog(ctx, taskLogEntry{
		Queue:   crawlQueueName,
		JobID:   task.ID,
		OrgID:   orgID,
		Stage:   "fallback",
		Status:  status,
		Message: stringPtr(message),
		Data: map[string]any{
			"selectedProfile":      selectedProfile,
			"selectedQualityScore": selectedQuality,
			"selectedSuccesses":    selectedSuccesses,
			"selectedFailures":     selectedFailures,
			"attempts":             len(attempts),
			"completedAttempts":    completed,
			"failedAttempts":       len(attempts) - completed,
			"profiles":             attempts,
		},
	})
	if best != nil {
		return &best.run, nil
	}
	return lowSignalRun, nil
}

// fallbackMarkdownOptionsInput spreads the task's markdown options and
// overrides the content source/citations, like the NestJS object spread.
func fallbackMarkdownOptionsInput(base *crawloptions.MarkdownOptions, contentSource string, citations bool) *crawloptions.MarkdownOptionsInput {
	input := markdownOptionsToInput(base)
	if input == nil {
		input = &crawloptions.MarkdownOptionsInput{}
	}
	input.ContentSource = stringPtr(contentSource)
	input.Citations = boolPtr(citations)
	return input
}

func intPtrOf(value int) *int { return &value }

func floatPtr(value float64) *float64 { return &value }

func minIntPtrValue(value *int, fallback, maximum int) int {
	result := fallback
	if value != nil {
		result = *value
	}
	if result > maximum {
		result = maximum
	}
	return result
}

func contentSourceOf(value *crawloptions.MarkdownOptions) any {
	if value == nil || value.ContentSource == nil {
		return nil
	}
	return *value.ContentSource
}

func markdownFilterType(value *crawloptions.MarkdownFilter) any {
	if value == nil {
		return nil
	}
	return value.Type
}

func cleanMarkdownWordCount(value *crawloptions.CleanMarkdown) any {
	if value == nil {
		return nil
	}
	return intPtrValue(value.WordCountThreshold)
}
