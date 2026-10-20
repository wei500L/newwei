package litellmcompat

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

var (
	// ErrCompletionUnavailable means no completion profile is configured.
	ErrCompletionUnavailable = errors.New("LiteLLM completion model is not configured")
	// ErrEmbeddingUnavailable means no embedding profile is configured.
	ErrEmbeddingUnavailable = errors.New("LiteLLM embedding model is not configured in MySQL gateway profiles")
	// ErrRerankUnavailable means no rerank profile is configured.
	ErrRerankUnavailable = errors.New("LiteLLM rerank model is not configured in MySQL gateway profiles")
)

const (
	gatewaySettingsKey    = "llm_gateway_profiles"
	governanceSettingsKey = "litellm_proxy_governance"
	assistantSafetyKey    = "assistant_safety"

	openAIModerationPreGuardrail  = "openai-moderation-pre"
	openAIModerationPostGuardrail = "openai-moderation-post"
)

// Config carries the resolved environment defaults mirrored from NestJS.
type Config struct {
	EncryptionKey              string
	APIBase                    string
	APIKey                     string
	Timeout                    time.Duration
	MaxRetries                 int
	DefaultModel               string
	DefaultTemperature         float64
	DefaultTopP                float64
	DefaultMaxOutputTokens     int
	DefaultFallbackModels      []string
	AssistantGuardrailsEnabled bool
	AssistantGuardrailsRaw     string
	Logger                     func(format string, args ...any)
}

// gatewayProfile is the normalized profile projection of
// LlmGatewaySettingsService.normalizeProfile.
type gatewayProfile struct {
	ID                        string
	Name                      string
	APIBase                   string
	APIKey                    string
	Model                     string
	EmbeddingModel            string
	RerankModel               string
	FallbackModels            []string
	RerankFallbackModels      []string
	Timeout                   time.Duration
	Temperature               float64
	TopP                      float64
	MaxOutputTokens           int
	MaxRetries                int
	SendMetadata              bool
	ResponseFormatMode        ResponseFormatMode
	APISurface                APISurface
	Enabled                   bool
	GovernanceApplied         bool
	AuthMode                  string
	GovernanceTargetProfileID string
}

type gatewaySettings struct {
	ActiveID          string
	EmbeddingActiveID string
	EmbeddingMode     string
	RerankActiveID    string
	RerankMode        string
	Profiles          []gatewayProfile
}

