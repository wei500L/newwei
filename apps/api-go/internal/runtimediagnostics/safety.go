package runtimediagnostics

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

// ProfilePort is the narrow profile surface the assistant safety diagnostics
// needs: the current runtime bindings and one resolved profile.
type ProfilePort interface {
	RuntimeBindings(ctx context.Context) (llmgatewayprofiles.RuntimeBindings, error)
	RuntimeProfileConfig(ctx context.Context, id string) (llmgatewayprofiles.ResolvedProfileConfig, bool, error)
}

// GovernancePort resolves the managed LiteLLM governance override.
type GovernancePort interface {
	ManagedRuntimeCredentials(ctx context.Context, profileID, apiBase string) (string, string, bool, error)
}

// SafetySettingsPort is the assistant safety settings projection.
type SafetySettingsPort interface {
	AssistantSafetyPublicSettings(ctx context.Context) (platformgovernance.AssistantSafetySettingsResponse, error)
}

// OpenAIKeysPort is the OpenAI keys public projection (keysCount).
type OpenAIKeysPort interface {
	PublicOpenAiKeysSettings(ctx context.Context) (modelaccesssettings.OpenAiKeysPublicSettings, error)
}

// SafetyService serves GET /api/system-settings/assistant-safety/diagnostics. It
// performs three independent LiteLLM probes and compares the configured
// guardrails with the expected list derived from the safety settings and the
// OpenAI key count.
type SafetyService struct {
	profiles   ProfilePort
	governance GovernancePort
	safety     SafetySettingsPort
	openaiKeys OpenAIKeysPort
	envBase    string
	envKey     string
	http       *http.Client
	now        func() time.Time
}

// NewSafetyService wires the diagnostics. The HTTP client is owned by the
// service: each probe applies its own request deadline.
func NewSafetyService(profiles ProfilePort, governance GovernancePort, safety SafetySettingsPort, openaiKeys OpenAIKeysPort, envBase, envKey string) *SafetyService {
	return &SafetyService{
		profiles:   profiles,
		governance: governance,
		safety:     safety,
		openaiKeys: openaiKeys,
		envBase:    envBase,
		envKey:     envKey,
		http:       &http.Client{},
		now:        time.Now,
	}
}

// safetyDiagnostics is the assistant-safety diagnostics body. Field order and
// nesting match AssistantSafetyDiagnosticsResult.
type safetyDiagnostics struct {
	CheckedAt       string                                             `json:"checkedAt"`
	LiteLLM         liteLLMDiagnostics                                 `json:"litellm"`
	AssistantSafety platformgovernance.AssistantSafetySettingsResponse `json:"assistantSafety"`
	OpenAIKeys      modelaccesssettings.OpenAiKeysPublicSettings       `json:"openaiKeys"`
}

type liteLLMDiagnostics struct {
	APIBase    string                `json:"apiBase"`
	Liveliness livenessProbe         `json:"liveliness"`
	Models     modelsProbe           `json:"models"`
	Guardrails guardrailsProbeResult `json:"guardrails"`
}

type livenessProbe struct {
	OK     bool    `json:"ok"`
	Status *int    `json:"status"`
	Error  *string `json:"error"`
}

type modelsProbe struct {
	OK     bool    `json:"ok"`
	Status *int    `json:"status"`
	Count  *int    `json:"count"`
	Error  *string `json:"error"`
}

type guardrailsProbeResult struct {
	OK       bool     `json:"ok"`
	Status   *int     `json:"status"`
	Count    *int     `json:"count"`
	Expected []string `json:"expected"`
	Missing  []string `json:"missing"`
	Error    *string  `json:"error"`

	// names is the configured list used to compute missing; unexported so it
	// never reaches the response body.
	names []string
}

