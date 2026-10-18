package publicportal

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// StatusError 是要按 Nest HTTP 异常原样返回的失败。
type StatusError struct {
	Code    int
	Message string
	Name    string
}

func (e *StatusError) Error() string { return e.Message }

// GatewayEnv 是 Nest 已经使用的模型网关环境。空值按 Nest env schema 的默认。
type GatewayEnv struct {
	EncryptionKey string
	APIBase       string
	APIKey        string
	TimeoutMs     int
	MaxRetries    int
	// TopP is the LITELLM_TOP_P gateway default (0.9). It is the fallback for a
	// profile without an explicit topP and is only consumed by the RSS
	// translation completion surface; the brief request keeps its own 0.9.
	TopP float64
}

type completionRequest struct {
	OrgID    string
	System   string
	User     string
	Metadata BriefCompletionMetadata
}

// BriefSettingsReader is the only store capability the model gateway needs:
// the raw llm_gateway_profiles and litellm_proxy_governance documents. Keeping
// it narrow lets the exported brief completion surface run without the public
// portal home/channel reads.
type BriefSettingsReader interface {
	GatewaySettings(ctx context.Context) (profiles, governance []byte, err error)
}

type completionProfile struct {
	ID                 string
	APIBase            string
	APIKey             string
	Model              string
	FallbackModels     []string
	Timeout            time.Duration
	MaxRetries         int
	SendMetadata       bool
	ResponseFormatMode string
	APISurface         string
	// TopP mirrors the normalized profile topP (clamped 0..1, env default 0.9).
	// Only the RSS translation request uses it; the brief request keeps its own
	// literal 0.9.
	TopP float64
	// Governance mirrors Nest's resolved config after
	// applyManagedProxyGovernance: whether the managed runtime key replaced
	// the profile key, the auth mode the request used, and the governance
	// target profile id. They are also written to the LLM request log.
	GovernanceApplied         bool
	GovernanceAuthMode        string
	GovernanceTargetProfileID string
}

// authMode mirrors litellm.service.ts governanceAuthMode ?? "profile_key".
func (p completionProfile) authMode() string {
	if p.GovernanceApplied {
		return "managed_runtime_key"
	}
	return "profile_key"
}

type gatewayClient struct {
	store BriefSettingsReader
	env   GatewayEnv
	http  *http.Client
}

func newGateway(store BriefSettingsReader, env GatewayEnv) *gatewayClient {
	if env.APIBase == "" {
		env.APIBase = "http://localhost:4001"
	}
	if env.TimeoutMs <= 0 {
		env.TimeoutMs = 60_000
	}
	if env.MaxRetries <= 0 {
		env.MaxRetries = 3
	}
	if env.TopP <= 0 {
		env.TopP = 0.9
	}
	return &gatewayClient{store: store, env: env, http: &http.Client{}}
}

// errContentBlocked marks an upstream guardrail refusal that arrived as a
// successful HTTP response. Nest stops the fallback chain on this error, so the
// completion loop must not paper over it with another model.
var errContentBlocked = errors.New("model gateway blocked the request by guardrails")

// completionOutcome is one successful or failed model HTTP exchange.
type completionOutcome struct {
	Content string
	Usage   BriefCompletionUsage
}

// Complete keeps the public portal story-detail call shape: content only.
func (g *gatewayClient) Complete(ctx context.Context, req completionRequest) (string, error) {
	outcome, err := g.complete(ctx, req, nil)
	if err != nil {
		return "", err
	}
	return outcome.Content, nil
}

// complete resolves the active profile and walks the primary model followed by
// the configured fallback models. observer, when not nil, receives one record
// per real HTTP attempt.
func (g *gatewayClient) complete(ctx context.Context, req completionRequest, observer BriefCompletionObserver) (completionOutcome, error) {
	profiles, governance, err := g.store.GatewaySettings(ctx)
	if err != nil {
		return completionOutcome{}, err
	}
	profile, err := resolveCompletionProfile(profiles, governance, g.env)
	if err != nil {
		return completionOutcome{}, err
	}
	models := uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	if len(models) == 0 {
		return completionOutcome{}, errors.New("completion model is not configured")
	}
	var last error
	for index, model := range models {
		outcome, err := g.completeModel(ctx, profile, model, index, req, observer)
		if err == nil {
			return outcome, nil
		}
		if status, ok := err.(*StatusError); ok {
			return completionOutcome{}, status
		}
		if errors.Is(err, errContentBlocked) {
			// A guardrail refusal terminates the whole chain; Nest does not
			// retry it against a fallback model.
			return completionOutcome{}, err
		}
		last = err
	}
	if last == nil {
		last = errors.New("completion failed")
	}
	return completionOutcome{}, last
}