func (c *Client) loadSetting(ctx context.Context, key string) (json.RawMessage, bool, error) {
	if c != nil && c.loadRow != nil {
		return c.loadRow(ctx, key)
	}
	if c == nil || c.db == nil {
		return nil, false, errors.New("litellmcompat: mysql is not configured")
	}
	var raw []byte
	err := c.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

// loadGatewaySettings reads and normalizes the profile document. The NestJS
// 60 second Redis cache is intentionally not reproduced; the authoritative
// SystemSetting row is read once per model call group.
func (c *Client) loadGatewaySettings(ctx context.Context) (gatewaySettings, error) {
	raw, ok, err := c.loadSetting(ctx, gatewaySettingsKey)
	if err != nil {
		return gatewaySettings{}, err
	}
	settings := gatewaySettings{
		EmbeddingMode: "follow_completion",
		RerankMode:    "follow_completion",
	}
	if !ok || len(bytes.TrimSpace(raw)) == 0 {
		return settings, nil
	}
	var doc struct {
		ActiveID          json.RawMessage   `json:"activeId"`
		EmbeddingActiveID json.RawMessage   `json:"embeddingActiveId"`
		EmbeddingMode     json.RawMessage   `json:"embeddingMode"`
		RerankActiveID    json.RawMessage   `json:"rerankActiveId"`
		RerankMode        json.RawMessage   `json:"rerankMode"`
		Profiles          []json.RawMessage `json:"profiles"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return settings, nil
	}
	if stringValue(doc.EmbeddingMode) == "use_default" {
		settings.EmbeddingMode = "use_default"
	}
	if stringValue(doc.RerankMode) == "use_default" {
		settings.RerankMode = "use_default"
	}
	for _, entry := range doc.Profiles {
		profile, ok := c.normalizeProfile(entry)
		if ok {
			settings.Profiles = append(settings.Profiles, profile)
		}
	}
	if profile := findGatewayProfile(settings.Profiles, stringValue(doc.ActiveID)); profile != nil && profile.Enabled {
		settings.ActiveID = profile.ID
	}
	if profile := findGatewayProfile(settings.Profiles, stringValue(doc.EmbeddingActiveID)); profile != nil && profile.Enabled && profile.EmbeddingModel != "" {
		settings.EmbeddingActiveID = profile.ID
	}
	if profile := findGatewayProfile(settings.Profiles, stringValue(doc.RerankActiveID)); profile != nil && profile.Enabled && profile.RerankModel != "" {
		settings.RerankActiveID = profile.ID
	}
	return settings, nil
}

func findGatewayProfile(profiles []gatewayProfile, id string) *gatewayProfile {
	if id == "" {
		return nil
	}
	for index := range profiles {
		if profiles[index].ID == id {
			return &profiles[index]
		}
	}
	return nil
}

func (c *Client) normalizeProfile(raw json.RawMessage) (gatewayProfile, bool) {
	var record struct {
		ID                   json.RawMessage `json:"id"`
		Name                 json.RawMessage `json:"name"`
		APIBase              json.RawMessage `json:"apiBase"`
		APIKey               json.RawMessage `json:"apiKey"`
		Model                json.RawMessage `json:"model"`
		EmbeddingModel       json.RawMessage `json:"embeddingModel"`
		RerankModel          json.RawMessage `json:"rerankModel"`
		RerankFallbackModels json.RawMessage `json:"rerankFallbackModels"`
		TimeoutMS            json.RawMessage `json:"timeoutMs"`
		Temperature          json.RawMessage `json:"temperature"`
		TopP                 json.RawMessage `json:"topP"`
		MaxOutputTokens      json.RawMessage `json:"maxOutputTokens"`
		MaxRetries           json.RawMessage `json:"maxRetries"`
		FallbackModels       json.RawMessage `json:"fallbackModels"`
		SendMetadata         json.RawMessage `json:"sendMetadata"`
		ResponseFormatMode   json.RawMessage `json:"responseFormatMode"`
		APISurface           json.RawMessage `json:"apiSurface"`
		Enabled              json.RawMessage `json:"enabled"`
	}
	if len(bytes.TrimSpace(raw)) == 0 || json.Unmarshal(raw, &record) != nil {
		return gatewayProfile{}, false
	}
	id := stringValue(record.ID)
	model := stringValue(record.Model)
	if id == "" || model == "" {
		return gatewayProfile{}, false
	}
	name := stringValue(record.Name)
	if name == "" {
		name = id
	}
	apiBase := stringValue(record.APIBase)
	if apiBase == "" {
		apiBase = c.cfg.APIBase
	}
	enabled := true
	if trimmed := bytes.TrimSpace(record.Enabled); len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
		var value bool
		enabled = json.Unmarshal(trimmed, &value) == nil && value
	}
	profile := gatewayProfile{
		ID:                   id,
		Name:                 name,
		APIBase:              apiBase,
		APIKey:               c.resolveSecret(record.APIKey),
		Model:                model,
		EmbeddingModel:       optionalStringValue(record.EmbeddingModel),
		RerankModel:          optionalStringValue(record.RerankModel),
		RerankFallbackModels: stringList(record.RerankFallbackModels),
		FallbackModels:       stringList(record.FallbackModels),
		Timeout:              time.Duration(positiveInt(record.TimeoutMS, int(c.cfg.Timeout/time.Millisecond), 1)) * time.Millisecond,
		Temperature:          clampFloat(record.Temperature, c.cfg.DefaultTemperature, 0, 2),
		TopP:                 clampFloat(record.TopP, c.cfg.DefaultTopP, 0, 1),
		MaxOutputTokens:      positiveInt(record.MaxOutputTokens, c.cfg.DefaultMaxOutputTokens, 1),
		MaxRetries:           positiveInt(record.MaxRetries, c.cfg.MaxRetries, 1),
		SendMetadata:         booleanValue(record.SendMetadata, true),
		ResponseFormatMode:   responseFormatMode(record.ResponseFormatMode),
		APISurface:           apiSurface(record.APISurface),
		Enabled:              enabled,
	}
	return profile, true
}

func (c *Client) resolveSecret(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var value string
		if json.Unmarshal(trimmed, &value) == nil {
			return llmembed.NormalizeGatewaySecret(value)
		}
		return ""
	}
	if plain, ok := llmembed.DecryptSettingsSecret(trimmed, c.cfg.EncryptionKey); ok {
		return llmembed.NormalizeGatewaySecret(plain)
	}
	return ""
}

func (c *Client) resolveCompletion(ctx context.Context) (gatewayProfile, error) {
	settings, err := c.loadGatewaySettings(ctx)
	if err != nil {
		return gatewayProfile{}, err
	}
	profile := findGatewayProfile(settings.Profiles, settings.ActiveID)
	if profile == nil || !profile.Enabled {
		profile = defaultGatewayProfile(settings.Profiles, "completion")
	}
	if profile == nil {
		return gatewayProfile{}, ErrCompletionUnavailable
	}
	return c.applyGovernance(ctx, settings.Profiles, *profile)
}

func (c *Client) resolveEmbedding(ctx context.Context) (gatewayProfile, error) {
	settings, err := c.loadGatewaySettings(ctx)
	if err != nil {
		return gatewayProfile{}, err
	}
	profile := resolveKindProfile(settings, "embedding")
	if profile == nil {
		return gatewayProfile{}, ErrEmbeddingUnavailable
	}
	return c.applyGovernance(ctx, settings.Profiles, *profile)
}

func (c *Client) resolveRerank(ctx context.Context) (gatewayProfile, error) {
	settings, err := c.loadGatewaySettings(ctx)
	if err != nil {
		return gatewayProfile{}, err
	}
	profile := resolveKindProfile(settings, "rerank")
	if profile == nil {
		return gatewayProfile{}, ErrRerankUnavailable
	}
	return c.applyGovernance(ctx, settings.Profiles, *profile)
}

func resolveKindProfile(settings gatewaySettings, kind string) *gatewayProfile {
	var resolvedID, mode string
	var model func(gatewayProfile) string
	if kind == "embedding" {
		resolvedID, mode = settings.EmbeddingActiveID, settings.EmbeddingMode
		model = func(profile gatewayProfile) string { return profile.EmbeddingModel }
	} else {
		resolvedID, mode = settings.RerankActiveID, settings.RerankMode
		model = func(profile gatewayProfile) string { return profile.RerankModel }
	}
	if resolvedID == "" && mode != "use_default" {
		resolvedID = settings.ActiveID
	}
	if profile := findGatewayProfile(settings.Profiles, resolvedID); profile != nil && profile.Enabled && model(*profile) != "" {
		return profile
	}
	if mode == "use_default" || resolvedID == "" {
		return defaultGatewayProfile(settings.Profiles, kind)
	}
	return nil
}

func defaultGatewayProfile(profiles []gatewayProfile, kind string) *gatewayProfile {
	for index := range profiles {
		profile := &profiles[index]
		if !profile.Enabled {
			continue
		}
		if kind == "embedding" && profile.EmbeddingModel == "" {
			continue
		}
		if kind == "rerank" && profile.RerankModel == "" {
			continue
		}
		return profile
	}
	return nil
}

// RuntimeEmbeddingModel mirrors getEmbeddingModel: a missing profile is
// (not configured), a configuration read failure is an error.
func (c *Client) RuntimeEmbeddingModel(ctx context.Context) (RuntimeModel, error) {
	profile, err := c.resolveEmbedding(ctx)
	if errors.Is(err, ErrEmbeddingUnavailable) {
		return RuntimeModel{}, nil
	}
	if err != nil {
		return RuntimeModel{}, err
	}
	model := strings.TrimSpace(profile.EmbeddingModel)
	return RuntimeModel{Model: model, Configured: model != ""}, nil
}

// RuntimeRerankModel mirrors getRerankModel.
func (c *Client) RuntimeRerankModel(ctx context.Context) (RuntimeModel, error) {
	profile, err := c.resolveRerank(ctx)
	if errors.Is(err, ErrRerankUnavailable) {
		return RuntimeModel{}, nil
	}
	if err != nil {
		return RuntimeModel{}, err
	}
	model := strings.TrimSpace(profile.RerankModel)
	return RuntimeModel{Model: model, Configured: model != ""}, nil
}

// managedGovernance is the resolved litellm_proxy_governance state.
type managedGovernance struct {
	Enabled  bool
	TargetID string
	Key      string
	KeyState string
}

func (c *Client) loadGovernance(ctx context.Context) (managedGovernance, error) {
	raw, ok, err := c.loadSetting(ctx, governanceSettingsKey)
	if err != nil {
		return managedGovernance{}, err
	}
	if !ok || len(bytes.TrimSpace(raw)) == 0 {
		return managedGovernance{KeyState: "missing"}, nil
	}
	var doc struct {
		Enabled    json.RawMessage `json:"enabled"`
		TargetID   json.RawMessage `json:"targetProfileId"`
		RuntimeKey json.RawMessage `json:"managedRuntimeKey"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return managedGovernance{KeyState: "missing"}, nil
	}
	state := managedGovernance{
		Enabled:  booleanValue(doc.Enabled, false),
		TargetID: stringValue(doc.TargetID),
	}
	state.Key, state.KeyState = c.resolveGovernanceKey(doc.RuntimeKey)
	return state, nil
}

func (c *Client) resolveGovernanceKey(raw json.RawMessage) (string, string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", "missing"
	}
	if trimmed[0] == '"' {
		var value string
		if json.Unmarshal(trimmed, &value) != nil {
			return "", "missing"
		}
		value = strings.TrimSpace(value)
		if value == "" {
			return "", "missing"
		}
		return value, "available"
	}
	if !llmembed.IsEncryptedSettingsSecret(trimmed) {
		return "", "missing"
	}
	if strings.TrimSpace(c.cfg.EncryptionKey) == "" {
		return "", "unreadable"
	}
	plain, ok := llmembed.DecryptSettingsSecret(trimmed, c.cfg.EncryptionKey)
	if !ok {
		return "", "unreadable"
	}
	plain = strings.TrimSpace(plain)
	if plain == "" {
		return "", "missing"
	}
	return plain, "available"
}

