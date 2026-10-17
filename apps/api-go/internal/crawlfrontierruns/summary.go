package crawlfrontierruns

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
)

// orderedCounts is a numeric record that preserves key insertion order, which
// is what the NestJS objects built with bumpCount/toNumericRecord serialize.
type orderedCounts struct {
	Keys   []string
	Values []float64
}

// MarshalJSON writes the counts object in insertion order.
func (o orderedCounts) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, key := range o.Keys {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		encodedValue, err := json.Marshal(o.Values[index])
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedValue)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// add appends one key/value pair (used by toNumericRecord).
func (o *orderedCounts) add(key string, value float64) {
	o.Keys = append(o.Keys, key)
	o.Values = append(o.Values, value)
}

// bump increments a counter, preserving the key's first-seen position.
func (o *orderedCounts) bump(key string) {
	for index, existing := range o.Keys {
		if existing == key {
			o.Values[index]++
			return
		}
	}
	o.Keys = append(o.Keys, key)
	o.Values = append(o.Values, 1)
}

// toNumericRecord mirrors the NestJS helper: a non-array object whose values
// coerce through Number() to finite numbers, preserving insertion order. It
// reports false when the input is not an object or no value survives.
func toNumericRecord(raw RawJSON) (orderedCounts, bool) {
	result := orderedCounts{}
	if !raw.IsObject() {
		return result, false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if _, err := decoder.Token(); err != nil {
		return orderedCounts{}, false
	}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return orderedCounts{}, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return orderedCounts{}, false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return orderedCounts{}, false
		}
		number, finite := jsNumberFromJSON(value)
		if finite {
			result.add(key, number)
		}
	}
	if _, err := decoder.Token(); err != nil {
		return orderedCounts{}, false
	}
	if len(result.Keys) == 0 {
		return orderedCounts{}, false
	}
	return result, true
}

// createPageTypeCountRecord is the default coverageByPageType object.
func createPageTypeCountRecord() orderedCounts {
	return orderedCounts{
		Keys:   []string{"home", "category", "list", "article"},
		Values: []float64{0, 0, 0, 0},
	}
}

// seedSummary is summary.seedSummary.
type seedSummary struct {
	Strategy      *string `json:"strategy"`
	Origin        *string `json:"origin"`
	Method        *string `json:"method"`
	DiscoveryMode *string `json:"discoveryMode"`
	FallbackStage *string `json:"fallbackStage"`
	Yield         RawJSON `json:"yield"`
	Quality       RawJSON `json:"quality"`
	Diagnostics   RawJSON `json:"diagnostics"`
}

// llmSummary is summary.llmSummary.
type llmSummary struct {
	PendingJudgeJobs float64 `json:"pendingJudgeJobs"`
	RunRole          *string `json:"runRole"`
	LLMAssist        RawJSON `json:"llmAssist"`
	JudgeSummary     RawJSON `json:"judgeSummary"`
	Lifecycle        RawJSON `json:"lifecycle"`
}

// shadowSummary is summary.shadowSummary.
type shadowSummary struct {
	ProfileID          *string `json:"profileId"`
	ShadowRunID        *string `json:"shadowRunId"`
	Comparison         RawJSON `json:"comparison"`
	PublishedProfileID *string `json:"publishedProfileId"`
}

// runRepairSummary is summary.repairSummary.
type runRepairSummary struct {
	Available      int           `json:"available"`
	Attempted      int           `json:"attempted"`
	Applied        int           `json:"applied"`
	Failed         int           `json:"failed"`
	Untouched      int           `json:"untouched"`
	MissingFields  orderedCounts `json:"missingFields"`
	RepairedFields orderedCounts `json:"repairedFields"`
	Errors         orderedCounts `json:"errors"`
	Models         orderedCounts `json:"models"`
}

// traceStep is one entry of summary.trace.
type traceStep struct {
	Key    string          `json:"key"`
	Label  string          `json:"label"`
	Status TraceStepStatus `json:"status"`
	Detail string          `json:"detail"`
	Tags   []string        `json:"tags"`
}

