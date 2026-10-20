package llmgatewayops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// authModeProfileKey and authModeManagedKey are the two test authentication
// modes. profile_key is the default and never auto-upgrades to the managed key.
const (
	// authModeProfileKey uses the profile (or temporary) apiKey.
	authModeProfileKey = "profile_key"
	// authModeManagedKey uses the governance-managed runtime key.
	authModeManagedKey = "managed_runtime_key"
)

// defaultProfileTimeoutMS is the axios default timeout of a profile request.
const defaultProfileTimeoutMS = 60_000

// healthMaxTimeoutMS caps the diagnostic health probe at ten seconds.
const healthMaxTimeoutMS = 10_000

// modelsResult is {apiBase, models}.
type modelsResult struct {
	APIBase string   `json:"apiBase"`
	Models  []string `json:"models"`
}

// proxyHealthResult is the diagnostic health projection.
type proxyHealthResult struct {
	APIBase    string        `json:"apiBase"`
	CheckedAt  string        `json:"checkedAt"`
	Liveliness endpointCheck `json:"liveliness"`
	Readiness  endpointCheck `json:"readiness"`
}

// proxyModelInfoEntry is one model of /v1/model/info.
type proxyModelInfoEntry struct {
	ModelName     string          `json:"modelName"`
	LitellmParams json.RawMessage `json:"litellmParams,omitempty"`
	ModelInfo     json.RawMessage `json:"modelInfo,omitempty"`
}

// proxyModelInfoResult is the model info projection.
type proxyModelInfoResult struct {
	APIBase         string                `json:"apiBase"`
	CheckedAt       string                `json:"checkedAt"`
	Cached          *bool                 `json:"cached,omitempty"`
	CacheTTLSeconds *int                  `json:"cacheTtlSeconds,omitempty"`
	Models          []proxyModelInfoEntry `json:"models"`
}

// requireProfileConfig loads one saved profile or fails with the contract 404.
// A saved but disabled profile is still returned: diagnostics must work on a
// profile that governance would refuse to target.
func (s *Service) requireProfileConfig(ctx context.Context, profileID string) (llmgatewayprofiles.ResolvedProfileConfig, error) {
	if s.profiles == nil {
		return llmgatewayprofiles.ResolvedProfileConfig{}, errors.New("llmgatewayops: profile port is not configured")
	}
	profile, found, err := s.profiles.RuntimeProfileConfig(ctx, profileID)
	if err != nil {
		return llmgatewayprofiles.ResolvedProfileConfig{}, err
	}
	if !found {
		return llmgatewayprofiles.ResolvedProfileConfig{}, notFound(errorCodeProfileNotFound, "LLM gateway profile not found")
	}
	return profile, nil
}

// requireProfileBase normalizes the profile apiBase or fails with the contract
// 400.
func requireProfileBase(apiBase string) (string, error) {
	base := normalizeAPIBase(apiBase)
	if base == "" {
		return "", codedBadRequest(errorCodeAPIBaseRequired, "apiBase is not configured")
	}
	return base, nil
}

// profileTimeout converts the stored timeout into a request deadline.
func profileTimeout(profile llmgatewayprofiles.ResolvedProfileConfig) time.Duration {
	millis := profile.TimeoutMs
	if millis <= 0 {
		millis = defaultProfileTimeoutMS
	}
	return time.Duration(millis) * time.Millisecond
}

// healthTimeout caps the health deadline at ten seconds.
func healthTimeout(profile llmgatewayprofiles.ResolvedProfileConfig) time.Duration {
	millis := profile.TimeoutMs
	if millis <= 0 {
		millis = defaultProfileTimeoutMS
	}
	if millis > healthMaxTimeoutMS {
		millis = healthMaxTimeoutMS
	}
	return time.Duration(millis) * time.Millisecond
}

// resolveTestingAPIKey mirrors LiteLlmProxyGovernanceService.resolveTestingApiKey.
//
// profile_key returns the fallback key as-is (empty when the profile has none);
// managed_runtime_key requires a saved profile that IS the governed target and
// fails with 400 when it is not, so a diagnostic can never silently fall back to
// the profile key while claiming to validate the managed one.
func (s *Service) resolveTestingAPIKey(ctx context.Context, profileID, apiBase, fallbackKey, authMode string) (string, error) {
	if authMode != authModeManagedKey {
		return normalizeSecret(fallbackKey), nil
	}
	if profileID == "" {
		return "", badRequest("Managed runtime key tests require a saved LiteLLM gateway profile")
	}
	key, governed, err := s.managedRuntimeKeyForProfile(ctx, profileID, apiBase)
	if err != nil {
		return "", err
	}
	if !governed {
		return "", badRequest("Selected profile is not the active LiteLLM governance target")
	}
	return key, nil
}