func (c *Client) applyGovernance(ctx context.Context, profiles []gatewayProfile, profile gatewayProfile) (gatewayProfile, error) {
	gov, err := c.loadGovernance(ctx)
	if err != nil {
		return gatewayProfile{}, err
	}
	if !gov.Enabled || gov.TargetID == "" {
		return profile, nil
	}
	target := findGatewayProfile(profiles, gov.TargetID)
	if target == nil || !target.Enabled {
		return profile, nil
	}
	candidateBase := llmembed.NormalizeGatewayAPIBase(profile.APIBase)
	targetBase := llmembed.NormalizeGatewayAPIBase(target.APIBase)
	if candidateBase == "" || targetBase == "" || profile.ID != target.ID || candidateBase != targetBase {
		return profile, nil
	}
	if gov.KeyState == "unreadable" {
		return gatewayProfile{}, errors.New("LiteLLM governance is enabled but the managed runtime key is unreadable")
	}
	if gov.Key == "" {
		return gatewayProfile{}, errors.New("LiteLLM governance is enabled but the managed runtime key is missing")
	}
	profile.APIBase = target.APIBase
	profile.APIKey = gov.Key
	profile.GovernanceApplied = true
	profile.AuthMode = "managed_runtime_key"
	profile.GovernanceTargetProfileID = target.ID
	return profile, nil
}

