package crawlstrategyruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierruns"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// Package crawlstrategyruns hosts the crawl-strategy workflow trial run and
// replay execution chain ported from
// apps/api/src/modules/crawl/crawl-strategy-runtime.service.ts and the two
// controller entries trialRun (:117) / replayRun (:155).
//
// The runtime writes its run record through the crawlfrontierruns recorder
// (createRun / finalizeRun) so the run detail, candidate and explanation reads
// already migrated in that package serve the same rows.

// Runtime owns the trial-run / replay execution.
type Runtime struct {
	db        *sql.DB
	discovery *crawlmetadata.Discovery
	workflows *crawlworkflow.Service
	runs      *crawlfrontierruns.Service
	now       func() time.Time
}

// NewRuntime builds the runtime around the shared discovery, workflow and run
// recorder services.
func NewRuntime(db *sql.DB, discovery *crawlmetadata.Discovery, workflows *crawlworkflow.Service, runs *crawlfrontierruns.Service) *Runtime {
	return &Runtime{db: db, discovery: discovery, workflows: workflows, runs: runs, now: time.Now}
}

// TrialRunInput is TrialRunCrawlStrategyWorkflowDto (post-validation).
type TrialRunInput struct {
	WorkflowVersionID *string
	ProfileID         *string
	NewsSourceID      *string
	SeedURL           *string
	RunKind           *string
	MaxCandidates     *int
	RuntimeOverrides  json.RawMessage
}

// ReplayInput is ReplayCrawlStrategyWorkflowRunDto (post-validation).
type ReplayInput struct {
	SeedURL       *string
	ProfileID     *string
	NewsSourceID  *string
	MaxCandidates *int
}

// TrialRunWorkflow is the workflow summary of the trial-run response.
type TrialRunWorkflow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	VersionID string  `json:"versionId"`
	Version   float64 `json:"version"`
}

// TrialRunResult is the trial-run response body.
type TrialRunResult struct {
	RunID              string                                   `json:"runId"`
	Workflow           TrialRunWorkflow                         `json:"workflow"`
	Definition         crawlworkflow.WorkflowDefinition         `json:"definition"`
	Steps              []crawlfrontierruns.StrategyRunStep      `json:"steps"`
	Candidates         []crawlfrontierruns.StrategyRunCandidate `json:"candidates"`
	SelectedCandidates []crawlfrontierruns.StrategyRunCandidate `json:"selectedCandidates"`
	ParameterSources   []crawlworkflow.ParameterSource          `json:"parameterSources"`
	SystemEvents       []crawlfrontierruns.StrategyRunEvent     `json:"systemEvents"`
}

// ExecutionError carries the partial execution state (F1): the steps that ran,
// including the failed one, plus the system events and parameter sources the
// source runtime had accumulated.
type ExecutionError struct {
	Err              error
	Steps            []crawlfrontierruns.StrategyRunStep
	SystemEvents     []crawlfrontierruns.StrategyRunEvent
	ParameterSources []crawlworkflow.ParameterSource
}

func (e *ExecutionError) Error() string {
	if e == nil || e.Err == nil {
		return "crawl strategy execution failed"
	}
	return e.Err.Error()
}

func (e *ExecutionError) Unwrap() error { return e.Err }

type newsSourceRef struct {
	ID  string
	URL string
}

type runtimeContext struct {
	orgID                  string
	actorID                string
	runID                  string
	definition             crawlworkflow.WorkflowDefinition
	seedURL                *string
	newsSource             *newsSourceRef
	effectiveProfileConfig json.RawMessage
	parameterSources       []crawlworkflow.ParameterSource
	systemEvents           []crawlfrontierruns.StrategyRunEvent
	maxCandidates          int
}

type executionResult struct {
	definition       crawlworkflow.WorkflowDefinition
	steps            []crawlfrontierruns.StrategyRunStep
	candidates       []crawlfrontierruns.StrategyRunCandidate
	selected         []crawlfrontierruns.StrategyRunCandidate
	parameterSources []crawlworkflow.ParameterSource
	systemEvents     []crawlfrontierruns.StrategyRunEvent
}