// runSummary is summary in GET /runs/:id.
type runSummary struct {
	CoverageByPageType  orderedCounts     `json:"coverageByPageType"`
	CoverageByDepth     orderedCounts     `json:"coverageByDepth"`
	CandidateStats      orderedCounts     `json:"candidateStats"`
	RejectionCounts     orderedCounts     `json:"rejectionCounts"`
	JudgeSummary        RawJSON           `json:"judgeSummary"`
	WarningFlags        []string          `json:"warningFlags"`
	FailureKind         *string           `json:"failureKind"`
	PendingLLMJudgeJobs float64           `json:"pendingLlmJudgeJobs"`
	RootDiagnosis       RawJSON           `json:"rootDiagnosis"`
	SeedSummary         seedSummary       `json:"seedSummary"`
	LLMSummary          llmSummary        `json:"llmSummary"`
	ShadowSummary       shadowSummary     `json:"shadowSummary"`
	RepairSummary       *runRepairSummary `json:"repairSummary"`
	Trace               []traceStep       `json:"trace"`
}

// nodeRepairSummary is repairSummary in GET /nodes/:id.
type nodeRepairSummary struct {
	Available        bool     `json:"available"`
	Attempted        bool     `json:"attempted"`
	Applied          bool     `json:"applied"`
	Source           *string  `json:"source"`
	Model            *string  `json:"model"`
	Error            *string  `json:"error"`
	MissingFields    []string `json:"missingFields"`
	RepairedFields   []string `json:"repairedFields"`
	PromptTokens     *float64 `json:"promptTokens"`
	CompletionTokens *float64 `json:"completionTokens"`
	TotalTokens      *float64 `json:"totalTokens"`
	CostUSD          *float64 `json:"costUsd"`
	LatencyMS        *float64 `json:"latencyMs"`
}

// extractionSummary is extractionSummary in GET /nodes/:id.
type extractionSummary struct {
	HasArticle          bool     `json:"hasArticle"`
	HasProcessedArticle bool     `json:"hasProcessedArticle"`
	ProcessedStatus     *string  `json:"processedStatus"`
	QualityScore        *float64 `json:"qualityScore"`
	LLMModel            *string  `json:"llmModel"`
	ExtractedFields     []string `json:"extractedFields"`
	MissingFields       []string `json:"missingFields"`
	RemovedNoiseTypes   []string `json:"removedNoiseTypes"`
}

// llmLogFilter is one filter object of llmLogFilters.
type llmLogFilter struct {
	ProfileID *string `json:"profileId,omitempty"`
	RunID     string  `json:"runId"`
	NodeID    *string `json:"nodeId,omitempty"`
	Feature   string  `json:"feature"`
}

// llmLogFilters is llmLogFilters in GET /nodes/:id.
type llmLogFilters struct {
	Judge  llmLogFilter  `json:"judge"`
	Learn  llmLogFilter  `json:"learn"`
	Repair *llmLogFilter `json:"repair,omitempty"`
}

