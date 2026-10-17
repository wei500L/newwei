package crawlfrontierruns

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// findTraceStep returns the trace step with the given key.
func findTraceStep(t *testing.T, steps []traceStep, key string) traceStep {
	t.Helper()
	for _, step := range steps {
		if step.Key == key {
			return step
		}
	}
	t.Fatalf("trace step %q not found", key)
	return traceStep{}
}

func TestBuildRunTraceStatuses(t *testing.T) {
	cases := []struct {
		name       string
		key        string
		metadata   string
		wantStatus TraceStepStatus
		wantDetail string
		wantTags   []string
	}{
		{
			name:       "seed completed keeps the untrimmed tag",
			key:        "seed",
			metadata:   `{"seedMethod":"robots","seedStrategy":"  seed_first  ","fallbackStage":"frontier"}`,
			wantStatus: TraceStepStatusCompleted,
			wantDetail: "robots",
			wantTags:   []string{"strategy:  seed_first", "method:robots", "fallback:frontier"},
		},
		{
			name:       "seed warning when the fallback stage is frontier",
			key:        "seed",
			metadata:   `{"fallbackStage":"frontier"}`,
			wantStatus: TraceStepStatusWarning,
			wantDetail: "seed_not_used",
			wantTags:   []string{"fallback:frontier"},
		},
		{
			name:       "seed skipped",
			key:        "seed",
			metadata:   `{}`,
			wantStatus: TraceStepStatusSkipped,
			wantDetail: "seed_not_used",
			wantTags:   []string{},
		},
		{
			name:       "topology completed",
			key:        "topology",
			metadata:   `{"rootDiagnosis":{"linkPreviewMode":"js","linkPreviewQuery":"a[href]","domScopeMode":"main"}}`,
			wantStatus: TraceStepStatusCompleted,
			wantDetail: "a[href]",
			wantTags:   []string{"preview:js", "dom:main"},
		},
		{
			name:       "topology skipped",
			key:        "topology",
			metadata:   `{}`,
			wantStatus: TraceStepStatusSkipped,
			wantDetail: "topology_not_applied",
			wantTags:   []string{},
		},
		{
			name:       "frontier completed",
			key:        "frontier",
			metadata:   `{"candidateStats":{"a":1},"failureKind":"captcha"}`,
			wantStatus: TraceStepStatusCompleted,
			wantDetail: "captcha",
			wantTags:   []string{"captcha"},
		},
		{
			name:       "frontier skipped",
			key:        "frontier",
			metadata:   `{}`,
			wantStatus: TraceStepStatusSkipped,
			wantDetail: "frontier_candidates_processed",
			wantTags:   []string{},
		},
		{
			name:       "native warning",
			key:        "native",
			metadata:   `{"rootDiagnosis":{"nativeStrategyType":"native","nativeFilterChainType":"f","nativeUrlScorerType":"s"},"warningFlags":["native_fallback_layered"]}`,
			wantStatus: TraceStepStatusWarning,
			wantDetail: "native",
			wantTags:   []string{"strategy:native", "filter:f", "scorer:s"},
		},
		{
			name:       "native completed",
			key:        "native",
			metadata:   `{"nativeStrategyType":"native"}`,
			wantStatus: TraceStepStatusCompleted,
			wantDetail: "native",
			wantTags:   []string{"strategy:native"},
		},
		{
			name:       "native skipped",
			key:        "native",
			metadata:   `{}`,
			wantStatus: TraceStepStatusSkipped,
			wantDetail: "native_not_used",
			wantTags:   []string{},
		},
		{
			name:       "llm judge active",
			key:        "llm_judge",
			metadata:   `{"pendingLlmJudgeJobs":2}`,
			wantStatus: TraceStepStatusActive,
			wantDetail: "2 pending",
			wantTags:   []string{"pending:2"},
		},
		{
			name:       "llm judge warning",
			key:        "llm_judge",
			metadata:   `{"warningFlags":["llm_judge_failed"]}`,
			wantStatus: TraceStepStatusWarning,
			wantDetail: "judge_not_used",
			wantTags:   []string{"llm_judge_failed"},
		},
		{
			name:       "llm judge completed",
			key:        "llm_judge",
			metadata:   `{"judgeSummary":{"count":3}}`,
			wantStatus: TraceStepStatusCompleted,
			wantDetail: "3 judged",
			wantTags:   []string{},
		},
		{
			name:       "llm judge skipped",
			key:        "llm_judge",
			metadata:   `{}`,
			wantStatus: TraceStepStatusSkipped,
			wantDetail: "judge_not_used",
			wantTags:   []string{},
		},
		{
			name:       "shadow learn completed",
			key:        "shadow_learn",
			metadata:   `{"shadowComparison":{"summary":"improved"},"shadowProfileId":"p1"}`,
			wantStatus: TraceStepStatusCompleted,
			wantDetail: "improved",
			wantTags:   []string{"shadow:p1"},
		},
		{
			name:       "shadow learn active",
			key:        "shadow_learn",
			metadata:   `{"llmLifecycle":{"learnQueuedAt":"2026-01-01T00:00:00.000Z"}}`,
			wantStatus: TraceStepStatusActive,
			wantDetail: "2026-01-01T00:00:00.000Z",
			wantTags:   []string{},
		},
		{
			name:       "shadow learn skipped",
			key:        "shadow_learn",
			metadata:   `{}`,
			wantStatus: TraceStepStatusSkipped,
			wantDetail: "shadow_learning_not_triggered",
			wantTags:   []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			metadata := decodeMetadata(tc.metadata)
			warningFlags := collectNodeWarningFlags(&metadata, nil)
			steps := buildRunTrace(&metadata, warningFlags)
			if len(steps) != 6 {
				t.Fatalf("steps = %d, want 6", len(steps))
			}
			step := findTraceStep(t, steps, tc.key)
			if step.Status != tc.wantStatus {
				t.Fatalf("status = %s, want %s", step.Status, tc.wantStatus)
			}
			if step.Detail != tc.wantDetail {
				t.Fatalf("detail = %q, want %q", step.Detail, tc.wantDetail)
			}
			if !reflect.DeepEqual(step.Tags, tc.wantTags) {
				t.Fatalf("tags = %v, want %v", step.Tags, tc.wantTags)
			}
		})
	}
}