// TrialRunWorkflow ports trialRunWorkflow.
func (r *Runtime) TrialRunWorkflow(ctx context.Context, orgID, actorID, workflowID string, input TrialRunInput) (*TrialRunResult, error) {
	resolved, err := r.workflows.ResolveBoundWorkflowVersion(ctx, orgID, workflowID, stringValue(input.WorkflowVersionID))
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, newStatus(404, "Workflow not found")
	}
	if err := assertSupportedWorkflowDefinition(resolved.Definition); err != nil {
		return nil, err
	}

	profile, err := r.loadProfile(ctx, orgID, stringValue(input.ProfileID))
	if err != nil {
		return nil, err
	}
	newsSource, err := r.loadNewsSource(ctx, orgID, stringValue(input.NewsSourceID))
	if err != nil {
		return nil, err
	}

	overlay, err := r.workflows.CompileProfileOverlay(ctx, orgID, resolved.WorkflowID, resolved.VersionID)
	if err != nil {
		return nil, err
	}

	executionMode := resolved.Definition.Settings.ExecutionMode
	effectiveConfig := json.RawMessage(`{}`)
	if overlay != nil {
		executionMode = crawlworkflow.ProfileExecutionMode(executionMode, overlay.ExecutionMode)
		if profile != nil {
			merged := crawlworkflow.MergeProfileConfigPatch(profile.Config, overlay.ConfigPatch)
			effectiveConfig, err = crawlprofile.NormalizeConfigJSON(merged)
			if err != nil {
				return nil, err
			}
			executionMode = crawlworkflow.ProfileExecutionMode(profile.ExecutionMode, overlay.ExecutionMode)
		} else {
			effectiveConfig, err = crawlprofile.NormalizeConfigJSON(overlay.ConfigPatch)
			if err != nil {
				return nil, err
			}
		}
	}
	_ = executionMode

	runKind := "trial"
	if input.RunKind != nil && strings.TrimSpace(*input.RunKind) != "" {
		runKind = strings.TrimSpace(*input.RunKind)
	}
	parameterSources := json.RawMessage(`[]`)
	if overlay != nil {
		parameterSources = marshalParameterSources(overlay.ParameterSources)
	}

	var profileID *string
	if profile != nil {
		profileID = &profile.ID
	}
	var newsSourceID *string
	if newsSource != nil {
		newsSourceID = &newsSource.ID
	}
	startedAt := r.now().UTC()
	runInput := buildRunInput(input, profileID, newsSourceID)
	graphSnapshot, err := json.Marshal(resolved.Definition)
	if err != nil {
		return nil, err
	}
	runID, err := r.runs.CreateRun(ctx, crawlfrontierruns.StrategyRunCreateInput{
		OrgID:             orgID,
		CreatedByID:       actorID,
		WorkflowID:        &resolved.WorkflowID,
		WorkflowVersionID: &resolved.VersionID,
		WorkflowOrigin:    "bound",
		ProfileID:         profileID,
		NewsSourceID:      newsSourceID,
		Status:            "running",
		RunKind:           runKind,
		Input:             runInput,
		GraphSnapshot:     graphSnapshot,
		ParameterSources:  parameterSources,
		StartedAt:         &startedAt,
	})
	if err != nil {
		return nil, err
	}

	seedURL := input.SeedURL
	if seedURL == nil && newsSource != nil {
		value := newsSource.URL
		seedURL = &value
	}
	context := &runtimeContext{
		orgID:                  orgID,
		actorID:                actorID,
		runID:                  runID,
		definition:             resolved.Definition,
		seedURL:                seedURL,
		newsSource:             newsSource,
		effectiveProfileConfig: effectiveConfig,
		parameterSources:       parameterSourcesFromOverlay(overlay),
		systemEvents:           []crawlfrontierruns.StrategyRunEvent{},
		maxCandidates:          numberOrDefault(input.MaxCandidates, 100),
	}

	result, execErr := r.execute(ctx, context)
	if execErr != nil {
		var partial *ExecutionError
		if errors.As(execErr, &partial) {
			finishedAt := r.now().UTC()
			errorText := partial.Error()
			steps := partial.Steps
			finalizeErr := r.runs.FinalizeRun(ctx, runID, crawlfrontierruns.StrategyRunFinalizeInput{
				Status:           "failed",
				Output:           json.RawMessage(`{}`),
				Steps:            steps,
				HasSteps:         true,
				Candidates:       []crawlfrontierruns.StrategyRunCandidate{},
				HasCandidates:    true,
				ParameterSources: marshalParameterSources(partial.ParameterSources),
				Events:           partial.SystemEvents,
				HasEvents:        true,
				Error:            &errorText,
				FinishedAt:       &finishedAt,
			})
			if finalizeErr != nil {
				return nil, finalizeErr
			}
			return nil, partial.Err
		}
		return nil, execErr
	}

	finishedAt := r.now().UTC()
	output, _ := json.Marshal(map[string]int{
		"selectedCount":  len(result.selected),
		"candidateCount": len(result.candidates),
	})
	if err := r.runs.FinalizeRun(ctx, runID, crawlfrontierruns.StrategyRunFinalizeInput{
		Status: "completed",
		Output: output,
		Steps:  result.steps, HasSteps: true,
		Candidates: result.candidates, HasCandidates: true,
		ParameterSources: marshalParameterSources(result.parameterSources),
		Events:           result.systemEvents, HasEvents: true,
		FinishedAt: &finishedAt,
	}); err != nil {
		return nil, err
	}

	return &TrialRunResult{
		RunID: runID,
		Workflow: TrialRunWorkflow{
			ID:        resolved.WorkflowID,
			Name:      resolved.WorkflowName,
			VersionID: resolved.VersionID,
			Version:   resolved.Version,
		},
		Definition:         result.definition,
		Steps:              result.steps,
		Candidates:         result.candidates,
		SelectedCandidates: result.selected,
		ParameterSources:   result.parameterSources,
		SystemEvents:       result.systemEvents,
	}, nil
}