// buildRunSummary mirrors buildRunAdminSummary.
func (s *Service) buildRunSummary(ctx context.Context, orgID string, fields runFields, nodes []nodeRecord) (runSummary, error) {
	metadata := decodeRunMetadata(fields.Metadata)
	warningFlags := collectNodeWarningFlags(&metadata, fields.LastError)
	pending := 0.0
	if metadata.LLMPendingJudgeJobs != nil && metadata.LLMPendingJudgeJobs.IsNumber {
		pending = metadata.LLMPendingJudgeJobs.Value
	} else {
		pending = resolvePendingLlmJudgeJobs(&metadata)
	}

	coverageByPageType, ok := toNumericRecord(metadata.coverage.ByPageType)
	if !ok {
		coverageByPageType = createPageTypeCountRecord()
	}
	coverageByDepth, _ := toNumericRecord(metadata.coverage.ByDepth)
	candidateStats, _ := toNumericRecord(metadata.CandidateStats)
	rejectionCounts, _ := toNumericRecord(metadata.RejectionCounts)

	failureKind := trimmedPtr(metadata.FailureKind)
	if failureKind == nil {
		failureKind = trimmedPtr(metadata.root.FailureKind)
	}

	seed := seedSummary{
		Strategy:      trimmedPtr(metadata.SeedStrategy),
		Origin:        trimmedPtr(metadata.SeedOrigin),
		Method:        trimmedPtr(metadata.SeedMethod),
		DiscoveryMode: trimmedPtr(metadata.SeedDiscoveryMode),
		FallbackStage: trimmedPtr(metadata.FallbackStage),
		Yield:         seedRecord(metadata.SeedYield, metadata.root.SeedYield),
		Quality:       seedRecord(metadata.SeedQuality, metadata.root.SeedQuality),
		Diagnostics:   seedRecord(metadata.SeedDiagnostics, metadata.root.SeedDiagnostics),
	}
	if seed.Strategy == nil {
		seed.Strategy = trimmedPtr(metadata.root.SeedStrategy)
	}
	if seed.Origin == nil {
		seed.Origin = trimmedPtr(metadata.root.SeedOrigin)
	}
	if seed.Method == nil {
		seed.Method = trimmedPtr(metadata.root.SeedMethod)
	}
	if seed.DiscoveryMode == nil {
		seed.DiscoveryMode = trimmedPtr(metadata.root.SeedDiscoveryMode)
	}
	if seed.FallbackStage == nil {
		seed.FallbackStage = trimmedPtr(metadata.root.FallbackStage)
	}

	runRole := trimmedPtr(metadata.RunRole)
	if runRole == nil {
		runRole = trimmedPtr(metadata.lifecycle.Role)
	}

	summary := runSummary{
		CoverageByPageType:  coverageByPageType,
		CoverageByDepth:     coverageByDepth,
		CandidateStats:      candidateStats,
		RejectionCounts:     rejectionCounts,
		JudgeSummary:        objectJSONOrEmpty(metadata.JudgeSummary),
		WarningFlags:        warningFlags,
		FailureKind:         failureKind,
		PendingLLMJudgeJobs: pending,
		RootDiagnosis:       objectJSONOrNull(metadata.RootDiagnosis),
		SeedSummary:         seed,
		LLMSummary: llmSummary{
			PendingJudgeJobs: pending,
			RunRole:          runRole,
			LLMAssist:        objectJSONOrNull(metadata.LLMAssist),
			JudgeSummary:     objectJSONOrNull(metadata.JudgeSummary),
			Lifecycle:        objectJSONOrNull(metadata.LLMLifecycle),
		},
		ShadowSummary: shadowSummary{
			ProfileID:          trimmedPtr(metadata.ShadowProfileID),
			ShadowRunID:        trimmedPtr(metadata.ShadowRunID),
			Comparison:         objectJSONOrNull(metadata.ShadowComparison),
			PublishedProfileID: trimmedPtr(metadata.ShadowPublishedProfileID),
		},
		Trace: buildRunTrace(&metadata, warningFlags),
	}

	repairSummary, err := s.buildRunRepairSummary(ctx, orgID, nodes)
	if err != nil {
		return runSummary{}, err
	}
	summary.RepairSummary = repairSummary
	return summary, nil
}

// seedRecord mirrors `isPlainObject(metadata.x) ? metadata.x : isPlainObject(root.x) ? root.x : null`.
func seedRecord(primary, fallback RawJSON) RawJSON {
	if primary.IsObject() {
		return primary
	}
	if fallback.IsObject() {
		return fallback
	}
	return nil
}

// buildRunRepairSummary mirrors buildRunRepairSummary. Both queries are
// org-scoped: a node may reference a CrawlResult from another organization, and
// such rows must never contribute to the summary.
func (s *Service) buildRunRepairSummary(ctx context.Context, orgID string, nodes []nodeRecord) (*runRepairSummary, error) {
	crawlResultIDs := make([]string, 0, len(nodes))
	for _, node := range nodes {
		if node.CrawlResultID == nil || len(*node.CrawlResultID) == 0 {
			continue
		}
		if containsString(crawlResultIDs, *node.CrawlResultID) {
			continue
		}
		crawlResultIDs = append(crawlResultIDs, *node.CrawlResultID)
	}
	if len(crawlResultIDs) == 0 {
		return nil, nil
	}
	resultPayload, err := json.Marshal(crawlResultIDs)
	if err != nil {
		return nil, err
	}
	resultRows, err := s.db.QueryContext(ctx,
		"SELECT id, contentHash FROM CrawlResult WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(id))",
		orgID, string(resultPayload))
	if err != nil {
		return nil, err
	}
	contentHashes := make([]string, 0, len(crawlResultIDs))
	for resultRows.Next() {
		var id, contentHash string
		if err := resultRows.Scan(&id, &contentHash); err != nil {
			_ = resultRows.Close()
			return nil, err
		}
		if contentHash == "" || containsString(contentHashes, contentHash) {
			continue
		}
		contentHashes = append(contentHashes, contentHash)
	}
	if err := resultRows.Err(); err != nil {
		_ = resultRows.Close()
		return nil, err
	}
	_ = resultRows.Close()
	if len(contentHashes) == 0 {
		return nil, nil
	}
	hashPayload, err := json.Marshal(contentHashes)
	if err != nil {
		return nil, err
	}
	articleRows, err := s.db.QueryContext(ctx,
		"SELECT metadata FROM Article WHERE orgId = ? AND JSON_CONTAINS(?, JSON_QUOTE(contentHash))",
		orgID, string(hashPayload))
	if err != nil {
		return nil, err
	}
	defer articleRows.Close()

	summary := &runRepairSummary{}
	for articleRows.Next() {
		var metadata []byte
		if err := articleRows.Scan(&metadata); err != nil {
			return nil, err
		}
		summary.Available++
		view := articleMetadataView{}
		if rawIsObject(metadata) {
			_ = json.Unmarshal(metadata, &view)
		}
		repair, ok := decodeLLMRepair(view.LLMRepair)
		if !ok {
			continue
		}
		summary.Attempted++
		if model := trimmedPtr(repair.Model); model != nil {
			summary.Models.bump(*model)
		}
		if applied, ok := asBool(repair.Applied); ok && applied {
			summary.Applied++
		}
		if repairError := trimmedPtr(repair.Error); repairError != nil {
			summary.Failed++
			summary.Errors.bump(*repairError)
		}
		for _, field := range coerceStringList(repair.MissingFields) {
			summary.MissingFields.bump(field)
		}
		for _, field := range coerceStringList(repair.RepairedFields) {
			summary.RepairedFields.bump(field)
		}
	}
	if err := articleRows.Err(); err != nil {
		return nil, err
	}
	summary.Untouched = summary.Available - summary.Attempted
	if summary.Untouched < 0 {
		summary.Untouched = 0
	}
	return summary, nil
}