func (g *gatewayClient) completeModel(ctx context.Context, profile completionProfile, model string, modelIndex int, req completionRequest, observer BriefCompletionObserver) (completionOutcome, error) {
	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var last error
	for attempt := 0; attempt < attempts; attempt++ {
		started := time.Now()
		outcome, status, err := g.postCompletion(ctx, profile, model, req)
		if observer != nil {
			observer.ObserveBriefCompletionAttempt(ctx, BriefCompletionAttempt{
				OrgID:                     req.OrgID,
				Model:                     model,
				APISurface:                profile.APISurface,
				GatewayProfileID:          profile.ID,
				GovernanceApplied:         profile.GovernanceApplied,
				AuthMode:                  profile.authMode(),
				GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
				Attempt:                   attempt + 1,
				ModelIndex:                modelIndex + 1,
				Success:                   err == nil,
				Err:                       err,
				Latency:                   time.Since(started),
				Usage:                     outcome.Usage,
				Metadata:                  req.Metadata,
			})
		}
		if err == nil {
			return outcome, nil
		}
		last = err
		if errors.Is(err, errContentBlocked) || !retryable(status, err) || attempt+1 >= attempts {
			return completionOutcome{}, err
		}
		if sleepErr := sleep(ctx, delay); sleepErr != nil {
			return completionOutcome{}, sleepErr
		}
		if delay < 10*time.Second {
			delay *= 2
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
		}
	}
	return completionOutcome{}, last
}

func (g *gatewayClient) postCompletion(ctx context.Context, profile completionProfile, model string, req completionRequest) (completionOutcome, int, error) {
	payload := map[string]any{
		"temperature": 0.2,
		"top_p":       0.9,
	}
	format := briefResponseFormat(profile.ResponseFormatMode)
	if profile.SendMetadata {
		payload["metadata"] = req.Metadata
	}
	var primary, fallback string
	if profile.APISurface == "responses" {
		payload["model"] = model
		payload["input"] = []map[string]string{
			{"role": "system", "content": req.System},
			{"role": "user", "content": req.User},
		}
		payload["max_output_tokens"] = 1200
		if format != nil {
			payload["text"] = map[string]any{"format": format}
		}
		primary, fallback = "/v1/responses", "/responses"
	} else {
		payload["model"] = model
		payload["messages"] = []map[string]string{
			{"role": "system", "content": req.System},
			{"role": "user", "content": req.User},
		}
		payload["max_tokens"] = 1200
		payload["stream"] = false
		if format != nil {
			payload["response_format"] = format
		}
		primary, fallback = "/v1/chat/completions", "/chat/completions"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return completionOutcome{}, 0, err
	}
	status, raw, header, err := g.post(ctx, profile, primary, body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, header, err = g.post(ctx, profile, fallback, body)
	}
	if err != nil {
		return completionOutcome{}, status, err
	}
	if status < 200 || status >= 300 {
		return completionOutcome{}, status, errors.New("model gateway request failed")
	}
	content := completionText(raw, profile.APISurface)
	usage := completionUsage(raw, profile.APISurface)
	if cost, ok := extractCostHeader(header); ok {
		usage.CostUSD = &cost
	}
	if strings.TrimSpace(content) == "" {
		if isGuardrailBlockedResponse(raw) {
			return completionOutcome{Usage: usage}, status, errContentBlocked
		}
		return completionOutcome{Usage: usage}, status, errors.New("model gateway returned empty content")
	}
	return completionOutcome{Content: content, Usage: usage}, status, nil
}

func (g *gatewayClient) post(ctx context.Context, profile completionProfile, path string, body []byte) (int, []byte, http.Header, error) {
	timeout := profile.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	httpReq, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if profile.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	resp, err := g.http.Do(httpReq)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return resp.StatusCode, nil, resp.Header, err
	}
	return resp.StatusCode, raw, resp.Header, nil
}

// isGuardrailBlockedResponse mirrors Nest's extractGuardrailBlockedMessage:
// LiteLLM reports a guardrail refusal as a successful response whose body
// carries a non-empty messages array and no usable choice.
func isGuardrailBlockedResponse(raw []byte) bool {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	messages, ok := doc["messages"].([]any)
	if !ok || len(messages) == 0 {
		return false
	}
	choices, _ := doc["choices"].([]any)
	return len(choices) == 0
}