func TestResolvePendingLlmJudgeJobs(t *testing.T) {
	metadata := decodeMetadata(`{"pendingLlmJudgeJobs":"2.6"}`)
	if got := resolvePendingLlmJudgeJobs(&metadata); got != 3 {
		t.Fatalf("pending = %v, want 3", got)
	}
	metadata = decodeMetadata(`{"pendingLlmJudgeJobs":-5}`)
	if got := resolvePendingLlmJudgeJobs(&metadata); got != 0 {
		t.Fatalf("pending = %v, want 0", got)
	}
	metadata = decodeMetadata(`{"pendingLlmJudgeJobs":"abc"}`)
	if got := resolvePendingLlmJudgeJobs(&metadata); got != 0 {
		t.Fatalf("pending = %v, want 0", got)
	}
}

func TestBuildNodeExtractionSummary(t *testing.T) {
	title := "Title"
	subtitle := ""
	source := "Source"
	published := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	processed := &processedArticleDocument{
		Status:            "completed",
		Title:             &title,
		Subtitle:          &subtitle,
		Source:            &source,
		PublishedAt:       nestFromTime(published),
		QualityScore:      nil,
		RemovedNoiseTypes: RawJSON(`["noise","","ads"]`),
	}
	summary := buildNodeExtractionSummary(true, processed)
	if !summary.HasArticle || !summary.HasProcessedArticle {
		t.Fatalf("presence flags = %+v", summary)
	}
	if !reflect.DeepEqual(summary.ExtractedFields, []string{"title", "source", "published_at"}) {
		t.Fatalf("extracted = %v", summary.ExtractedFields)
	}
	if !reflect.DeepEqual(summary.MissingFields, []string{"author"}) {
		t.Fatalf("missing = %v", summary.MissingFields)
	}
	if !reflect.DeepEqual(summary.RemovedNoiseTypes, []string{"noise", "ads"}) {
		t.Fatalf("removedNoiseTypes = %v", summary.RemovedNoiseTypes)
	}

	empty := buildNodeExtractionSummary(false, nil)
	if empty.HasArticle || empty.HasProcessedArticle {
		t.Fatalf("empty presence flags = %+v", empty)
	}
	if !reflect.DeepEqual(empty.ExtractedFields, []string{}) {
		t.Fatalf("empty extracted = %v", empty.ExtractedFields)
	}
	if !reflect.DeepEqual(empty.MissingFields, []string{"title", "author", "source", "published_at"}) {
		t.Fatalf("empty missing = %v", empty.MissingFields)
	}
	if !reflect.DeepEqual(empty.RemovedNoiseTypes, []string{}) {
		t.Fatalf("empty removedNoiseTypes = %v", empty.RemovedNoiseTypes)
	}
}

func TestBuildNodeRepairSummary(t *testing.T) {
	metadata := RawJSON(`{"llmRepair":{"applied":true,"source":"src","model":"m","error":"e","missingFields":["x"],"repairedFields":["y"],"promptTokens":"12","latencyMs":"abc"}}`)
	summary := buildNodeRepairSummary(metadata)
	if summary == nil {
		t.Fatal("repair summary must not be nil")
	}
	if !summary.Available || !summary.Attempted || !summary.Applied {
		t.Fatalf("flags = %+v", summary)
	}
	if summary.PromptTokens == nil || *summary.PromptTokens != 12 {
		t.Fatalf("promptTokens = %v", summary.PromptTokens)
	}
	if summary.LatencyMS != nil {
		t.Fatalf("latencyMs must be nil, got %v", *summary.LatencyMS)
	}
	if !reflect.DeepEqual(summary.MissingFields, []string{"x"}) || !reflect.DeepEqual(summary.RepairedFields, []string{"y"}) {
		t.Fatalf("fields = %v / %v", summary.MissingFields, summary.RepairedFields)
	}

	if got := buildNodeRepairSummary(RawJSON(`{"other":1}`)); got != nil {
		t.Fatalf("missing llmRepair must map to nil, got %+v", got)
	}
}