// buildNodeRepairSummary mirrors buildNodeRepairSummary.
func buildNodeRepairSummary(articleMetadata RawJSON) *nodeRepairSummary {
	view := articleMetadataView{}
	if rawIsObject(articleMetadata) {
		_ = json.Unmarshal(articleMetadata, &view)
	}
	repair, ok := decodeLLMRepair(view.LLMRepair)
	if !ok {
		return nil
	}
	applied := false
	if value, present := asBool(repair.Applied); present {
		applied = value
	}
	return &nodeRepairSummary{
		Available:        true,
		Attempted:        true,
		Applied:          applied,
		Source:           trimmedPtr(repair.Source),
		Model:            trimmedPtr(repair.Model),
		Error:            trimmedPtr(repair.Error),
		MissingFields:    coerceOrEmpty(repair.MissingFields),
		RepairedFields:   coerceOrEmpty(repair.RepairedFields),
		PromptTokens:     finiteNumber(repair.PromptTokens),
		CompletionTokens: finiteNumber(repair.CompletionTokens),
		TotalTokens:      finiteNumber(repair.TotalTokens),
		CostUSD:          finiteNumber(repair.CostUSD),
		LatencyMS:        finiteNumber(repair.LatencyMS),
	}
}

// coerceOrEmpty returns the coerced list or an empty array.
func coerceOrEmpty(list stringList) []string {
	values := coerceStringList(list)
	if values == nil {
		return []string{}
	}
	return values
}

// buildNodeExtractionSummary mirrors buildNodeExtractionSummary.
func buildNodeExtractionSummary(articlePresent bool, processed *processedArticleDocument) extractionSummary {
	extracted := make([]string, 0)
	missing := make([]string, 0)

	titlePresent := processed != nil && processed.Title != nil && *processed.Title != ""
	if titlePresent {
		extracted = append(extracted, "title")
	} else {
		missing = append(missing, "title")
	}
	if processed != nil && processed.Subtitle != nil && *processed.Subtitle != "" {
		extracted = append(extracted, "subtitle")
	}
	authorPresent := processed != nil && processed.Author != nil && *processed.Author != ""
	if authorPresent {
		extracted = append(extracted, "author")
	} else {
		missing = append(missing, "author")
	}
	sourcePresent := processed != nil && processed.Source != nil && *processed.Source != ""
	if sourcePresent {
		extracted = append(extracted, "source")
	} else {
		missing = append(missing, "source")
	}
	publishedPresent := processed != nil && processed.PublishedAt != nil
	if publishedPresent {
		extracted = append(extracted, "published_at")
	} else {
		missing = append(missing, "published_at")
	}
	if processed != nil && processed.Category != nil && *processed.Category != "" {
		extracted = append(extracted, "category")
	}

	summary := extractionSummary{
		HasArticle:          articlePresent,
		HasProcessedArticle: processed != nil,
		ExtractedFields:     extracted,
		MissingFields:       missing,
		RemovedNoiseTypes:   []string{},
	}
	if processed != nil {
		summary.ProcessedStatus = stringPtr(processed.Status)
		summary.QualityScore = processed.QualityScore
		summary.LLMModel = processed.LLMModel
		if values := stringArrayFromRaw(processed.RemovedNoiseTypes); values != nil {
			summary.RemovedNoiseTypes = values
		}
	}
	return summary
}