// completionUsage extracts the token accounting of one successful response.
// Unknown values stay nil; they are never coerced to zero. The responses
// surface reports no usage at all unless both token counts are numeric, which
// mirrors normalizeCompletionUsageFromResponses.
func completionUsage(raw []byte, surface string) BriefCompletionUsage {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return BriefCompletionUsage{}
	}
	usageRecord, _ := doc["usage"].(map[string]any)
	if surface == "responses" {
		prompt := firstFinite(usageRecord["prompt_tokens"], usageRecord["input_tokens"])
		completion := firstFinite(usageRecord["completion_tokens"], usageRecord["output_tokens"])
		if prompt == nil || completion == nil {
			return BriefCompletionUsage{CostUSD: payloadCost(doc, usageRecord)}
		}
		total := firstFinite(usageRecord["total_tokens"], nil)
		if total == nil {
			sum := *prompt + *completion
			total = &sum
		}
		return BriefCompletionUsage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, CostUSD: payloadCost(doc, usageRecord)}
	}
	prompt := firstFinite(usageRecord["prompt_tokens"], nil)
	completion := firstFinite(usageRecord["completion_tokens"], nil)
	total := firstFinite(usageRecord["total_tokens"], nil)
	if total == nil && prompt != nil && completion != nil {
		sum := *prompt + *completion
		total = &sum
	}
	return BriefCompletionUsage{PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, CostUSD: payloadCost(doc, usageRecord)}
}

func payloadCost(doc, usageRecord map[string]any) *float64 {
	if usageRecord != nil {
		if cost := firstFinite(usageRecord["response_cost"], nil); cost != nil {
			return cost
		}
	}
	return firstFinite(doc["response_cost"], nil)
}

func firstFinite(values ...any) *float64 {
	for _, value := range values {
		if value == nil {
			continue
		}
		number, ok := finiteNumber(value)
		if !ok {
			continue
		}
		return &number
	}
	return nil
}

func finiteNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

// extractCostHeader reads the LiteLLM cost headers in Nest's order.
func extractCostHeader(header http.Header) (float64, bool) {
	if header == nil {
		return 0, false
	}
	for _, name := range []string{"x-litellm-response-cost", "x-litellm-cost", "litellm-cost"} {
		raw := strings.TrimSpace(header.Get(name))
		if raw == "" {
			continue
		}
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return parsed, true
		}
	}
	return 0, false
}

func retryable(status int, err error) bool {
	if err == nil {
		return false
	}
	if status == 0 {
		return true
	}
	switch status {
	case 408, 409, 423, 425, 429, 500, 502, 503, 504:
		return true
	default:
		return false
	}
}

func sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func completionText(raw []byte, surface string) string {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	if surface == "responses" {
		if text, ok := doc["output_text"].(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
		output, _ := doc["output"].([]any)
		var parts []string
		for _, item := range output {
			record, _ := item.(map[string]any)
			content, _ := record["content"].([]any)
			for _, entry := range content {
				part, _ := entry.(map[string]any)
				if text, ok := part["text"].(string); ok && text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "")
	}
	choices, _ := doc["choices"].([]any)
	if len(choices) == 0 {
		return ""
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	switch content := message["content"].(type) {
	case string:
		return content
	case []any:
		var parts []string
		for _, part := range content {
			record, _ := part.(map[string]any)
			if text, ok := record["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	default:
		return ""
	}
}

func resolveCompletionProfile(profilesJSON, governanceJSON []byte, env GatewayEnv) (completionProfile, error) {
	if env.APIBase == "" {
		env.APIBase = "http://localhost:4001"
	}
	if env.TimeoutMs <= 0 {
		env.TimeoutMs = 60_000
	}
	if env.MaxRetries <= 0 {
		env.MaxRetries = 3
	}
	if env.TopP <= 0 {
		env.TopP = 0.9
	}
	var settings struct {
		ActiveID string            `json:"activeId"`
		Profiles []json.RawMessage `json:"profiles"`
	}
	if len(profilesJSON) > 0 {
		if err := json.Unmarshal(profilesJSON, &settings); err != nil {
			return completionProfile{}, errors.New("completion model is not configured")
		}
	}
	profiles := make([]completionProfile, 0, len(settings.Profiles))
	for _, raw := range settings.Profiles {
		profile, ok := normalizeProfile(raw, env)
		if ok {
			profiles = append(profiles, profile)
		}
	}
	var selected *completionProfile
	activeID := strings.TrimSpace(settings.ActiveID)
	if activeID != "" {
		for i := range profiles {
			if profiles[i].ID == activeID {
				selected = &profiles[i]
				break
			}
		}
	}
	if selected == nil {
		if len(profiles) == 0 {
			return completionProfile{}, errors.New("completion model is not configured")
		}
		selected = &profiles[0]
	}
	if err := applyGovernance(selected, profiles, governanceJSON, env.EncryptionKey); err != nil {
		return completionProfile{}, err
	}
	selected.APIBase = normalizeAPIBase(selected.APIBase)
	selected.APIKey = stripBearer(selected.APIKey)
	if selected.Model == "" || selected.APIBase == "" {
		return completionProfile{}, errors.New("completion model is not configured")
	}
	return *selected, nil
}

func normalizeProfile(raw []byte, env GatewayEnv) (completionProfile, bool) {
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		return completionProfile{}, false
	}
	id := jsonString(record["id"])
	model := jsonString(record["model"])
	if id == "" || model == "" {
		return completionProfile{}, false
	}
	// Nest normalizeEnabled: a real boolean is kept; undefined/null default to
	// enabled; any other JSON type disables the profile.
	switch value := record["enabled"].(type) {
	case nil:
	case bool:
		if !value {
			return completionProfile{}, false
		}
	default:
		return completionProfile{}, false
	}
	apiBase := jsonString(record["apiBase"])
	if apiBase == "" {
		apiBase = env.APIBase
	}
	profile := completionProfile{
		ID:                 id,
		APIBase:            apiBase,
		APIKey:             profileAPIKey(record["apiKey"], env.EncryptionKey),
		Model:              model,
		FallbackModels:     jsonStringList(mustJSON(record["fallbackModels"])),
		Timeout:            time.Duration(positiveInt(record["timeoutMs"], env.TimeoutMs)) * time.Millisecond,
		MaxRetries:         positiveInt(record["maxRetries"], env.MaxRetries),
		SendMetadata:       jsonBool(record["sendMetadata"], true),
		ResponseFormatMode: jsonString(record["responseFormatMode"]),
		APISurface:         jsonString(record["apiSurface"]),
	}
	// Nest clamps a stored topP to 0..1 and otherwise keeps the env default.
	profile.TopP = env.TopP
	if storedTopP, ok := record["topP"]; ok {
		if number, ok := finiteNumber(storedTopP); ok {
			profile.TopP = math.Max(0, math.Min(1, number))
		}
	}
	if profile.ResponseFormatMode == "" {
		profile.ResponseFormatMode = "json_schema"
	}
	if profile.APISurface == "" {
		profile.APISurface = "chat_completions"
	}
	return profile, true
}

func applyGovernance(selected *completionProfile, profiles []completionProfile, raw []byte, encryptionKey string) error {
	if len(raw) == 0 || selected == nil {
		return nil
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	if !jsonBool(doc["enabled"], false) {
		return nil
	}
	targetID := jsonString(doc["targetProfileId"])
	if targetID == "" {
		return nil
	}
	var target *completionProfile
	for i := range profiles {
		if profiles[i].ID == targetID {
			target = &profiles[i]
			break
		}
	}
	if target == nil {
		return nil
	}
	if selected.ID != target.ID || normalizeAPIBase(selected.APIBase) != normalizeAPIBase(target.APIBase) {
		return nil
	}
	state, key := governanceSecret(doc["managedRuntimeKey"], encryptionKey)
	if state == "unreadable" {
		return &StatusError{
			Code:    http.StatusServiceUnavailable,
			Message: "LiteLLM governance is enabled but the managed runtime key is unreadable",
			Name:    "Service Unavailable",
		}
	}
	if key == "" {
		return &StatusError{
			Code:    http.StatusServiceUnavailable,
			Message: "LiteLLM governance is enabled but the managed runtime key is missing",
			Name:    "Service Unavailable",
		}
	}
	selected.APIBase = target.APIBase
	selected.APIKey = strings.TrimSpace(key)
	// Nest records these on the resolved config: the request used the managed
	// runtime key and the governance target profile id is written to the LLM
	// request log.
	selected.GovernanceApplied = true
	selected.GovernanceAuthMode = "managed_runtime_key"
	selected.GovernanceTargetProfileID = target.ID
	return nil
}

func governanceSecret(raw any, encryptionKey string) (string, string) {
	if raw == nil {
		return "missing", ""
	}
	switch value := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return "missing", ""
		}
		return "available", trimmed
	case map[string]any:
		if value["__enc"] != "system-settings:v1" {
			return "missing", ""
		}
		plain, err := decryptSecret(value, encryptionKey)
		if err != nil {
			return "unreadable", ""
		}
		plain = strings.TrimSpace(plain)
		if plain == "" {
			return "missing", ""
		}
		return "available", plain
	default:
		return "missing", ""
	}
}

func profileAPIKey(raw any, encryptionKey string) string {
	switch value := raw.(type) {
	case string:
		return stripBearer(value)
	case map[string]any:
		plain, err := decryptSecret(value, encryptionKey)
		if err != nil {
			return ""
		}
		return stripBearer(plain)
	default:
		return ""
	}
}

func decryptSecret(payload map[string]any, encryptionKey string) (string, error) {
	if payload["__enc"] != "system-settings:v1" || payload["alg"] != "aes-256-gcm" {
		return "", errors.New("not an encrypted setting")
	}
	key, err := decodeSettingsKey(encryptionKey)
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(jsonString(payload["iv"]))
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(jsonString(payload["tag"]))
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(jsonString(payload["data"]))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, append(data, tag...), nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decodeSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("missing encryption key")
	}
	hexCandidate := strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
	if len(hexCandidate) == 64 && isHex(hexCandidate) {
		return hex.DecodeString(hexCandidate)
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid encryption key")
	}
	return decoded, nil
}

func isHex(value string) bool {
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		case r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

func stripBearer(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 7 && strings.EqualFold(trimmed[:7], "bearer ") {
		trimmed = strings.TrimSpace(trimmed[7:])
	}
	return trimmed
}

func normalizeAPIBase(raw string) string {
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	lower := strings.ToLower(base)
	for _, suffix := range []string{
		"/v1/chat/completions",
		"/chat/completions",
		"/v1/embeddings",
		"/embeddings",
		"/v1/models",
		"/models",
		"/v1/responses",
		"/responses",
	} {
		if strings.HasSuffix(lower, suffix) {
			base = strings.TrimRight(base[:len(base)-len(suffix)], "/")
			lower = strings.ToLower(base)
			break
		}
	}
	if strings.HasSuffix(strings.ToLower(base), "/v1") {
		base = strings.TrimRight(base[:len(base)-len("/v1")], "/")
	}
	return base
}

func uniqueModels(models []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	return out
}

func jsonString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func jsonBool(value any, fallback bool) bool {
	flag, ok := value.(bool)
	if !ok {
		return fallback
	}
	return flag
}

func positiveInt(value any, fallback int) int {
	number, ok := value.(float64)
	if !ok || number != float64(int(number)) || int(number) <= 0 {
		return fallback
	}
	return int(number)
}

func mustJSON(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}

func briefResponseFormat(mode string) any {
	switch mode {
	case "none":
		return nil
	case "json_object":
		return map[string]any{"type": "json_object"}
	default:
		return map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "news_event_brief_v1",
				"schema": briefJSONSchema(),
			},
		}
	}
}

// briefJSONSchema mirrors the JSON schema zodToJsonSchema derives from
// NewsEventBriefPayloadSchema: the point object requires only text (citations
// has a default), key_points carries minItems 1, and latest_update is nullable.
func briefJSONSchema() map[string]any {
	point := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"text":      map[string]any{"type": "string", "minLength": 1},
			"citations": map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 1}, "maxItems": 12, "default": []any{}},
		},
		"required":             []string{"text"},
		"additionalProperties": false,
	}
	points := func(max int) map[string]any {
		return map[string]any{"type": "array", "items": point, "maxItems": max, "default": []any{}}
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"detailed_summary": map[string]any{"type": "string", "minLength": 1},
			"tldr":             map[string]any{"type": "string", "minLength": 1},
			"key_points":       map[string]any{"type": "array", "items": point, "minItems": 1, "maxItems": 10},
			"why_it_matters":   points(10),
			"latest_update":    map[string]any{"anyOf": []any{point, map[string]any{"type": "null"}}},
			"what_to_watch":    points(12),
			"comparison": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"consensus":  points(12),
					"divergence": points(12),
				},
				"additionalProperties": false,
			},
			"limitations": map[string]any{"type": []any{"string", "null"}},
		},
		"required":             []string{"detailed_summary", "tldr"},
		"additionalProperties": false,
	}
}
