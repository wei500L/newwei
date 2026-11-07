package publicportal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// This file adds the RSS translation completion surface. It reuses the gateway
// client, profile resolution, governance, API base normalization, retry policy
// and usage extraction that the news-event brief already uses, but sends the
// RSS request shape: temperature 0, a dynamic token budget, a plain-text
// response (no brief JSON schema), and the {source,targetLanguage} metadata.
// The brief request path is untouched.

const rssTranslationMetadataSource = "rss_translation"

// RssTranslationMetadata is the model request metadata for RSS translation. It
// is serialized verbatim into the upstream request body when the active profile
// has sendMetadata enabled, and it is later filtered by the LLM request-log
// policy before it is written to llmrequestlogs.
type RssTranslationMetadata struct {
	Source         string `json:"source"`
	TargetLanguage string `json:"targetLanguage"`
}

// RssTranslationUsage is the token and cost accounting of one model call. A
// value the gateway did not report stays nil; it is never coerced to zero.
type RssTranslationUsage struct {
	PromptTokens     *float64
	CompletionTokens *float64
	TotalTokens      *float64
	CostUSD          *float64
}

// RssTranslationAttempt describes one real HTTP attempt: one model, one try.
// The RSS translation path passes maxRetries=1, so the fallback chain performs
// exactly one attempt per model and NestJS still writes one log row per
// attempt, including the failed ones.
type RssTranslationAttempt struct {
	OrgID                     string
	Model                     string
	APISurface                string
	GatewayProfileID          string
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
	// ModelIndex is the 1-based position of the model in the primary-plus-
	// fallback order.
	ModelIndex int
	Success    bool
	// Err is the attempt failure. It is nil on success.
	Err      error
	Latency  time.Duration
	Usage    RssTranslationUsage
	Metadata RssTranslationMetadata
}

// RssTranslationObserver receives every real model attempt. Implementations
// must not block or fail the translation on their own errors.
type RssTranslationObserver interface {
	ObserveRssTranslationAttempt(ctx context.Context, attempt RssTranslationAttempt)
}

// RssTranslationCompletionRequest is the strongly typed RSS translation
// completion input. The caller owns prompt construction, target-language
// handling and the token budget; this surface only performs the model call.
type RssTranslationCompletionRequest struct {
	OrgID          string
	System         string
	User           string
	TargetLanguage string
	// MaxTokens is the computed max_tokens/max_output_tokens for this text.
	MaxTokens int
	Observer  RssTranslationObserver
}

// RssTranslationCompletionResult is one successful completion.
type RssTranslationCompletionResult struct {
	Content string
	Model   string
	Usage   RssTranslationUsage
}

// RssTranslationCompleter is the exported RSS completion surface reused by the
// translateRssItems mutation. PrimaryModel returns the profile's configured
// primary model name, which is the cache-key model the caller must use; it does
// not switch to an actually used fallback model.
type RssTranslationCompleter interface {
	PrimaryModel(ctx context.Context) (string, error)
	CompleteText(ctx context.Context, req RssTranslationCompletionRequest) (RssTranslationCompletionResult, error)
}

// NewRssTranslationCompleter builds the production RSS completer over the
// gateway settings reader. Configuration is resolved lazily on the first call,
// so no model is probed at startup.
func NewRssTranslationCompleter(settings BriefSettingsReader, env GatewayEnv) RssTranslationCompleter {
	if settings == nil {
		return unavailableRssTranslationCompleter{}
	}
	return newGateway(settings, env)
}

// errRssContentBlocked marks an upstream guardrail refusal that arrived either
// as a successful response with no usable choice or as a non-2xx error whose
// body carries a guardrail signal. Nest stops the fallback chain on this error,
// so the completion loop must not paper over it with another model.
var errRssContentBlocked = errors.New("model gateway blocked the request by guardrails")

// rssCompatibilityError marks an upstream incompatibility (unsupported
// metadata/response format or Responses API) that must stop the model fallback
// chain exactly like Nest's LlmCompatibilityError.
type rssCompatibilityError struct {
	message string
}