func TestBuildLlmLogFiltersOmission(t *testing.T) {
	nodeID := "node-1"
	profileID := "profile-1"
	withRepair := buildLlmLogFilters("run-1", &nodeID, &profileID, true)
	encoded, err := json.Marshal(withRepair)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"judge":{"profileId":"profile-1","runId":"run-1","nodeId":"node-1","feature":"crawl_frontier_judge"},` +
		`"learn":{"profileId":"profile-1","runId":"run-1","feature":"crawl_frontier_learn"},` +
		`"repair":{"profileId":"profile-1","runId":"run-1","nodeId":"node-1","feature":"crawl_article_repair"}}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s\nwant    = %s", encoded, want)
	}

	withoutRepair := buildLlmLogFilters("run-1", &nodeID, nil, false)
	encoded, err = json.Marshal(withoutRepair)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "repair") {
		t.Fatalf("repair key must be omitted: %s", encoded)
	}
	if strings.Contains(string(encoded), "profileId") {
		t.Fatalf("profileId must be omitted when empty: %s", encoded)
	}
}

func TestUndefinedOmissionKeepsZeroAndEmptyString(t *testing.T) {
	zero := 0.0
	accepted := false
	trace := traceDocument{
		NodeID:     "node",
		NodeType:   "type",
		Action:     "action",
		Message:    "message",
		Accepted:   &accepted,
		ScoreDelta: &zero,
		Timestamp:  nestFromTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}
	encoded, err := json.Marshal(trace)
	if err != nil {
		t.Fatalf("marshal trace: %v", err)
	}
	if !strings.Contains(string(encoded), `"accepted":false`) || !strings.Contains(string(encoded), `"scoreDelta":0`) {
		t.Fatalf("zero and false must be preserved: %s", encoded)
	}
	if strings.Contains(string(encoded), "ruleHits") || strings.Contains(string(encoded), "details") {
		t.Fatalf("absent optional fields must be omitted: %s", encoded)
	}

	step := stepDocument{StepKey: "s", NodeID: "s", NodeType: "t", Label: "L", Status: "completed", SampleURLs: RawJSON("[]")}
	encoded, err = json.Marshal(step)
	if err != nil {
		t.Fatalf("marshal step: %v", err)
	}
	wantStep := `{"stepKey":"s","nodeId":"s","nodeType":"t","label":"L","status":"completed","durationMs":0,` +
		`"inputCount":0,"outputCount":0,"rejectedCount":0,"sampleUrls":[],"error":null}`
	if string(encoded) != wantStep {
		t.Fatalf("step = %s\nwant  = %s", encoded, wantStep)
	}

	candidate := candidateDocument{
		ID:           "external",
		URL:          "https://example.com/",
		Status:       "accepted",
		SourceNodeID: "unknown",
		Metadata:     RawJSON("{}"),
		Trace:        []traceDocument{},
	}
	encoded, err = json.Marshal(candidate)
	if err != nil {
		t.Fatalf("marshal candidate: %v", err)
	}
	wantCandidate := `{"id":"external","url":"https://example.com/","publishedAt":null,"crawledAt":null,` +
		`"effectiveAt":null,"status":"accepted","rejectedByNodeId":null,"rejectedReason":null,` +
		`"sourceNodeId":"unknown","metadata":{},"trace":[]}`
	if string(encoded) != wantCandidate {
		t.Fatalf("candidate = %s\nwant      = %s", encoded, wantCandidate)
	}
}

func TestTraceRejectedReasonFromDetails(t *testing.T) {
	details := []byte(`{"rejectedReason":"low_score"}`)
	view := traceDetailsView{}
	if err := json.Unmarshal(details, &view); err != nil {
		t.Fatalf("unmarshal details: %v", err)
	}
	if !view.RejectedReason.OK || view.RejectedReason.Value != "low_score" {
		t.Fatalf("rejectedReason = %+v", view.RejectedReason)
	}
	empty := traceDetailsView{}
	if err := json.Unmarshal([]byte(`{"rejectedReason":1}`), &empty); err != nil {
		t.Fatalf("unmarshal non-string details: %v", err)
	}
	if empty.RejectedReason.OK {
		t.Fatalf("non-string rejectedReason must not be present")
	}
}
