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
	"net/http"
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
}

type completionRequest struct {
	OrgID    string
	System   string
	User     string
	Metadata map[string]any
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
}

type gatewayClient struct {
	store Store
	env   GatewayEnv
	http  *http.Client
}

func newGateway(store Store, env GatewayEnv) *gatewayClient {
	if env.APIBase == "" {
		env.APIBase = "http://localhost:4001"
	}
	if env.TimeoutMs <= 0 {
		env.TimeoutMs = 60_000
	}
	if env.MaxRetries <= 0 {
		env.MaxRetries = 3
	}
	return &gatewayClient{store: store, env: env, http: &http.Client{}}
}

func (g *gatewayClient) Complete(ctx context.Context, req completionRequest) (string, error) {
	profiles, governance, err := g.store.GatewaySettings(ctx)
	if err != nil {
		return "", err
	}
	profile, err := resolveCompletionProfile(profiles, governance, g.env)
	if err != nil {
		return "", err
	}
	models := uniqueModels(append([]string{profile.Model}, profile.FallbackModels...))
	if len(models) == 0 {
		return "", errors.New("completion model is not configured")
	}
	var last error
	for _, model := range models {
		content, err := g.completeModel(ctx, profile, model, req)
		if err == nil {
			return content, nil
		}
		if status, ok := err.(*StatusError); ok {
			return "", status
		}
		last = err
	}
	if last == nil {
		last = errors.New("completion failed")
	}
	return "", last
}

func (g *gatewayClient) completeModel(ctx context.Context, profile completionProfile, model string, req completionRequest) (string, error) {
	attempts := profile.MaxRetries
	if attempts < 1 {
		attempts = 1
	}
	delay := time.Second
	var last error
	for attempt := 0; attempt < attempts; attempt++ {
		content, status, err := g.postCompletion(ctx, profile, model, req)
		if err == nil {
			return content, nil
		}
		last = err
		if !retryable(status, err) || attempt+1 >= attempts {
			return "", err
		}
		if sleepErr := sleep(ctx, delay); sleepErr != nil {
			return "", sleepErr
		}
		if delay < 10*time.Second {
			delay *= 2
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
		}
	}
	return "", last
}

func (g *gatewayClient) postCompletion(ctx context.Context, profile completionProfile, model string, req completionRequest) (string, int, error) {
	payload := map[string]any{
		"temperature": 0.2,
		"top_p":       0.9,
	}
	format := briefResponseFormat(profile.ResponseFormatMode)
	if profile.SendMetadata && req.Metadata != nil {
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
		return "", 0, err
	}
	status, raw, err := g.post(ctx, profile, primary, body)
	if err == nil && (status == http.StatusNotFound || status == http.StatusMethodNotAllowed) {
		status, raw, err = g.post(ctx, profile, fallback, body)
	}
	if err != nil {
		return "", status, err
	}
	if status < 200 || status >= 300 {
		return "", status, errors.New("model gateway request failed")
	}
	content := completionText(raw, profile.APISurface)
	if strings.TrimSpace(content) == "" {
		return "", status, errors.New("model gateway returned empty content")
	}
	return content, status, nil
}

func (g *gatewayClient) post(ctx context.Context, profile completionProfile, path string, body []byte) (int, []byte, error) {
	timeout := profile.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	endpoint := strings.TrimRight(profile.APIBase, "/") + path
	httpReq, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if profile.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+profile.APIKey)
	}
	resp, err := g.http.Do(httpReq)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
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
	if enabled, ok := record["enabled"].(bool); ok && !enabled {
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

func briefJSONSchema() map[string]any {
	point := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"text":      map[string]any{"type": "string", "minLength": 1},
			"citations": map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 1}, "maxItems": 12},
		},
		"required":             []string{"text"},
		"additionalProperties": false,
	}
	points := func(max int) map[string]any {
		return map[string]any{"type": "array", "items": point, "maxItems": max}
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"detailed_summary": map[string]any{"type": "string", "minLength": 1},
			"tldr":             map[string]any{"type": "string", "minLength": 1},
			"key_points":       points(10),
			"why_it_matters":   points(10),
			"latest_update":    point,
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