// stringPtr returns a pointer to the given string, used where NestJS keeps an
// always-present nullable string column.
func stringPtr(value string) *string {
	out := value
	return &out
}

// stringArrayFromRaw mirrors coerceStringArray for a RawJSON column.
func stringArrayFromRaw(raw RawJSON) []string {
	if !raw.IsArray() {
		return nil
	}
	list := stringList{}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil
	}
	return coerceStringList(list)
}

// buildLlmLogFilters mirrors buildLlmLogFilters. The repair key is omitted
// when there is no llmRepair object (NestJS leaves it undefined).
func buildLlmLogFilters(runID string, nodeID *string, profileID *string, includeRepair bool) llmLogFilters {
	judge := llmLogFilter{ProfileID: profileID, RunID: runID, NodeID: nodeID, Feature: "crawl_frontier_judge"}
	learn := llmLogFilter{ProfileID: profileID, RunID: runID, Feature: "crawl_frontier_learn"}
	filters := llmLogFilters{Judge: judge, Learn: learn}
	if includeRepair {
		filters.Repair = &llmLogFilter{
			ProfileID: profileID,
			RunID:     runID,
			NodeID:    nodeID,
			Feature:   "crawl_article_repair",
		}
	}
	return filters
}

// buildRunTrace mirrors buildRunTrace. Tag templates deliberately use the raw
// untrimmed metadata value even though the presence check trims it.
func buildRunTrace(metadata *runMetadataView, warningFlags []string) []traceStep {
	root := &metadata.root
	judgeCount := 0.0
	if metadata.judge.Count.OK {
		judgeCount = metadata.judge.Count.Value
	}
	pending := resolvePendingLlmJudgeJobs(metadata)
	nativeStrategyType := ""
	if root.NativeStrategyType != nil && root.NativeStrategyType.Valid {
		nativeStrategyType = root.NativeStrategyType.Value()
	} else if metadata.NativeStrategyType != nil && metadata.NativeStrategyType.Valid {
		nativeStrategyType = metadata.NativeStrategyType.Value()
	}

	steps := make([]traceStep, 0, 6)

	// 1. Seed.
	seedStatus := TraceStepStatusSkipped
	if metadata.SeedMethod.OK() || root.SeedMethod.OK() {
		seedStatus = TraceStepStatusCompleted
	} else if metadata.FallbackStage.Value() == "frontier" {
		seedStatus = TraceStepStatusWarning
	}
	steps = append(steps, traceStep{
		Key:    "seed",
		Label:  "Seed",
		Status: seedStatus,
		Detail: firstNonEmpty(
			metadata.SeedMethod.Trimmed(),
			root.SeedMethod.Trimmed(),
			metadata.SeedStrategy.Trimmed(),
			"seed_not_used",
		),
		Tags: uniqueStringList(
			valueTag(metadata.SeedStrategy, "strategy:"),
			valueTag(metadata.SeedMethod, "method:"),
			valueTag(metadata.FallbackStage, "fallback:"),
		),
	})

	// 2. Topology.
	topologyStatus := TraceStepStatusSkipped
	if root.LinkPreviewMode.OK() || root.DomScopeMode.OK() || root.WaitForMode.OK() {
		topologyStatus = TraceStepStatusCompleted
	}
	steps = append(steps, traceStep{
		Key:    "topology",
		Label:  "Topology",
		Status: topologyStatus,
		Detail: firstNonEmpty(
			root.LinkPreviewQuery.Trimmed(),
			root.LinkPreviewMode.Trimmed(),
			"topology_not_applied",
		),
		Tags: uniqueStringList(
			valueTag(root.LinkPreviewMode, "preview:"),
			valueTag(root.DomScopeMode, "dom:"),
			valueTag(root.WaitForMode, "wait:"),
		),
	})

	// 3. Frontier.
	frontierStatus := TraceStepStatusSkipped
	if metadata.CandidateStats.IsObject() || metadata.RejectionCounts.IsObject() {
		frontierStatus = TraceStepStatusCompleted
	}
	steps = append(steps, traceStep{
		Key:    "frontier",
		Label:  "Frontier",
		Status: frontierStatus,
		Detail: firstNonEmpty(
			metadata.FailureKind.Trimmed(),
			root.FailureKind.Trimmed(),
			"frontier_candidates_processed",
		),
		Tags: warningFlags,
	})

	// 4. Native / fallback.
	nativeStatus := TraceStepStatusSkipped
	if nativeStrategyType != "" {
		nativeStatus = TraceStepStatusCompleted
		if containsString(warningFlags, "native_fallback_layered") {
			nativeStatus = TraceStepStatusWarning
		}
	}
	nativeDetail := nativeStrategyType
	if nativeDetail == "" {
		nativeDetail = "native_not_used"
	}
	var nativeStrategyTag []string
	if nativeStrategyType != "" {
		nativeStrategyTag = []string{"strategy:" + nativeStrategyType}
	}
	steps = append(steps, traceStep{
		Key:    "native",
		Label:  "Native / Fallback",
		Status: nativeStatus,
		Detail: nativeDetail,
		Tags: uniqueStringList(
			nativeStrategyTag,
			valueTag(root.NativeFilterChainType, "filter:"),
			valueTag(root.NativeURLScorerType, "scorer:"),
		),
	})

	// 5. LLM judge.
	llmStatus := TraceStepStatusSkipped
	switch {
	case pending > 0:
		llmStatus = TraceStepStatusActive
	case hasPrefix(warningFlags, "llm_judge"):
		llmStatus = TraceStepStatusWarning
	case judgeCount > 0:
		llmStatus = TraceStepStatusCompleted
	}
	llmDetail := "judge_not_used"
	if pending > 0 {
		llmDetail = jsNumberToString(pending) + " pending"
	} else if judgeCount > 0 {
		llmDetail = jsNumberToString(judgeCount) + " judged"
	}
	var pendingTag []string
	if pending > 0 {
		pendingTag = []string{"pending:" + jsNumberToString(pending)}
	}
	steps = append(steps, traceStep{
		Key:    "llm_judge",
		Label:  "LLM Judge",
		Status: llmStatus,
		Detail: llmDetail,
		Tags: uniqueStringList(
			filterPrefix(warningFlags, "llm_judge"),
			pendingTag,
		),
	})

	// 6. Shadow learn.
	shadowStatus := TraceStepStatusSkipped
	if metadata.ShadowComparison.IsObject() {
		shadowStatus = TraceStepStatusCompleted
	} else if metadata.lifecycle.LearnQueuedAt.OK() {
		shadowStatus = TraceStepStatusActive
	}
	steps = append(steps, traceStep{
		Key:    "shadow_learn",
		Label:  "Shadow Learn",
		Status: shadowStatus,
		Detail: firstNonEmpty(
			metadata.shadow.Summary.Trimmed(),
			metadata.lifecycle.LearnQueuedAt.Trimmed(),
			"shadow_learning_not_triggered",
		),
		Tags: uniqueStringList(
			valueTag(metadata.ShadowProfileID, "shadow:"),
			valueTag(metadata.ShadowPublishedProfileID, "published:"),
		),
	})
	return steps
}

// OK reports a non-empty trimmed value.
func (t *trimmedString) OK() bool {
	return t != nil && t.Valid
}

// Trimmed returns the trimmed value (empty when absent).
func (t *trimmedString) Trimmed() string {
	if t == nil || !t.Valid {
		return ""
	}
	return t.Value()
}

// valueTag builds a raw (untrimmed) tag when the value is present.
func valueTag(value *trimmedString, prefix string) []string {
	if value == nil || !value.Valid {
		return nil
	}
	return []string{prefix + value.Raw}
}

// firstNonEmpty returns the first non-empty candidate.
func firstNonEmpty(candidates ...string) string {
	for _, candidate := range candidates {
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

// containsString reports whether the list contains an exact value.
func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// hasPrefix reports whether an entry starts with the prefix.
func hasPrefix(values []string, prefix string) bool {
	for _, value := range values {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

// filterPrefix keeps entries starting with the prefix, preserving order.
func filterPrefix(values []string, prefix string) []string {
	out := make([]string, 0)
	for _, value := range values {
		if strings.HasPrefix(value, prefix) {
			out = append(out, value)
		}
	}
	return out
}