// ReplayRun ports replayRun.
func (r *Runtime) ReplayRun(ctx context.Context, orgID, actorID, runID string, overrides ReplayInput) (*TrialRunResult, error) {
	existing, err := r.runs.LoadReplaySource(ctx, orgID, runID)
	if err != nil {
		return nil, err
	}
	workflowID := existing.WorkflowID
	if workflowID == "" {
		if isRecord(existing.GraphSnapshot) {
			workflowID = "legacy-replay"
		}
	}
	if existing.WorkflowOrigin == "legacy_bridge" || workflowID == "" || workflowID == "legacy-replay" {
		return nil, newStatus(404, "Legacy bridge workflow runs are observable but cannot be replayed until they are bound to a published workflow version")
	}
	workflowVersionID := existing.WorkflowVersionID
	if workflowVersionID == "" {
		workflowVersionID = stringFromRecord(existing.Input, "workflowVersionId")
	}
	if workflowVersionID == "" {
		return nil, newStatus(404, "Workflow run version not found")
	}

	input := TrialRunInput{WorkflowVersionID: &workflowVersionID}
	input.SeedURL = firstString(overrides.SeedURL, stringPointerFromRecord(existing.Input, "seedUrl"))
	input.ProfileID = firstString(overrides.ProfileID, stringPointerFromRecord(existing.Input, "profileId"))
	input.NewsSourceID = firstString(overrides.NewsSourceID, stringPointerFromRecord(existing.Input, "newsSourceId"))
	input.MaxCandidates = firstInt(overrides.MaxCandidates, intPointerFromRecord(existing.Input, "maxCandidates"))
	runKind := "trial"
	input.RunKind = &runKind
	return r.TrialRunWorkflow(ctx, orgID, actorID, workflowID, input)
}