// managedRuntimeKeyForProfile returns the managed runtime key when the profile IS
// the governed target of the same normalized apiBase.
//
// governed reports "this profile is the target"; a governed profile whose key is
// unreadable or missing is an error, because returning no key would silently
// downgrade the probe to an unauthenticated request.
func (s *Service) managedRuntimeKeyForProfile(ctx context.Context, profileID, apiBase string) (string, bool, error) {
	resolved, _, err := s.loadResolvedGovernance(ctx)
	if err != nil {
		return "", false, err
	}
	if !resolved.Enabled {
		return "", false, nil
	}
	target, err := s.resolveTargetProfile(ctx, resolved.TargetProfileID)
	if err != nil {
		return "", false, err
	}
	if target == nil || !governedProfileMatches(profileID, apiBase, target) {
		return "", false, nil
	}
	if resolved.ManagedRuntimeKeyState == managedKeyUnreadable {
		return "", true, serviceUnavailable("LiteLLM governance is enabled but the managed runtime key is unreadable")
	}
	if resolved.ManagedRuntimeKey == "" {
		return "", true, serviceUnavailable("LiteLLM governance is enabled but the managed runtime key is missing")
	}
	return resolved.ManagedRuntimeKey, true, nil
}

// governedProfileMatches compares the profile id and the normalized apiBase, so an
// endpoint-suffixed spelling of the same host still matches.
func governedProfileMatches(profileID, apiBase string, target *governanceTargetProfile) bool {
	candidate := normalizeAPIBase(apiBase)
	targetBase := normalizeAPIBase(target.APIBase)
	if candidate == "" || targetBase == "" {
		return false
	}
	return profileID == target.ID && candidate == targetBase
}

// ListModels serves GET /:id/models.
func (s *Service) ListModels(ctx context.Context, profileID string) (modelsResult, error) {
	profile, err := s.requireProfileConfig(ctx, profileID)
	if err != nil {
		return modelsResult{}, err
	}
	base, err := requireProfileBase(profile.APIBase)
	if err != nil {
		return modelsResult{}, err
	}
	apiKey, err := s.resolveTestingAPIKey(ctx, profileID, base, profile.APIKey, authModeProfileKey)
	if err != nil {
		return modelsResult{}, err
	}
	client := newUpstreamClient(s.http, base, apiKey, profileTimeout(profile))
	response, err := client.getWithFallback(ctx, "/v1/models", "/models")
	if err != nil {
		info := toGatewayErrorInfo(err, errorContext{apiKeyConfigured: boolPointer(apiKey != "")})
		return modelsResult{}, throwGatewayError(info)
	}
	return modelsResult{APIBase: base, Models: normalizeModels(response.body)}, nil
}

// ListModelsConfig serves POST /models-config.
//
// The apiKey field distinguishes three cases: omitted or null reuses the stored
// profile key, an explicit string (even "") replaces it, and a pasted
// "Bearer sk-..." value is normalized. The profile only has to exist, not to be
// enabled or to match its stored apiBase.
func (s *Service) ListModelsConfig(ctx context.Context, input modelsConfigInput) (modelsResult, error) {
	var stored *llmgatewayprofiles.ResolvedProfileConfig
	if input.ProfileID != nil && *input.ProfileID != "" {
		profile, err := s.requireProfileConfig(ctx, *input.ProfileID)
		if err != nil {
			return modelsResult{}, err
		}
		stored = &profile
	}
	base, err := requireProfileBase(input.APIBase)
	if err != nil {
		return modelsResult{}, err
	}

	fallbackKey := ""
	if stored != nil {
		fallbackKey = stored.APIKey
	}
	if input.APIKeySet {
		fallbackKey = input.APIKey
	}
	profileID := ""
	if input.ProfileID != nil {
		profileID = *input.ProfileID
	}
	apiKey, err := s.resolveTestingAPIKey(ctx, profileID, base, fallbackKey, authModeProfileKey)
	if err != nil {
		return modelsResult{}, err
	}

	timeoutMS := defaultProfileTimeoutMS
	if input.TimeoutMS != nil {
		timeoutMS = *input.TimeoutMS
	} else if stored != nil && stored.TimeoutMs > 0 {
		timeoutMS = int(stored.TimeoutMs)
	}
	client := newUpstreamClient(s.http, base, apiKey, time.Duration(timeoutMS)*time.Millisecond)
	response, err := client.getWithFallback(ctx, "/v1/models", "/models")
	if err != nil {
		info := toGatewayErrorInfo(err, errorContext{apiKeyConfigured: boolPointer(apiKey != "")})
		return modelsResult{}, throwGatewayError(info)
	}
	return modelsResult{APIBase: base, Models: normalizeModels(response.body)}, nil
}