func (e *rssCompatibilityError) Error() string { return e.message }

// PrimaryModel resolves the active completion profile and returns its
// configured model. A missing/invalid profile is an error.
func (g *gatewayClient) PrimaryModel(ctx context.Context) (string, error) {
	profile, _, err := g.resolveLitellmProfile(ctx)
	if err != nil {
		return "", err
	}
	return profile.Model, nil
}

// CompleteText walks the primary model followed by the configured fallback
// models through the shared completion engine, one attempt per model. observer,
// when not nil, receives one record per real attempt.
func (g *gatewayClient) CompleteText(ctx context.Context, req RssTranslationCompletionRequest) (RssTranslationCompletionResult, error) {
	profile, client, err := g.resolveLitellmProfile(ctx)
	if err != nil {
		return RssTranslationCompletionResult{}, err
	}
	metadata := RssTranslationMetadata{
		Source:         rssTranslationMetadataSource,
		TargetLanguage: req.TargetLanguage,
	}
	plan := litellmcompat.CompletionPlan{
		OrgID:      req.OrgID,
		Models:     uniqueModels(append([]string{profile.Model}, profile.FallbackModels...)),
		MaxRetries: 1,
		MaxBody:    2 << 20,
		Build: func(model string) ([]byte, string, string, error) {
			return buildRssPayload(profile, model, req, metadata)
		},
		Parse: func(status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
			return parseRssCompletion(profile, status, header, raw, model)
		},
		Stop:     isRssStopError,
		Observer: rssAttemptAdapter{next: req.Observer, metadata: metadata},
	}
	response, err := client.RunCompletion(ctx, profile, plan)
	if err != nil {
		return RssTranslationCompletionResult{}, err
	}
	return RssTranslationCompletionResult{Content: response.Content, Model: response.Model, Usage: rssUsageFromBrief(briefUsageFromShared(response.Usage))}, nil
}

func parseRssCompletion(profile litellmcompat.Profile, status int, header http.Header, raw []byte, model string) (litellmcompat.CompletionResponse, error) {
	if status < 200 || status >= 300 {
		detail := rssErrorDetail(raw)
		if rssGuardrailSignal(detail) {
			return litellmcompat.CompletionResponse{}, errRssContentBlocked
		}
		if issue, ok := rssCompatibilityIssue(status, detail, string(profile.APISurface)); ok {
			return litellmcompat.CompletionResponse{}, &rssCompatibilityError{message: issue}
		}
		return litellmcompat.CompletionResponse{}, errors.New(rssHTTPErrorMessage(status, detail))
	}
	if isGuardrailBlockedResponse(raw) {
		return litellmcompat.CompletionResponse{}, errRssContentBlocked
	}
	content := strings.TrimSpace(completionText(raw, string(profile.APISurface)))
	usage := completionUsage(raw, string(profile.APISurface))
	if cost, ok := extractCostHeader(header); ok {
		usage.CostUSD = &cost
	}
	// An empty content is a successful exchange: Nest logs it as success and the
	// RSS service turns it into a per-text failure without trying another model.
	return litellmcompat.CompletionResponse{Content: content, Model: rssResponseModel(raw, model), Usage: briefUsageToShared(usage)}, nil
}

// rssAttemptAdapter maps the shared attempt record onto the RSS attempt type.
type rssAttemptAdapter struct {
	next     RssTranslationObserver
	metadata RssTranslationMetadata
}

func (a rssAttemptAdapter) ObserveAttempt(_ context.Context, attempt litellmcompat.Attempt) {
	if a.next == nil {
		return
	}
	model := attempt.ResponseModel
	if model == "" {
		model = attempt.Model
	}
	a.next.ObserveRssTranslationAttempt(context.Background(), RssTranslationAttempt{
		OrgID:                     attempt.OrgID,
		Model:                     model,
		APISurface:                string(attempt.APISurface),
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         attempt.GovernanceApplied,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		ModelIndex:                attempt.ModelIndex,
		Success:                   attempt.Success,
		Err:                       attempt.Err,
		Latency:                   attempt.Latency,
		Usage:                     rssUsageFromBrief(briefUsageFromShared(attempt.Usage)),
		Metadata:                  a.metadata,
	})
}