// Run executes the diagnostics. A settings read failure is returned as an error
// (NestJS lets it escape as a 500); every external probe failure is reported in
// the response instead.
func (s *SafetyService) Run(ctx context.Context) (safetyDiagnostics, error) {
	assistantSafety, err := s.safety.AssistantSafetyPublicSettings(ctx)
	if err != nil {
		return safetyDiagnostics{}, err
	}
	openaiKeys, err := s.openaiKeys.PublicOpenAiKeysSettings(ctx)
	if err != nil {
		return safetyDiagnostics{}, err
	}

	apiBaseRaw, apiKey, err := s.activeGatewayConfig(ctx)
	if err != nil {
		return safetyDiagnostics{}, err
	}
	apiBase := normalizeLiteLlmBase(apiBaseRaw)

	// O1: the three probes are independent and run concurrently. The slowest
	// branch is at most the two sequential 5 second attempts of models or
	// guardrails, instead of the sum of all three.
	livelinessCh := make(chan livenessProbe, 1)
	modelsCh := make(chan modelsProbe, 1)
	guardrailsCh := make(chan guardrailsProbeResult, 1)
	go func() { livelinessCh <- s.probeLiveliness(ctx, apiBase) }()
	go func() { modelsCh <- s.probeModels(ctx, apiBase, apiKey) }()
	go func() {
		result := s.probeGuardrails(ctx, apiBase, apiKey)
		guardrailsCh <- guardrailsProbeResult{
			OK:       result.probe.OK,
			Status:   result.probe.Status,
			Count:    result.probe.Count,
			Expected: []string{},
			Missing:  []string{},
			Error:    result.probe.Error,
			names:    result.names,
		}
	}()
	liveliness := <-livelinessCh
	models := <-modelsCh
	guardrails := <-guardrailsCh

	expected, missing := expectedGuardrails(assistantSafety, openaiKeys.KeysCount, guardrails.OK, guardrails.names)
	guardrails.Expected = expected
	guardrails.Missing = missing

	return safetyDiagnostics{
		CheckedAt:       s.now().UTC().Format("2006-01-02T15:04:05.000Z"),
		LiteLLM:         liteLLMDiagnostics{APIBase: apiBase, Liveliness: liveliness, Models: models, Guardrails: guardrails},
		AssistantSafety: assistantSafety,
		OpenAIKeys:      openaiKeys,
	}, nil
}

// activeGatewayConfig mirrors LlmGatewaySettingsService.getActiveConfig: the
// bound completion profile, with the managed governance override when it
// applies, and the environment values when no profile is bound.
func (s *SafetyService) activeGatewayConfig(ctx context.Context) (string, string, error) {
	bindings, err := s.profiles.RuntimeBindings(ctx)
	if err != nil {
		return "", "", err
	}
	if bindings.CompletionProfileID == nil || *bindings.CompletionProfileID == "" {
		return s.envBase, s.envKey, nil
	}
	profile, found, err := s.profiles.RuntimeProfileConfig(ctx, *bindings.CompletionProfileID)
	if err != nil {
		return "", "", err
	}
	if !found {
		return s.envBase, s.envKey, nil
	}
	apiBase := profile.APIBase
	apiKey := profile.APIKey
	governedBase, governedKey, governed, err := s.governance.ManagedRuntimeCredentials(ctx, profile.ID, profile.APIBase)
	if err != nil {
		return "", "", err
	}
	if governed {
		apiBase = governedBase
		apiKey = governedKey
	}
	return apiBase, apiKey, nil
}

// normalizeLiteLlmBase strips trailing slashes and the endpoint suffixes the
// NestJS helper strips, then a final /v1.
func normalizeLiteLlmBase(raw string) string {
	base := strings.TrimSpace(raw)
	if base == "" {
		return base
	}
	base = strings.TrimRight(base, "/")
	lower := strings.ToLower(base)
	suffixes := []string{"/v1/chat/completions", "/chat/completions", "/v1/models", "/models", "/health/liveliness"}
	for _, suffix := range suffixes {
		if strings.HasSuffix(lower, suffix) {
			base = strings.TrimRight(base[:len(base)-len(suffix)], "/")
			lower = strings.ToLower(base)
			break
		}
	}
	if strings.HasSuffix(lower, "/v1") {
		base = strings.TrimRight(base[:len(base)-3], "/")
	}
	return base
}

// get performs one GET with an explicit per-request deadline. Any HTTP status is
// returned as a status; only transport/timeout failures become errors.
func (s *SafetyService) get(ctx context.Context, endpoint string, timeout time.Duration, apiKey string) (int, []byte, error) {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if readErr != nil {
		return resp.StatusCode, nil, readErr
	}
	return resp.StatusCode, body, nil
}

func (s *SafetyService) probeLiveliness(ctx context.Context, apiBase string) livenessProbe {
	status, _, err := s.get(ctx, apiBase+"/health/liveliness", 2*time.Second, "")
	if err != nil {
		message := err.Error()
		return livenessProbe{OK: false, Status: nil, Error: &message}
	}
	ok := status >= 200 && status < 300
	return livenessProbe{OK: ok, Status: &status}
}