// CheckProxyHealth serves GET /:id/proxy-health.
//
// The two endpoints run in parallel, each with its own deadline, and a failure of
// one is reported as ok=false instead of failing the whole request. A 2xx HTML
// page is treated as a failure: it means something other than a LiteLLM proxy
// answered the health path.
func (s *Service) CheckProxyHealth(ctx context.Context, profileID string) (proxyHealthResult, error) {
	profile, err := s.requireProfileConfig(ctx, profileID)
	if err != nil {
		return proxyHealthResult{}, err
	}
	base, err := requireProfileBase(profile.APIBase)
	if err != nil {
		return proxyHealthResult{}, err
	}
	apiKey, err := s.resolveTestingAPIKey(ctx, profileID, base, profile.APIKey, authModeProfileKey)
	if err != nil {
		return proxyHealthResult{}, err
	}
	timeout := healthTimeout(profile)
	client := newUpstreamClient(s.http, base, apiKey, timeout)

	type endpointResult struct {
		check endpointCheck
	}
	livelinessCh := make(chan endpointResult, 1)
	readinessCh := make(chan endpointResult, 1)
	go func() {
		livelinessCh <- endpointResult{check: checkDiagnosticEndpoint(ctx, client, "/health/liveliness", apiKey != "")}
	}()
	go func() {
		readinessCh <- endpointResult{check: checkDiagnosticEndpoint(ctx, client, "/health/readiness", apiKey != "")}
	}()
	liveliness := <-livelinessCh
	readiness := <-readinessCh
	return proxyHealthResult{
		APIBase:    base,
		CheckedAt:  s.nowUTC().Format("2006-01-02T15:04:05.000Z"),
		Liveliness: liveliness.check,
		Readiness:  readiness.check,
	}, nil
}

// checkDiagnosticEndpoint mirrors the diagnostic checkProxyEndpoint: the status
// is kept, an HTML body turns a 2xx into a failure, and the error message loses
// the generic "LLM gateway request failed" prefix.
func checkDiagnosticEndpoint(ctx context.Context, client upstreamClient, path string, apiKeyConfigured bool) endpointCheck {
	response, err := client.get(ctx, path)
	if err != nil {
		info := toGatewayErrorInfo(err, errorContext{apiKeyConfigured: boolPointer(apiKeyConfigured)})
		message := stripGatewayFailurePrefix(info.Message)
		check := endpointCheck{OK: false}
		if info.Status != nil {
			status := *info.Status
			check.Status = &status
		}
		check.Message = &message
		return check
	}
	status := response.status
	ok := status >= http.StatusOK && status < http.StatusMultipleChoices
	if ok {
		contentType := strings.ToLower(response.header.Get("content-type"))
		hasHTMLContentType := strings.Contains(contentType, "text/html")
		hasHTMLBody := htmlBodyPattern.Match(response.body)
		if hasHTMLContentType || hasHTMLBody {
			message := "Unexpected HTML response (not a LiteLLM Proxy health endpoint)."
			return endpointCheck{OK: false, Status: &status, Message: &message}
		}
	}
	return endpointCheck{OK: ok, Status: &status}
}

// stripGatewayFailurePrefix mirrors the `replace(/^LLM gateway request failed\s*/i, "")`
// the health check applies to an error message.
func stripGatewayFailurePrefix(message string) string {
	const prefix = "LLM gateway request failed"
	if len(message) >= len(prefix) && strings.EqualFold(message[:len(prefix)], prefix) {
		trimmed := strings.TrimSpace(message[len(prefix):])
		if trimmed == "" {
			return "Proxy health check failed"
		}
		return trimmed
	}
	if strings.TrimSpace(message) == "" {
		return "Proxy health check failed"
	}
	return message
}

// htmlBodyPattern detects a doctype or html tag at the start of a body.
var htmlBodyPattern = regexp.MustCompile(`(?i)<\s*!doctype\s+html|<\s*html\b`)