// rssChatMessage is one OpenAI-compatible message. The responses surface reuses
// the same {role,content} shape for its input items, exactly like
// toResponsesInput.
type rssChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type rssResponseFormat struct {
	Type string `json:"type"`
}

type rssResponsesText struct {
	Format *rssResponseFormat `json:"format"`
}

type rssChatPayload struct {
	Model          string                  `json:"model"`
	Messages       []rssChatMessage        `json:"messages"`
	Temperature    float64                 `json:"temperature"`
	TopP           float64                 `json:"top_p"`
	MaxTokens      int                     `json:"max_tokens"`
	ResponseFormat *rssResponseFormat      `json:"response_format,omitempty"`
	Stream         bool                    `json:"stream"`
	Metadata       *RssTranslationMetadata `json:"metadata,omitempty"`
}

type rssResponsesPayload struct {
	Model           string                  `json:"model"`
	Input           []rssChatMessage        `json:"input"`
	Temperature     float64                 `json:"temperature"`
	TopP            float64                 `json:"top_p"`
	MaxOutputTokens int                     `json:"max_output_tokens"`
	Text            *rssResponsesText       `json:"text,omitempty"`
	Metadata        *RssTranslationMetadata `json:"metadata,omitempty"`
}

// buildRssPayload mirrors LiteLlmService.resolveResponseFormat and
// resolveResponsesTextFormat: the RSS call sends no response_format, so a none
// or json_schema profile omits the field while json_object sends the explicit
// json_object marker. Nothing else about the provider configuration is
// changed.
func buildRssPayload(profile litellmcompat.Profile, model string, req RssTranslationCompletionRequest, metadata RssTranslationMetadata) ([]byte, string, string, error) {
	messages := []rssChatMessage{
		{Role: "system", Content: req.System},
		{Role: "user", Content: req.User},
	}
	metadataPayload := &metadata
	if !profile.SendMetadata {
		metadataPayload = nil
	}
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 512
	}
	var payload any
	var primary, fallback string
	if profile.APISurface == litellmcompat.APISurfaceResponses {
		responses := rssResponsesPayload{
			Model:           model,
			Input:           messages,
			Temperature:     0,
			TopP:            profile.TopP,
			MaxOutputTokens: maxTokens,
			Metadata:        metadataPayload,
		}
		if profile.ResponseFormatMode == litellmcompat.ResponseFormatJSONObject {
			responses.Text = &rssResponsesText{Format: &rssResponseFormat{Type: "json_object"}}
		}
		payload = responses
		primary, fallback = "/v1/responses", "/responses"
	} else {
		chat := rssChatPayload{
			Model:       model,
			Messages:    messages,
			Temperature: 0,
			TopP:        profile.TopP,
			MaxTokens:   maxTokens,
			Stream:      false,
			Metadata:    metadataPayload,
		}
		if profile.ResponseFormatMode == litellmcompat.ResponseFormatJSONObject {
			chat.ResponseFormat = &rssResponseFormat{Type: "json_object"}
		}
		payload = chat
		primary, fallback = "/v1/chat/completions", "/chat/completions"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", "", err
	}
	return body, primary, fallback, nil
}

// rssUsageFromBrief converts the reused usage extractor into the RSS type.
func rssUsageFromBrief(usage BriefCompletionUsage) RssTranslationUsage {
	return RssTranslationUsage{
		PromptTokens:     usage.PromptTokens,
		CompletionTokens: usage.CompletionTokens,
		TotalTokens:      usage.TotalTokens,
		CostUSD:          usage.CostUSD,
	}
}