// execute ports the runtime's execute method. A node failure returns an
// ExecutionError carrying the steps executed so far (F1).
func (r *Runtime) execute(ctx context.Context, context *runtimeContext) (*executionResult, error) {
	order := topologicalSort(context.definition)
	nodeByID := map[string]crawlworkflow.WorkflowNode{}
	for _, node := range context.definition.Nodes {
		nodeByID[node.ID] = node
	}
	incomingEdges := map[string][]crawlworkflow.WorkflowEdge{}
	for _, edge := range context.definition.Edges {
		incomingEdges[edge.Target] = append(incomingEdges[edge.Target], edge)
	}

	outputs := map[string]*nodeOutputs{}
	steps := []crawlfrontierruns.StrategyRunStep{}
	registry := newCandidateRegistry()

	for _, nodeID := range order {
		node, ok := nodeByID[nodeID]
		if !ok {
			continue
		}
		inputCandidates := collectInputCandidates(nodeID, incomingEdges[nodeID], outputs)
		start := r.now()
		nodeResult, err := r.executeNode(ctx, context, node, inputCandidates, registry)
		if err != nil {
			steps = append(steps, crawlfrontierruns.StrategyRunStep{
				NodeID:        node.ID,
				NodeType:      node.Type,
				Label:         node.Label,
				Status:        "failed",
				DurationMs:    int(r.now().Sub(start).Milliseconds()),
				InputCount:    len(inputCandidates),
				OutputCount:   0,
				RejectedCount: 0,
				SampleURLs:    []string{},
				Error:         stringPointer(err.Error()),
			})
			return nil, &ExecutionError{
				Err:              err,
				Steps:            steps,
				SystemEvents:     context.systemEvents,
				ParameterSources: context.parameterSources,
			}
		}
		outputs[node.ID] = nodeResult.outputs
		flattened := flattenOutputs(nodeResult.outputs)
		sampleURLs := make([]string, 0, 5)
		for index, candidate := range flattened {
			if index >= 5 {
				break
			}
			sampleURLs = append(sampleURLs, candidate.URL)
		}
		steps = append(steps, crawlfrontierruns.StrategyRunStep{
			NodeID:        node.ID,
			NodeType:      node.Type,
			Label:         node.Label,
			Status:        "completed",
			DurationMs:    int(r.now().Sub(start).Milliseconds()),
			InputCount:    len(inputCandidates),
			OutputCount:   len(flattened),
			RejectedCount: len(nodeResult.outputs.rejected()),
			SampleURLs:    sampleURLs,
			Metrics:       nodeResult.metrics,
		})
	}

	terminalIDs := []string{}
	for _, node := range context.definition.Nodes {
		terminal := true
		for _, edge := range context.definition.Edges {
			if edge.Source == node.ID {
				terminal = false
				break
			}
		}
		if terminal {
			terminalIDs = append(terminalIDs, node.ID)
		}
	}
	collected := []*crawlfrontierruns.StrategyRunCandidate{}
	for _, nodeID := range terminalIDs {
		if nodeOutputs, ok := outputs[nodeID]; ok {
			collected = append(collected, nodeOutputs.valuesInOrder()...)
		}
	}
	finalCandidates := dedupeCandidates(collected)
	limited := finalCandidates
	if len(limited) > context.maxCandidates {
		limited = limited[:context.maxCandidates]
	}
	selected := []*crawlfrontierruns.StrategyRunCandidate{}
	for _, candidate := range limited {
		if candidate.Status == "selected" {
			selected = append(selected, candidate)
		}
	}

	return &executionResult{
		definition:       context.definition,
		steps:            steps,
		candidates:       dereference(limited),
		selected:         dereference(selected),
		parameterSources: context.parameterSources,
		systemEvents:     context.systemEvents,
	}, nil
}