// GetProxyModelInfo serves GET /:id/proxy-model-info.
//
// force ("1" or "true") SKIPS both the cache read and the cache write; it is not
// a refresh that repopulates the entry. The cache key hashes the normalized base,
// so an endpoint-suffixed spelling of one host shares a single entry.
func (s *Service) GetProxyModelInfo(ctx context.Context, profileID string, force bool) (proxyModelInfoResult, error) {
	profile, err := s.requireProfileConfig(ctx, profileID)
	if err != nil {
		return proxyModelInfoResult{}, err
	}
	base, err := requireProfileBase(profile.APIBase)
	if err != nil {
		return proxyModelInfoResult{}, err
	}
	cacheKey := proxyModelInfoCacheKey(profileID, base)
	if !force {
		if cached, ok, cacheErr := s.cacheGetJSON(ctx, cacheKey); cacheErr != nil {
			logCacheFailure("read", cacheKey, cacheErr)
		} else if ok {
			var result proxyModelInfoResult
			if decodeErr := json.Unmarshal(cached, &result); decodeErr != nil {
				logCacheFailure("decode", cacheKey, decodeErr)
			} else {
				cachedFlag := true
				ttl := modelInfoCacheTTLSeconds
				result.Cached = &cachedFlag
				result.CacheTTLSeconds = &ttl
				if result.Models == nil {
					result.Models = []proxyModelInfoEntry{}
				}
				return result, nil
			}
		}
	}

	apiKey, err := s.resolveTestingAPIKey(ctx, profileID, base, profile.APIKey, authModeProfileKey)
	if err != nil {
		return proxyModelInfoResult{}, err
	}
	timeout := profileTimeout(profile)
	client := newUpstreamClient(s.http, base, apiKey, timeout)
	response, err := client.getWithFallback(ctx, "/v1/model/info", "/model/info")
	if err != nil {
		info := toGatewayErrorInfo(err, errorContext{apiKeyConfigured: boolPointer(apiKey != "")})
		return proxyModelInfoResult{}, throwGatewayError(info)
	}

	models := normalizeProxyModelInfoEntries(response.body)
	result := proxyModelInfoResult{
		APIBase:   base,
		CheckedAt: s.nowUTC().Format("2006-01-02T15:04:05.000Z"),
		Models:    models,
	}
	if !force {
		payload, marshalErr := json.Marshal(result)
		if marshalErr == nil {
			if cacheErr := s.cacheSetJSON(ctx, cacheKey, payload, modelInfoCacheTTLSeconds); cacheErr != nil {
				logCacheFailure("write", cacheKey, cacheErr)
			}
		}
	}
	return result, nil
}

// proxyModelInfoCacheKey mirrors buildProxyModelInfoCacheKey.
func proxyModelInfoCacheKey(profileID, normalizedBase string) string {
	digest := sha256.Sum256([]byte(normalizedBase))
	return modelInfoCachePrefix + profileID + ":" + hex.EncodeToString(digest[:])[:16]
}

// normalizeProxyModelInfoEntries mirrors the NestJS `Array.isArray(response.data?.models)`
// read: any 2xx body that does not carry a models array yields an EMPTY list, not
// a failure. The source never throws on a body it cannot read, and turning a
// non-object payload into a 503 would invent an error NestJS does not return.
func normalizeProxyModelInfoEntries(body []byte) []proxyModelInfoEntry {
	var envelope struct {
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return []proxyModelInfoEntry{}
	}
	rawEntries, isArray := jsonArrayItems(envelope.Models)
	if !isArray {
		return []proxyModelInfoEntry{}
	}
	entries := make([]proxyModelInfoEntry, 0, len(rawEntries))
	for _, raw := range rawEntries {
		entry, ok := normalizeProxyModelInfoEntry(raw)
		if !ok {
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

// normalizeProxyModelInfoEntry mirrors normalizeProxyModelInfoEntry.
func normalizeProxyModelInfoEntry(raw json.RawMessage) (proxyModelInfoEntry, bool) {
	value, err := parseFlexValue(raw)
	if err != nil || value.kind != flexObject {
		return proxyModelInfoEntry{}, false
	}
	modelName, ok := flexStringMember(value, "model_name")
	if !ok || strings.TrimSpace(modelName) == "" {
		return proxyModelInfoEntry{}, false
	}
	entry := proxyModelInfoEntry{ModelName: strings.TrimSpace(modelName)}
	for _, member := range []struct {
		key  string
		dest *json.RawMessage
	}{
		{"litellm_params", &entry.LitellmParams},
		{"model_info", &entry.ModelInfo},
	} {
		leaf, present := flexMemberOf(value, member.key)
		if !present || leaf.kind != flexObject {
			continue
		}
		encoded, encodeErr := sanitizedModelInfoValue(leaf).MarshalJSON()
		if encodeErr != nil {
			continue
		}
		*member.dest = json.RawMessage(encoded)
	}
	return entry, true
}

// normalizeModels mirrors normalizeModels: an array, or an object with a data or
// models array, whose entries are strings or {"id": "..."}. Values are trimmed,
// de-duplicated and keep their first-seen order.
func normalizeModels(body []byte) []string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return []string{}
	}
	var raw json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return []string{}
	}
	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Models json.RawMessage `json:"models"`
	}
	if strings.HasPrefix(trimmed, "[") {
		return normalizeModelArray(raw)
	}
	if strings.HasPrefix(trimmed, "{") {
		if err := json.Unmarshal(body, &envelope); err != nil {
			return []string{}
		}
		if strings.HasPrefix(strings.TrimSpace(string(envelope.Data)), "[") {
			return normalizeModelArray(envelope.Data)
		}
		if strings.HasPrefix(strings.TrimSpace(string(envelope.Models)), "[") {
			return normalizeModelArray(envelope.Models)
		}
	}
	return []string{}
}

