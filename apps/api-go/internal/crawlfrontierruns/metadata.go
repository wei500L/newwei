package crawlfrontierruns

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
)

// jsonString decodes a JSON string and remembers whether the value was a
// string at all (an empty string still counts as present).
type jsonString struct {
	Value string
	OK    bool
}

// UnmarshalJSON implements json.Unmarshaler without failing on non-strings.
func (s *jsonString) UnmarshalJSON(data []byte) error {
	if !rawIsString(data) {
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return nil
	}
	s.Value = text
	s.OK = true
	return nil
}

// trimmedString mirrors asString: it keeps the raw value so trace tags can use
// the untrimmed text while Valid reports whether the trimmed value is
// non-empty.
type trimmedString struct {
	Raw   string
	Valid bool
}

// UnmarshalJSON implements json.Unmarshaler without failing on non-strings.
func (t *trimmedString) UnmarshalJSON(data []byte) error {
	if !rawIsString(data) {
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return nil
	}
	t.Raw = text
	t.Valid = strings.TrimSpace(text) != ""
	return nil
}

// Value returns the trimmed string (empty when absent).
func (t *trimmedString) Value() string {
	if t == nil || !t.Valid {
		return ""
	}
	return strings.TrimSpace(t.Raw)
}

// strictBool mirrors asBoolean: only JSON booleans are accepted.
type strictBool struct {
	Value bool
	OK    bool
}

// UnmarshalJSON implements json.Unmarshaler.
func (b *strictBool) UnmarshalJSON(data []byte) error {
	switch string(bytes.TrimSpace(data)) {
	case "true":
		b.Value = true
		b.OK = true
	case "false":
		b.Value = false
		b.OK = true
	}
	return nil
}

// stringList mirrors coerceStringArray: a JSON array of strings, each trimmed,
// empty entries dropped, with OK reporting a non-empty result.
type stringList struct {
	Values []string
	OK     bool
}

// UnmarshalJSON implements json.Unmarshaler. Non-arrays and non-string entries
// are ignored instead of failing the whole metadata decode.
func (l *stringList) UnmarshalJSON(data []byte) error {
	if !rawIsArray(data) {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil
	}
	for _, entry := range entries {
		var text string
		if json.Unmarshal(entry, &text) != nil {
			continue
		}
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		l.Values = append(l.Values, text)
	}
	l.OK = len(l.Values) > 0
	return nil
}

// jsonNumber mirrors `typeof value === "number"`: it only records JSON
// numbers, so strings and booleans fall through to the Number() path.
type jsonNumber struct {
	Value    float64
	IsNumber bool
}

// UnmarshalJSON implements json.Unmarshaler.
func (n *jsonNumber) UnmarshalJSON(data []byte) error {
	if !rawIsNumber(data) {
		return nil
	}
	var value float64
	if err := json.Unmarshal(data, &value); err != nil {
		return nil
	}
	n.Value = value
	n.IsNumber = true
	return nil
}

// coverageView is the metadata.coverage object.
type coverageView struct {
	ByPageType RawJSON `json:"byPageType"`
	ByDepth    RawJSON `json:"byDepth"`
}

// rootDiagnosisView is the typed view of metadata.rootDiagnosis.
type rootDiagnosisView struct {
	FailureKind           *trimmedString `json:"failureKind"`
	SeedStrategy          *trimmedString `json:"seedStrategy"`
	SeedOrigin            *trimmedString `json:"seedOrigin"`
	SeedMethod            *trimmedString `json:"seedMethod"`
	SeedDiscoveryMode     *trimmedString `json:"seedDiscoveryMode"`
	FallbackStage         *trimmedString `json:"fallbackStage"`
	LinkPreviewMode       *trimmedString `json:"linkPreviewMode"`
	LinkPreviewQuery      *trimmedString `json:"linkPreviewQuery"`
	DomScopeMode          *trimmedString `json:"domScopeMode"`
	WaitForMode           *trimmedString `json:"waitForMode"`
	NativeStrategyType    *trimmedString `json:"nativeStrategyType"`
	NativeFilterChainType *trimmedString `json:"nativeFilterChainType"`
	NativeURLScorerType   *trimmedString `json:"nativeUrlScorerType"`
	SeedYield             RawJSON        `json:"seedYield"`
	SeedQuality           RawJSON        `json:"seedQuality"`
	SeedDiagnostics       RawJSON        `json:"seedDiagnostics"`
}

// llmLifecycleView is the typed view of metadata.llmLifecycle.
type llmLifecycleView struct {
	Role          *trimmedString `json:"role"`
	LearnQueuedAt *trimmedString `json:"learnQueuedAt"`
}

// judgeSummaryView is the typed view of metadata.judgeSummary.
type judgeSummaryView struct {
	Count jsNumberish `json:"count"`
}

// shadowComparisonView is the typed view of metadata.shadowComparison.
type shadowComparisonView struct {
	Summary *trimmedString `json:"summary"`
}

