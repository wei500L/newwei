package llmgatewayops

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// LB test defaults and limits.
const (
	// defaultLBAttempts is the default attempt count.
	defaultLBAttempts = 8
	// defaultLBConcurrency is the default worker count.
	defaultLBConcurrency = 2
	// lbUnknownLabel fills a missing distribution header.
	lbUnknownLabel = "unknown"
)

// modelDistribution is a typed count map. Go marshals it with sorted keys, which
// keeps the response deterministic; the console only reads the counts.
type modelDistribution map[string]int

// lbTestResult is the LB smoke test summary.
type lbTestResult struct {
	APIBase                  string            `json:"apiBase"`
	Model                    string            `json:"model"`
	Attempts                 int               `json:"attempts"`
	Succeeded                int               `json:"succeeded"`
	Failed                   int               `json:"failed"`
	DurationMS               int               `json:"durationMs"`
	CheckedAt                string            `json:"checkedAt"`
	ModelIDDistribution      modelDistribution `json:"modelIdDistribution"`
	ModelAPIBaseDistribution modelDistribution `json:"modelApiBaseDistribution"`
	CallIDSamples            []string          `json:"callIdSamples"`
	Errors                   []testError       `json:"errors"`
}

// lbAttempt is the outcome of one attempt. Attempts write to their own index of
// a pre-sized slice, so no lock is needed and the aggregation runs once, after
// every worker finished.
type lbAttempt struct {
	succeeded    bool
	modelID      string
	modelAPIBase string
	callID       string
	err          *testError
}

// TestProxyLoadBalancing serves POST /:id/proxy-lb-test.
//
// A small fixed worker pool runs the attempts: at most `concurrency` requests are
// in flight, the shared transport is reused, and the summary is aggregated in ONE
// pass after the pool drains. That keeps succeeded+failed==attempts and the
// distribution/sample limits exact without a shared counter or a mutex.
//
// "HTTP success" is the only success criterion, exactly like the source: the body
// is not inspected, because the test measures routing, not answer quality.
func (s *Service) TestProxyLoadBalancing(ctx context.Context, profileID string, input lbTestInput, actor probeActor) (lbTestResult, error) {
	profile, err := s.requireProfileConfig(ctx, profileID)
	if err != nil {
		return lbTestResult{}, err
	}
	base, err := requireProfileBase(profile.APIBase)
	if err != nil {
		return lbTestResult{}, err
	}
	model := optionalTextValue(input.Model)
	if model == "" {
		model = strings.TrimSpace(profile.Model)
	}
	if model == "" {
		return lbTestResult{}, codedBadRequest(errorCodeModelRequired, "model is not configured")
	}

	attempts := input.Attempts.clampedInt(minLBAttempts, maxLBAttempts, defaultLBAttempts)
	concurrency := input.Concurrency.clampedInt(minLBConcurrency, maxLBConcurrency, defaultLBConcurrency)
	prompt := defaultPrompt
	if value := normalizeOptionalText(input.Prompt); value != nil {
		prompt = *value
	}

	apiKey, err := s.resolveTestingAPIKey(ctx, profileID, base, profile.APIKey, authModeProfileKey)
	if err != nil {
		return lbTestResult{}, err
	}
	client := newUpstreamClient(s.http, base, apiKey, profileTimeout(profile))
	log := probeLogContext{
		OrgID:     actorOrgID(actor),
		UserID:    actor.UserID,
		ProfileID: profileID,
		AuthMode:  authModeProfileKey,
	}
	startedAt := time.Now()
	outcomes := make([]lbAttempt, attempts)

	workers := concurrency
	if workers > attempts {
		workers = attempts
	}
	jobs := make(chan int)
	var waitGroup sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for index := range jobs {
				outcomes[index] = s.runLBAttempt(ctx, client, model, prompt, index+1, apiKey != "", log)
			}
		}()
	}
	for index := 0; index < attempts; index++ {
		jobs <- index
	}
	close(jobs)
	waitGroup.Wait()

	result := lbTestResult{
		APIBase:                  base,
		Model:                    model,
		Attempts:                 attempts,
		DurationMS:               int(time.Since(startedAt).Milliseconds()),
		CheckedAt:                s.nowUTC().Format("2006-01-02T15:04:05.000Z"),
		ModelIDDistribution:      modelDistribution{},
		ModelAPIBaseDistribution: modelDistribution{},
		CallIDSamples:            []string{},
		Errors:                   []testError{},
	}
	for _, outcome := range outcomes {
		if !outcome.succeeded {
			result.Failed++
			if outcome.err != nil && len(result.Errors) < maxProbeErrors {
				result.Errors = append(result.Errors, *outcome.err)
			}
			continue
		}
		result.Succeeded++
		result.ModelIDDistribution[outcome.modelID]++
		result.ModelAPIBaseDistribution[outcome.modelAPIBase]++
		if outcome.callID != "" && len(result.CallIDSamples) < maxCallIDSamples {
			result.CallIDSamples = append(result.CallIDSamples, outcome.callID)
		}
	}
	return result, nil
}

// runLBAttempt performs one LB request. The prompt gets a trailing "#<n>" so each
// attempt is distinguishable in the upstream logs.
func (s *Service) runLBAttempt(ctx context.Context, client upstreamClient, model, prompt string, attemptNumber int, apiKeyConfigured bool, log probeLogContext) lbAttempt {
	body, err := json.Marshal(chatCompletionPayload{
		Model: model,
		Messages: []chatMessage{{
			Role:    "user",
			Content: prompt + "\n#" + itoa(attemptNumber),
		}},
		Temperature: 0,
		TopP:        1,
		MaxTokens:   lbMaxTokens,
		Stream:      false,
	})
	if err != nil {
		info := toGatewayErrorInfo(err, errorContext{apiSurface: surfaceChat})
		rendered := info.toTestError()
		return lbAttempt{err: &rendered}
	}
	response, _, callErr := s.postProbe(ctx, probeCall{
		Client:       client,
		PrimaryPath:  "/v1/chat/completions",
		FallbackPath: "/chat/completions",
		Body:         body,
		RequestType:  llmlogs.ProbeRequestCompletion,
		APISurface:   surfaceChat,
		Model:        model,
		Log:          log,
		LogSuccess:   true,
	})
	if callErr != nil {
		info := toGatewayErrorInfo(callErr, errorContext{apiKeyConfigured: boolPointer(apiKeyConfigured), apiSurface: surfaceChat})
		rendered := info.toTestError()
		return lbAttempt{err: &rendered}
	}
	return lbAttempt{
		succeeded:    true,
		modelID:      headerValueOr(response.header, "x-litellm-model-id", lbUnknownLabel),
		modelAPIBase: headerValueOr(response.header, "x-litellm-model-api-base", lbUnknownLabel),
		callID:       headerValueOr(response.header, "x-litellm-call-id", ""),
	}
}

// headerValueOr returns one trimmed header value or the fallback.
func headerValueOr(header http.Header, name, fallback string) string {
	value := strings.TrimSpace(header.Get(name))
	if value == "" {
		return fallback
	}
	return value
}

// clampedInt mirrors clampInt: an omitted field uses the fallback, an explicit
// null is Number(null) === 0 and therefore clamps to the minimum.
func (n optionalNumber) clampedInt(minimum, maximum, fallback int) int {
	if !n.Present {
		return fallback
	}
	value := 0.0
	if !n.Null {
		value = n.Value
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return fallback
	}
	truncated := math.Trunc(value)
	if truncated < float64(minimum) {
		return minimum
	}
	if truncated > float64(maximum) {
		return maximum
	}
	return int(truncated)
}