// topologicalSort ports topologicalSort: Kahn with the definition.node order as
// the initial queue and edge order for successor enqueueing; a cycle falls back
// to the original node order.
func topologicalSort(definition crawlworkflow.WorkflowDefinition) []string {
	indegree := map[string]int{}
	next := map[string][]string{}
	for _, node := range definition.Nodes {
		indegree[node.ID] = 0
		next[node.ID] = []string{}
	}
	for _, edge := range definition.Edges {
		indegree[edge.Target] = indegree[edge.Target] + 1
		next[edge.Source] = append(next[edge.Source], edge.Target)
	}
	queue := []string{}
	for _, node := range definition.Nodes {
		if indegree[node.ID] == 0 {
			queue = append(queue, node.ID)
		}
	}
	result := []string{}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		result = append(result, current)
		for _, target := range next[current] {
			remaining := indegree[target] - 1
			indegree[target] = remaining
			if remaining == 0 {
				queue = append(queue, target)
			}
		}
	}
	if len(result) != len(definition.Nodes) {
		fallback := make([]string, 0, len(definition.Nodes))
		for _, node := range definition.Nodes {
			fallback = append(fallback, node.ID)
		}
		return fallback
	}
	return result
}

// collectInputCandidates ports collectInputCandidates: per incoming edge take
// `sourceOutputs[sourceHandle ?? 'default'] ?? sourceOutputs.default ?? []`, then
// dedupe. An existing empty bucket is kept (an empty array does not fall back).
func collectInputCandidates(nodeID string, edges []crawlworkflow.WorkflowEdge, outputs map[string]*nodeOutputs) []*crawlfrontierruns.StrategyRunCandidate {
	if len(edges) == 0 {
		return []*crawlfrontierruns.StrategyRunCandidate{}
	}
	collected := []*crawlfrontierruns.StrategyRunCandidate{}
	for _, edge := range edges {
		source := outputs[edge.Source]
		if source == nil {
			continue
		}
		handle := "default"
		if edge.SourceHandle != nil && strings.TrimSpace(*edge.SourceHandle) != "" {
			handle = *edge.SourceHandle
		}
		values, ok := source.get(handle)
		if !ok {
			values, ok = source.get("default")
		}
		if !ok {
			continue
		}
		collected = append(collected, values...)
	}
	return dedupeCandidates(collected)
}

// dedupeCandidates reproduces the JS Map semantics: order by first occurrence,
// value from the last occurrence, shared pointers preserved.
func dedupeCandidates(candidates []*crawlfrontierruns.StrategyRunCandidate) []*crawlfrontierruns.StrategyRunCandidate {
	out := []*crawlfrontierruns.StrategyRunCandidate{}
	index := map[string]int{}
	for _, candidate := range candidates {
		if position, ok := index[candidate.URL]; ok {
			out[position] = candidate
			continue
		}
		index[candidate.URL] = len(out)
		out = append(out, candidate)
	}
	return out
}

func dereference(candidates []*crawlfrontierruns.StrategyRunCandidate) []crawlfrontierruns.StrategyRunCandidate {
	out := make([]crawlfrontierruns.StrategyRunCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		out = append(out, *candidate)
	}
	return out
}

// ---------------------------------------------------------------------------
// small helpers on the runtime context

func (r *Runtime) loadProfile(ctx context.Context, orgID, profileID string) (*profileRecord, error) {
	if strings.TrimSpace(profileID) == "" {
		return nil, nil
	}
	if r.db == nil {
		return nil, errors.New("crawl strategy runs: no database")
	}
	var (
		id            string
		profileOrgID  string
		executionMode string
		config        []byte
	)
	err := r.db.QueryRowContext(ctx, "SELECT id, orgId, executionMode, config FROM CrawlSiteProfile WHERE id = ?", profileID).
		Scan(&id, &profileOrgID, &executionMode, &config)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(404, "Crawl site profile not found")
	}
	if err != nil {
		return nil, err
	}
	if profileOrgID != orgID {
		return nil, newStatus(404, "Crawl site profile not found")
	}
	return &profileRecord{ID: id, ExecutionMode: executionMode, Config: json.RawMessage(config)}, nil
}

type profileRecord struct {
	ID            string
	ExecutionMode string
	Config        json.RawMessage
}