// runMetadataView is the typed view of a CrawlFrontierRun.metadata object.
// RawJSON fields keep the original sub-document for the response.
type runMetadataView struct {
	RunRole                  *trimmedString `json:"runRole"`
	FailureKind              *trimmedString `json:"failureKind"`
	WarningFlags             stringList     `json:"warningFlags"`
	SeedStrategy             *trimmedString `json:"seedStrategy"`
	SeedOrigin               *trimmedString `json:"seedOrigin"`
	SeedMethod               *trimmedString `json:"seedMethod"`
	SeedDiscoveryMode        *trimmedString `json:"seedDiscoveryMode"`
	FallbackStage            *trimmedString `json:"fallbackStage"`
	SeedYield                RawJSON        `json:"seedYield"`
	SeedQuality              RawJSON        `json:"seedQuality"`
	SeedDiagnostics          RawJSON        `json:"seedDiagnostics"`
	JudgeSummary             RawJSON        `json:"judgeSummary"`
	CandidateStats           RawJSON        `json:"candidateStats"`
	RejectionCounts          RawJSON        `json:"rejectionCounts"`
	Coverage                 RawJSON        `json:"coverage"`
	RootDiagnosis            RawJSON        `json:"rootDiagnosis"`
	LLMAssist                RawJSON        `json:"llmAssist"`
	LLMLifecycle             RawJSON        `json:"llmLifecycle"`
	ShadowComparison         RawJSON        `json:"shadowComparison"`
	ShadowProfileID          *trimmedString `json:"shadowProfileId"`
	ShadowRunID              *trimmedString `json:"shadowRunId"`
	ShadowPublishedProfileID *trimmedString `json:"shadowPublishedProfileId"`
	LLMJudgeEnabled          *strictBool    `json:"llmJudgeEnabled"`
	LLMJudgeAttempted        *strictBool    `json:"llmJudgeAttempted"`
	LLMJudgeParsed           *strictBool    `json:"llmJudgeParsed"`
	LLMJudgeError            *trimmedString `json:"llmJudgeError"`
	LLMPendingJudgeJobs      *jsonNumber    `json:"llmPendingJudgeJobs"`
	PendingLLMJudgeJobs      *jsNumberish   `json:"pendingLlmJudgeJobs"`
	NativeStrategyType       *trimmedString `json:"nativeStrategyType"`

	root      rootDiagnosisView
	lifecycle llmLifecycleView
	judge     judgeSummaryView
	shadow    shadowComparisonView
	coverage  coverageView
}

// decodeRunMetadata decodes a run metadata object into its typed view. A
// non-object metadata column yields the zero view, which mirrors the NestJS
// `isPlainObject(metadata) ? metadata : {}` fallback.
func decodeRunMetadata(raw RawJSON) runMetadataView {
	var view runMetadataView
	if !raw.IsObject() {
		return view
	}
	_ = json.Unmarshal(raw, &view)
	if view.RootDiagnosis.IsObject() {
		_ = json.Unmarshal(view.RootDiagnosis, &view.root)
	}
	if view.LLMLifecycle.IsObject() {
		_ = json.Unmarshal(view.LLMLifecycle, &view.lifecycle)
	}
	if view.JudgeSummary.IsObject() {
		_ = json.Unmarshal(view.JudgeSummary, &view.judge)
	}
	if view.ShadowComparison.IsObject() {
		_ = json.Unmarshal(view.ShadowComparison, &view.shadow)
	}
	if view.Coverage.IsObject() {
		_ = json.Unmarshal(view.Coverage, &view.coverage)
	}
	return view
}

// articleMetadataView is the typed view of Article.metadata.
type articleMetadataView struct {
	LLMRepair RawJSON `json:"llmRepair"`
}

// llmRepairView is the typed view of metadata.llmRepair.
type llmRepairView struct {
	Applied          *strictBool    `json:"applied"`
	Source           *trimmedString `json:"source"`
	Model            *trimmedString `json:"model"`
	Error            *trimmedString `json:"error"`
	MissingFields    stringList     `json:"missingFields"`
	RepairedFields   stringList     `json:"repairedFields"`
	PromptTokens     jsNumberish    `json:"promptTokens"`
	CompletionTokens jsNumberish    `json:"completionTokens"`
	TotalTokens      jsNumberish    `json:"totalTokens"`
	CostUSD          jsNumberish    `json:"costUsd"`
	LatencyMS        jsNumberish    `json:"latencyMs"`
}

// decodeLLMRepair decodes an llmRepair object. The second result is false when
// the value is not a JSON object (the NestJS isPlainObject guard).
func decodeLLMRepair(raw RawJSON) (llmRepairView, bool) {
	if !raw.IsObject() {
		return llmRepairView{}, false
	}
	var view llmRepairView
	if err := json.Unmarshal(raw, &view); err != nil {
		return llmRepairView{}, false
	}
	return view, true
}

// trimmedPtr returns a trimmed string pointer or nil.
func trimmedPtr(value *trimmedString) *string {
	if value == nil || !value.Valid {
		return nil
	}
	text := value.Value()
	return &text
}