// rssResponseModel reads the model the gateway reported, falling back to the
// requested model, mirroring annotateSelectedModel.
func rssResponseModel(raw []byte, fallback string) string {
	var doc struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(raw, &doc); err == nil {
		if trimmed := strings.TrimSpace(doc.Model); trimmed != "" {
			return trimmed
		}
	}
	return fallback
}

// isRssStopError reports the two error classes that terminate the model
// fallback chain instead of trying the next model.
func isRssStopError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errRssContentBlocked) {
		return true
	}
	var compatibility *rssCompatibilityError
	return errors.As(err, &compatibility)
}

// rssCompatCues mirror detectOpenAiCompatibilityIssue's cue lists.
var (
	rssUnsupportedCues = []string{
		"unsupported", "not supported", "not allowed", "not permitted",
		"unrecognized", "unknown", "extra fields", "additional properties",
		"unexpected field", "unexpected parameter",
	}
	rssInvalidArgumentCues = []string{
		"invalid request argument", "invalid argument", "invalid parameter",
	}
	rssResponsesRouteCues = []string{
		"method not allowed", "not implemented", "does not support responses",
		"responses is not supported", "route not found", "unknown route",
		"unknown path", "no route", "endpoint not found", "not found",
	}
	rssResponsesReferences = []string{
		"/v1/responses", "/responses", "responses api", "responses endpoint",
	}
	rssGuardrailPattern = regexp.MustCompile(`guardrail|moderation|prompt.?injection|jailbreak|content.?policy|trust.?safety`)
)

// rssCompatibilityIssue mirrors detectOpenAiCompatibilityIssue for the fields
// an RSS translation request can carry: metadata, response_format, a JSON
// schema, message content and the Responses API. It returns a formatted
// compatibility message when the upstream error identifies one.
func rssCompatibilityIssue(status int, detail, apiSurface string) (string, bool) {
	text := sanitizeRssUpstreamText(detail, 500)
	if text == "" {
		return "", false
	}
	lower := strings.ToLower(text)
	hasUnsupported := containsAnyCue(lower, rssUnsupportedCues)
	hasInvalidArgument := containsAnyCue(lower, rssInvalidArgumentCues)

	if (status == 400 || status == 404 || status == 405 || status == 501) &&
		apiSurface == "responses" &&
		containsAnyCue(lower, rssResponsesReferences) &&
		(status == 501 || containsAnyCue(lower, rssResponsesRouteCues)) {
		return "LLM compatibility error [RESPONSES_API_UNSUPPORTED] on apiSurface: upstream gateway does not support the Responses API", true
	}
	if status != 400 && status != 404 && status != 405 && status != 422 && status != 501 {
		return "", false
	}
	if strings.Contains(lower, "metadata") && (hasUnsupported || hasInvalidArgument) {
		return "LLM compatibility error [UNSUPPORTED_METADATA] on metadata: remove metadata or use a gateway that forwards it", true
	}
	if (strings.Contains(lower, "json_schema") || strings.Contains(lower, "json schema") || strings.Contains(lower, "structured output")) &&
		(hasUnsupported || hasInvalidArgument) {
		return "LLM compatibility error [UNSUPPORTED_JSON_SCHEMA] on response_format.json_schema", true
	}
	if (strings.Contains(lower, "response_format") || strings.Contains(lower, "response format")) &&
		(hasUnsupported || hasInvalidArgument) {
		return "LLM compatibility error [UNSUPPORTED_RESPONSE_FORMAT] on response_format", true
	}
	if (strings.Contains(lower, "messages") || strings.Contains(lower, "message")) &&
		strings.Contains(lower, "content") &&
		(hasUnsupported || hasInvalidArgument || strings.Contains(lower, "invalid") || strings.Contains(lower, "must be")) {
		return "LLM compatibility error [INVALID_MESSAGE_CONTENT] on messages[].content", true
	}
	return "", false
}