func (p gatewayProfile) authMode() string {
	if p.AuthMode != "" {
		return p.AuthMode
	}
	return "profile_key"
}

// requestGuardrails reproduces withResolvedGuardrails: explicit guardrails win
// (an empty explicit list disables them), otherwise untrusted-content metadata
// enables the pre-moderation guardrail when assistant safety is enabled.
func (c *Client) requestGuardrails(ctx context.Context, explicit []string, metadata Metadata) ([]string, error) {
	if explicit != nil {
		return normalizeGuardrails(explicit), nil
	}
	if metadata == nil {
		return nil, nil
	}
	tokens := metadataFeatureTokens(metadata)
	untrusted := false
	for _, token := range tokens {
		switch token {
		case "news-pipeline", "news-classifier", "clean", "crawl_article_repair":
			untrusted = true
		}
	}
	if !untrusted {
		return nil, nil
	}
	enabled := c.cfg.AssistantGuardrailsEnabled
	outputModeration := false
	for _, entry := range strings.Split(c.cfg.AssistantGuardrailsRaw, ",") {
		if strings.TrimSpace(entry) == openAIModerationPostGuardrail {
			outputModeration = true
		}
	}
	if raw, ok, err := c.loadSetting(ctx, assistantSafetyKey); err != nil {
		return nil, err
	} else if ok && len(bytes.TrimSpace(raw)) > 0 {
		var doc struct {
			Enabled                 json.RawMessage `json:"enabled"`
			OutputModerationEnabled json.RawMessage `json:"outputModerationEnabled"`
		}
		if json.Unmarshal(raw, &doc) == nil {
			if typed, present := boolPointer(doc.Enabled); present {
				enabled = typed
			}
			if typed, present := boolPointer(doc.OutputModerationEnabled); present {
				outputModeration = typed
			}
		}
	}
	if !enabled {
		return nil, nil
	}
	guardrails := []string{openAIModerationPreGuardrail}
	if outputModeration {
		guardrails = append(guardrails, openAIModerationPostGuardrail)
	}
	return guardrails, nil
}