// rawTrimmed returns the raw untrimmed value (empty when absent).
func rawTrimmed(value *trimmedString) string {
	if value == nil || !value.Valid {
		return ""
	}
	return value.Raw
}

// asBool returns the boolean value when the field is a JSON boolean.
func asBool(value *strictBool) (bool, bool) {
	if value == nil || !value.OK {
		return false, false
	}
	return value.Value, true
}

// coerceStringList returns the coerced string array, or nil when the source
// was not a non-empty array.
func coerceStringList(list stringList) []string {
	if !list.OK {
		return nil
	}
	return list.Values
}

// uniqueStringList trims, drops empty entries and deduplicates while keeping
// first-occurrence order.
func uniqueStringList(lists ...[]string) []string {
	out := make([]string, 0)
	for _, list := range lists {
		for _, entry := range list {
			trimmed := strings.TrimSpace(entry)
			if trimmed == "" || containsString(out, trimmed) {
				continue
			}
			out = append(out, trimmed)
		}
	}
	return out
}

// collectNodeWarningFlags mirrors the NestJS helper: warningFlags from
// metadata, the llm judge failure flags, then the failure kind derived from
// metadata.failureKind or classifyFrontierFailureKind(lastError).
func collectNodeWarningFlags(metadata *runMetadataView, lastError *string) []string {
	failureKind := ""
	if metadata != nil && metadata.FailureKind != nil && metadata.FailureKind.Valid {
		failureKind = metadata.FailureKind.Value()
	} else {
		failureKind = classifyFrontierFailureKind(lastError)
	}

	var parseFailed []string
	if metadata != nil {
		enabled, enabledOK := asBool(metadata.LLMJudgeEnabled)
		attempted, attemptedOK := asBool(metadata.LLMJudgeAttempted)
		parsed, parsedOK := asBool(metadata.LLMJudgeParsed)
		if enabledOK && enabled && attemptedOK && attempted && parsedOK && !parsed {
			parseFailed = []string{"llm_judge_parse_failed"}
		}
	}

	var judgeFailed []string
	if metadata != nil {
		enabled, enabledOK := asBool(metadata.LLMJudgeEnabled)
		attempted, attemptedOK := asBool(metadata.LLMJudgeAttempted)
		if enabledOK && enabled && attemptedOK && attempted && metadata.LLMJudgeError != nil && metadata.LLMJudgeError.Valid {
			judgeFailed = []string{"llm_judge_failed"}
		}
	}

	var failure []string
	if failureKind != "" {
		failure = []string{failureKind}
	}
	var warningFlags stringList
	if metadata != nil {
		warningFlags = metadata.WarningFlags
	}
	merged := uniqueStringList(coerceStringList(warningFlags), parseFailed, judgeFailed, failure)
	if merged == nil {
		return []string{}
	}
	return merged
}

// classifyFrontierFailureKind is a line-by-line port of the NestJS helper. The
// keyword groups are checked in order and the first match wins.
func classifyFrontierFailureKind(message *string) string {
	if message == nil {
		return ""
	}
	normalized := strings.ToLower(strings.TrimSpace(*message))
	if normalized == "" {
		return ""
	}
	if strings.Contains(normalized, "ssrf protection") ||
		strings.Contains(normalized, "resolves to private ip") ||
		strings.Contains(normalized, "blocked non-public dns answer") {
		return "ssrf_blocked"
	}
	if strings.Contains(normalized, "datadome") ||
		strings.Contains(normalized, "captcha") ||
		strings.Contains(normalized, "cloudflare") ||
		strings.Contains(normalized, "challenge") ||
		strings.Contains(normalized, "protected") ||
		strings.Contains(normalized, "access denied") ||
		strings.Contains(normalized, "status code 401") ||
		strings.Contains(normalized, "status code 403") ||
		strings.Contains(normalized, "status code 429") {
		return "challenge_detected"
	}
	if strings.Contains(normalized, "err_tunnel_connection_failed") ||
		strings.Contains(normalized, "tunnel_connection_failed") ||
		strings.Contains(normalized, "err_connection_closed") ||
		strings.Contains(normalized, "connection_closed") ||
		strings.Contains(normalized, "econnreset") ||
		strings.Contains(normalized, "etimedout") ||
		strings.Contains(normalized, "navigation timeout") ||
		strings.Contains(normalized, "request timed out") {
		return "network_tunnel_error"
	}
	return ""
}

// resolvePendingLlmJudgeJobs mirrors the NestJS helper:
// max(0, Math.round(Number(metadata.pendingLlmJudgeJobs))) with non-finite
// values treated as 0.
func resolvePendingLlmJudgeJobs(metadata *runMetadataView) float64 {
	if metadata == nil || metadata.PendingLLMJudgeJobs == nil || !metadata.PendingLLMJudgeJobs.OK {
		return 0
	}
	return math.Max(0, jsMathRound(metadata.PendingLLMJudgeJobs.Value))
}