func containsAnyCue(input string, cues []string) bool {
	for _, cue := range cues {
		if strings.Contains(input, cue) {
			return true
		}
	}
	return false
}

// rssGuardrailSignal reports whether the upstream error text identifies a
// guardrail/moderation refusal, mirroring extractStructuredGuardrailSignal's
// signal set. A true result stops the model fallback chain.
func rssGuardrailSignal(detail string) bool {
	if detail == "" {
		return false
	}
	return rssGuardrailPattern.MatchString(strings.ToLower(detail))
}

// rssHTTPErrorMessage mirrors decorateAxiosError's message rewrite including
// the 401/403 api-key hint. It is log-only: the RSS translation path falls back
// to the original text on any model error.
func rssHTTPErrorMessage(status int, detail string) string {
	detail = sanitizeRssUpstreamText(detail, 500)
	lower := strings.ToLower(detail)
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		hint := "Unauthorized (apiKey is not configured)"
		if status == http.StatusForbidden {
			hint = "Forbidden (apiKey is not configured)"
		}
		if detail == "" || lower == "unauthorized" || lower == "forbidden" {
			detail = hint
		} else if !strings.Contains(lower, "apikey") && !strings.Contains(lower, "api key") {
			detail = detail + " (" + hint + ")"
		}
	}
	if detail == "" {
		return fmt.Sprintf("LiteLLM request failed (HTTP %d)", status)
	}
	return fmt.Sprintf("LiteLLM request failed (HTTP %d): %s", status, detail)
}

// rssErrorDetail mirrors extractAxiosErrorText: an error object's message (or
// error.message, string or array) first, then the raw body.
func rssErrorDetail(raw []byte) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return ""
		}
		return strings.TrimSpace(text)
	}
	if trimmed[0] != '{' {
		return trimmed
	}
	var body struct {
		Message json.RawMessage `json:"message"`
		Error   *struct {
			Message json.RawMessage `json:"message"`
			Type    string          `json:"type"`
			Code    json.RawMessage `json:"code"`
			Param   string          `json:"param"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return trimmed
	}
	if body.Error != nil {
		if text := rawMessageText(body.Error.Message); text != "" {
			return text
		}
		if text := strings.TrimSpace(body.Error.Param); text != "" {
			return text
		}
	}
	if text := rawMessageText(body.Message); text != "" {
		return text
	}
	return trimmed
}

// rawMessageText decodes an OpenAI-style message that may be a string or an
// array of strings.
func rawMessageText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var parts []string
	if json.Unmarshal(raw, &parts) == nil {
		return strings.TrimSpace(strings.Join(parts, "; "))
	}
	return ""
}

var (
	rssBearerPattern = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._-]+`)
	rssAPIKeyPattern = regexp.MustCompile(`\bsk-[A-Za-z0-9]{10,}\b`)
)

// sanitizeRssUpstreamText redacts credentials and truncates long upstream text
// exactly like sanitizeUpstreamErrorText.
func sanitizeRssUpstreamText(raw string, maxLength int) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if maxLength < 64 {
		maxLength = 64
	}
	redacted := rssBearerPattern.ReplaceAllString(trimmed, "Bearer [REDACTED]")
	redacted = rssAPIKeyPattern.ReplaceAllString(redacted, "sk-[REDACTED]")
	if len([]rune(redacted)) <= maxLength {
		return redacted
	}
	return string([]rune(redacted)[:maxLength]) + "…"
}

// unavailableRssTranslationCompleter fails every call when the settings reader
// is missing, so registering the mutation in that state cannot panic later.
type unavailableRssTranslationCompleter struct{}

func (unavailableRssTranslationCompleter) PrimaryModel(context.Context) (string, error) {
	return "", errCompletionUnavailable
}

func (unavailableRssTranslationCompleter) CompleteText(context.Context, RssTranslationCompletionRequest) (RssTranslationCompletionResult, error) {
	return RssTranslationCompletionResult{}, errCompletionUnavailable
}