// normalizeModelArray flattens one array of strings or {"id"} objects.
func normalizeModelArray(raw json.RawMessage) []string {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return []string{}
	}
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, item := range items {
		token := strings.TrimSpace(string(item))
		if token == "" {
			continue
		}
		candidate := ""
		if token[0] == '"' {
			text, ok := jsonStringValue(item)
			if !ok {
				continue
			}
			candidate = text
		} else if token[0] == '{' {
			var entry struct {
				ID json.RawMessage `json:"id"`
			}
			if err := json.Unmarshal(item, &entry); err != nil {
				continue
			}
			text, ok := jsonStringValue(entry.ID)
			if !ok {
				continue
			}
			candidate = text
		} else {
			continue
		}
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || seen[candidate] {
			continue
		}
		seen[candidate] = true
		out = append(out, candidate)
	}
	return out
}

// boolPointer builds an optional bool for the error context.
func boolPointer(value bool) *bool { return &value }

// probeLogContext carries the attribution of one probe attempt. APIKeyConfigured
// travels with it because the persisted error text of a 401/403 depends on
// whether a key was sent, exactly like the HTTP-facing error.
type probeLogContext struct {
	OrgID            string
	UserID           string
	ProfileID        string
	AuthMode         string
	APIKeyConfigured bool
}

// Diagnostic surface literals. They are the `apiSurface` values of the response
// and of the request log.
const (
	// surfaceChat is the chat/completions surface.
	surfaceChat = "chat_completions"
	// surfaceResponses is the Responses API surface.
	surfaceResponses = "responses"
	// surfaceEmbeddings is the embeddings surface.
	surfaceEmbeddings = "embeddings"
	// surfaceRerank is the rerank surface.
	surfaceRerank = "rerank"
)

// logSurface maps one diagnostic surface onto the log surface.
func logSurface(value string) llmlogs.ProbeAPISurface {
	switch value {
	case surfaceChat:
		return llmlogs.ProbeSurfaceChatCompletions
	case surfaceResponses:
		return llmlogs.ProbeSurfaceResponses
	case surfaceEmbeddings:
		return llmlogs.ProbeSurfaceEmbeddings
	case surfaceRerank:
		return llmlogs.ProbeSurfaceRerank
	default:
		return ""
	}
}

// ManagedRuntimeCredentials resolves the LiteLLM managed governance override for
// one gateway profile, mirroring LiteLlmProxyGovernanceService's
// getManagedRuntimeApiKeyForProfile + getGovernedApiBaseForProfile pair.
//
// governed is false when governance is disabled or the profile/apiBase is not the
// governed target; the caller then keeps the profile's own credentials. A
// governed profile whose managed key is unreadable or missing returns the same
// 503 the NestJS service raises.
func (s *Service) ManagedRuntimeCredentials(ctx context.Context, profileID, apiBase string) (string, string, bool, error) {
	resolved, _, err := s.loadResolvedGovernance(ctx)
	if err != nil {
		return "", "", false, err
	}
	if !resolved.Enabled {
		return "", "", false, nil
	}
	target, err := s.resolveTargetProfile(ctx, resolved.TargetProfileID)
	if err != nil {
		return "", "", false, err
	}
	if target == nil || !governedProfileMatches(profileID, apiBase, target) {
		return "", "", false, nil
	}
	if resolved.ManagedRuntimeKeyState == managedKeyUnreadable {
		return "", "", true, serviceUnavailable("LiteLLM governance is enabled but the managed runtime key is unreadable")
	}
	if resolved.ManagedRuntimeKey == "" {
		return "", "", true, serviceUnavailable("LiteLLM governance is enabled but the managed runtime key is missing")
	}
	return target.APIBase, resolved.ManagedRuntimeKey, true, nil
}