func (s *SafetyService) probeModels(ctx context.Context, apiBase, apiKey string) modelsProbe {
	status, body, err := s.get(ctx, apiBase+"/v1/models", 5*time.Second, apiKey)
	if err != nil {
		message := err.Error()
		return modelsProbe{OK: false, Status: nil, Count: nil, Error: &message}
	}
	if status == http.StatusNotFound {
		status, body, err = s.get(ctx, apiBase+"/models", 5*time.Second, apiKey)
		if err != nil {
			message := err.Error()
			return modelsProbe{OK: false, Status: nil, Count: nil, Error: &message}
		}
	}
	ok := status >= 200 && status < 300
	result := modelsProbe{OK: ok, Status: &status}
	if ok {
		if count, found := countDataArray(body); found {
			result.Count = &count
		}
	}
	return result
}

type guardrailsProbe struct {
	names []string
	probe modelsProbe
}

func (s *SafetyService) probeGuardrails(ctx context.Context, apiBase, apiKey string) guardrailsProbe {
	status, body, err := s.get(ctx, apiBase+"/guardrails/list", 5*time.Second, apiKey)
	if err != nil {
		message := err.Error()
		return guardrailsProbe{probe: modelsProbe{OK: false, Status: nil, Count: nil, Error: &message}}
	}
	if status == http.StatusNotFound {
		status, body, err = s.get(ctx, apiBase+"/v1/guardrails/list", 5*time.Second, apiKey)
		if err != nil {
			message := err.Error()
			return guardrailsProbe{probe: modelsProbe{OK: false, Status: nil, Count: nil, Error: &message}}
		}
	}
	ok := status >= 200 && status < 300
	result := guardrailsProbe{probe: modelsProbe{OK: ok, Status: &status}}
	if ok {
		names := extractConfiguredGuardrailNames(body)
		count := len(names)
		result.names = names
		result.probe.Count = &count
	}
	return result
}

// expectedGuardrails computes the expected list and the missing subset.
// keysCount expands every base name to "-2".."-N".
func expectedGuardrails(safety platformgovernance.AssistantSafetySettingsResponse, keysCount int, guardrailsOK bool, configured []string) ([]string, []string) {
	expected := []string{}
	if safety.Enabled {
		baseNames := nonEmptyStrings(safety.Guardrails)
		if len(baseNames) > 0 {
			keyCount := keysCount
			if keyCount < 1 {
				keyCount = 1
			}
			if keyCount <= 1 {
				expected = append(expected, baseNames...)
			} else {
				for _, name := range baseNames {
					expected = append(expected, name)
					for index := 2; index <= keyCount; index++ {
						expected = append(expected, name+"-"+strconv.Itoa(index))
					}
				}
			}
		}
	}
	missing := []string{}
	if !guardrailsOK {
		missing = append(missing, expected...)
		return expected, missing
	}
	configuredSet := make(map[string]bool, len(configured))
	for _, name := range configured {
		configuredSet[name] = true
	}
	for _, name := range expected {
		if !configuredSet[name] {
			missing = append(missing, name)
		}
	}
	return expected, missing
}

// extractConfiguredGuardrailNames mirrors the NestJS helper: a bare array, or an
// object whose guardrails/data/items array holds strings or objects with
// guardrail_name / name / guardrailName. Values are trimmed, emptied out and
// de-duplicated in first-appearance order.
func extractConfiguredGuardrailNames(body []byte) []string {
	var list []json.RawMessage
	if err := json.Unmarshal(body, &list); err == nil {
		return guardrailNamesFromList(list)
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(body, &record); err != nil {
		return []string{}
	}
	for _, key := range []string{"guardrails", "data", "items"} {
		raw, ok := record[key]
		if !ok {
			continue
		}
		var nested []json.RawMessage
		if err := json.Unmarshal(raw, &nested); err == nil {
			return guardrailNamesFromList(nested)
		}
	}
	return []string{}
}

func guardrailNamesFromList(entries []json.RawMessage) []string {
	out := make([]string, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		name := guardrailName(entry)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

func guardrailName(entry json.RawMessage) string {
	var text string
	if err := json.Unmarshal(entry, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(entry, &record); err != nil {
		return ""
	}
	for _, key := range []string{"guardrail_name", "name", "guardrailName"} {
		raw, ok := record[key]
		if !ok || string(raw) == "null" {
			// JavaScript's ?? skips an explicit null and tries the next key.
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err == nil {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func countDataArray(body []byte) (int, bool) {
	var record map[string]json.RawMessage
	if err := json.Unmarshal(body, &record); err != nil {
		return 0, false
	}
	raw, ok := record["data"]
	if !ok {
		return 0, false
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return 0, false
	}
	return len(rows), true
}

func nonEmptyStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