func (r *Runtime) loadNewsSource(ctx context.Context, orgID, newsSourceID string) (*newsSourceRef, error) {
	if strings.TrimSpace(newsSourceID) == "" {
		return nil, nil
	}
	if r.db == nil {
		return nil, errors.New("crawl strategy runs: no database")
	}
	var (
		id        string
		sourceOrg string
		url       string
	)
	err := r.db.QueryRowContext(ctx, "SELECT id, orgId, url FROM NewsSource WHERE id = ?", newsSourceID).
		Scan(&id, &sourceOrg, &url)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, newStatus(404, "News source not found")
	}
	if err != nil {
		return nil, err
	}
	if sourceOrg != orgID {
		return nil, newStatus(404, "News source not found")
	}
	return &newsSourceRef{ID: id, URL: url}, nil
}

func buildRunInput(input TrialRunInput, profileID, newsSourceID *string) json.RawMessage {
	fields := map[string]json.RawMessage{}
	if input.SeedURL != nil {
		fields["seedUrl"] = rawOf(*input.SeedURL)
	}
	if profileID != nil {
		fields["profileId"] = rawOf(*profileID)
	}
	if newsSourceID != nil {
		fields["newsSourceId"] = rawOf(*newsSourceID)
	}
	if input.MaxCandidates != nil {
		fields["maxCandidates"] = rawOf(*input.MaxCandidates)
	}
	if len(input.RuntimeOverrides) > 0 && strings.TrimSpace(string(input.RuntimeOverrides)) != "null" {
		fields["runtimeOverrides"] = input.RuntimeOverrides
	} else {
		fields["runtimeOverrides"] = json.RawMessage(`{}`)
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func parameterSourcesFromOverlay(overlay *crawlworkflow.CompiledProfileOverlay) []crawlworkflow.ParameterSource {
	if overlay == nil {
		return []crawlworkflow.ParameterSource{}
	}
	return overlay.ParameterSources
}

func marshalParameterSources(sources []crawlworkflow.ParameterSource) json.RawMessage {
	if sources == nil {
		return json.RawMessage(`[]`)
	}
	encoded, err := json.Marshal(sources)
	if err != nil {
		return json.RawMessage(`[]`)
	}
	return encoded
}

func numberOrDefault(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func stringPointer(value string) *string { return &value }

func rawOf(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return encoded
}

func firstString(primary, secondary *string) *string {
	if primary != nil {
		return primary
	}
	return secondary
}

func firstInt(primary, secondary *int) *int {
	if primary != nil {
		return primary
	}
	return secondary
}

func stringFromRecord(raw json.RawMessage, key string) string {
	value := stringPointerFromRecord(raw, key)
	if value == nil {
		return ""
	}
	return *value
}

func stringPointerFromRecord(raw json.RawMessage, key string) *string {
	record, ok := objectOf(raw)
	if !ok {
		return nil
	}
	var value string
	if err := json.Unmarshal(record[key], &value); err != nil {
		return nil
	}
	return &value
}

func intPointerFromRecord(raw json.RawMessage, key string) *int {
	record, ok := objectOf(raw)
	if !ok {
		return nil
	}
	number, ok := numberValue(record[key])
	if !ok {
		return nil
	}
	value := int(number)
	return &value
}

func isRecord(raw json.RawMessage) bool {
	_, ok := objectOf(raw)
	return ok
}

// sortCandidatesByComposite sorts a copy by the composite score desc then URL,
// matching `rightComposite - leftComposite || left.url.localeCompare(right.url)`.
func sortCandidatesByComposite(candidates []*crawlfrontierruns.StrategyRunCandidate) []*crawlfrontierruns.StrategyRunCandidate {
	out := make([]*crawlfrontierruns.StrategyRunCandidate, len(candidates))
	copy(out, candidates)
	sort.SliceStable(out, func(i, j int) bool {
		left := compositeScore(out[i])
		right := compositeScore(out[j])
		if left != right {
			return right < left
		}
		return out[i].URL < out[j].URL
	})
	return out
}

func compositeScore(candidate *crawlfrontierruns.StrategyRunCandidate) float64 {
	return valueOrZero(candidate.Score) + valueOrZero(candidate.FreshnessScore) + valueOrZero(candidate.RelevanceScore)
}

func valueOrZero(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}