func normalizeGuardrails(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// --- JSON value helpers ---

func stringValue(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return ""
	}
	var value string
	if json.Unmarshal(trimmed, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func optionalStringValue(raw json.RawMessage) string { return stringValue(raw) }

func boolPointer(raw json.RawMessage) (bool, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return false, false
	}
	var value bool
	if json.Unmarshal(trimmed, &value) != nil {
		return false, false
	}
	return value, true
}

func booleanValue(raw json.RawMessage, fallback bool) bool {
	value, present := boolPointer(raw)
	if !present {
		return fallback
	}
	return value
}

func positiveInt(raw json.RawMessage, fallback, minimum int) int {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return fallback
	}
	var number float64
	if json.Unmarshal(trimmed, &number) != nil || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return fallback
	}
	value := int(math.Floor(number))
	if value < minimum {
		return minimum
	}
	return value
}

func clampFloat(raw json.RawMessage, fallback, minimum, maximum float64) float64 {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return fallback
	}
	var number float64
	if json.Unmarshal(trimmed, &number) != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return fallback
	}
	if number < minimum {
		return minimum
	}
	if number > maximum {
		return maximum
	}
	return number
}

func stringList(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil
	}
	var values []json.RawMessage
	if json.Unmarshal(trimmed, &values) != nil {
		return nil
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		text := stringValue(value)
		if text == "" {
			continue
		}
		if _, ok := seen[text]; ok {
			continue
		}
		seen[text] = struct{}{}
		out = append(out, text)
	}
	return out
}

func responseFormatMode(raw json.RawMessage) ResponseFormatMode {
	switch stringValue(raw) {
	case "none":
		return ResponseFormatNone
	case "json_object":
		return ResponseFormatJSONObject
	case "json_schema":
		return ResponseFormatJSONSchema
	default:
		return ResponseFormatJSONSchema
	}
}

func apiSurface(raw json.RawMessage) APISurface {
	switch stringValue(raw) {
	case "responses":
		return APISurfaceResponses
	default:
		return APISurfaceChat
	}
}

func (c *Client) timeout(profile gatewayProfile, request time.Duration) time.Duration {
	if request > 0 {
		return request
	}
	if profile.Timeout > 0 {
		return profile.Timeout
	}
	if c.cfg.Timeout > 0 {
		return c.cfg.Timeout
	}
	return 60 * time.Second
}
