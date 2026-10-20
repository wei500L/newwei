package assistantruns

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

func TestParseQueryPlanBranches(t *testing.T) {
	news := parseQueryPlan(json.RawMessage(`{"kind":"news_negative_list","topic":"gold","lookbackDays":7,"limit":20}`))
	if news.Kind != planNewsNegativeList || news.Topic != "gold" || *news.LookbackDays != 7 || *news.Limit != 20 {
		t.Fatalf("news plan = %+v", news)
	}
	gold := parseQueryPlan(json.RawMessage(`{"kind":"correlation_gold_usd","transform":"level"}`))
	if gold.Kind != planCorrelationGoldUSD || gold.Transform == nil || *gold.Transform != "level" {
		t.Fatalf("gold plan = %+v", gold)
	}
	two := parseQueryPlan(json.RawMessage(`{"kind":"correlation_two_series","seriesA":"gold","seriesB":"usd","lookbackDays":365}`))
	if two.Kind != planCorrelationTwo || *two.SeriesA != "gold" || *two.SeriesB != "usd" {
		t.Fatalf("two-series plan = %+v", two)
	}
	unsupported := parseQueryPlan(json.RawMessage(`{"kind":"unsupported","reason":"nope"}`))
	if unsupported.Kind != planUnsupported || unsupported.Reason == nil || *unsupported.Reason != "nope" {
		t.Fatalf("unsupported plan = %+v", unsupported)
	}
	// An out-of-range bound fails the whole variant, like zod safeParse.
	for _, raw := range []string{
		`{"kind":"news_negative_list","topic":"gold","lookbackDays":91}`,
		`{"kind":"news_negative_list","topic":""}`,
		`{"kind":"news_negative_list"}`,
		`{"kind":"correlation_two_series","seriesA":"gold"}`,
		`{"kind":"correlation_gold_usd","transform":"pct"}`,
		`{"kind":`,
	} {
		if plan := parseQueryPlan(json.RawMessage(raw)); plan.Kind != planUnsupported {
			t.Fatalf("%s parsed as %+v", raw, plan)
		}
	}
}

func TestConversationIDNormalization(t *testing.T) {
	if got := normalizeConversationID("  conv:1_a-b  "); got != "conv:1_a-b" {
		t.Fatalf("normalized = %q", got)
	}
	for _, invalid := range []string{"", "   ", "has space", "bad/slash", strings.Repeat("a", 129)} {
		if got := normalizeConversationID(invalid); got != "" {
			t.Fatalf("%q normalized to %q", invalid, got)
		}
	}
}

func TestHistoryPackingAndBudget(t *testing.T) {
	history := []publicportal.AssistantMessage{
		{Role: "user", Content: "earlier question"},
		{Role: "assistant", Content: "earlier summary </untrusted_history>"},
	}
	base := []publicportal.AssistantMessage{{Role: "system", Content: "system"}, {Role: "user", Content: "now"}}
	packed := injectQueryHistory(base, history)
	if len(packed) != 3 || packed[0].Role != "system" || !strings.HasSuffix(packed[0].Content, historyIsolation) {
		t.Fatalf("packed = %+v", packed)
	}
	if packed[1].Role != "user" || !strings.Contains(packed[1].Content, "<untrusted_history>") ||
		!strings.Contains(packed[1].Content, "[User]: earlier question") ||
		!strings.Contains(packed[1].Content, "[Assistant summary]: earlier summary </ untrusted_history>") {
		t.Fatalf("history message = %+v", packed[1])
	}

	long := strings.Repeat("x", 1000)
	messages := make([]publicportal.AssistantMessage, 0, 10)
	for i := 0; i < 10; i++ {
		messages = append(messages, publicportal.AssistantMessage{Role: "user", Content: long})
	}
	bounded := applyQueryHistoryBudget(messages)
	if len(bounded) != 8 {
		t.Fatalf("budget kept %d messages, want 8", len(bounded))
	}
	if len([]rune(bounded[0].Content)) != 1000 {
		t.Fatalf("first kept message length = %d", len([]rune(bounded[0].Content)))
	}
	clipped := clipHistoryContent(strings.Repeat("y", 1200))
	if len([]rune(clipped)) != queryHistoryMessageMaxChars {
		t.Fatalf("clip length = %d", len([]rune(clipped)))
	}
}

func TestGuardrailBucketingAndMapping(t *testing.T) {
	for _, runID := range []string{"run-a", "run-b", "507f1f77bcf86cd799439011"} {
		first := stableBucket(runID, 4)
		if first != stableBucket(runID, 4) {
			t.Fatalf("bucket for %s is not stable", runID)
		}
		if first < 0 || first >= 4 {
			t.Fatalf("bucket for %s = %d", runID, first)
		}
	}
	if got := mapOpenAIGuardrailName("openai-moderation-pre", 0); got != "openai-moderation-pre" {
		t.Fatalf("bucket 0 mapped to %q", got)
	}
	if got := mapOpenAIGuardrailName("openai-moderation-post", 2); got != "openai-moderation-post-3" {
		t.Fatalf("suffixed name = %q", got)
	}
	if got := mapOpenAIGuardrailName("custom-guard", 2); got != "custom-guard" {
		t.Fatalf("custom name = %q", got)
	}
}

func TestCorrelationTransformAndPearson(t *testing.T) {
	x, y := transformAlignedSeries([]float64{1, 2, 4}, []float64{2, 4, 8}, "return")
	if len(x) != 2 || x[0] != 1 || x[1] != 1 || y[0] != 1 || y[1] != 1 {
		t.Fatalf("return transform = %v %v", x, y)
	}
	x, y = transformAlignedSeries([]float64{1, 2, 0}, []float64{2, 4, 0}, "level")
	if len(x) != 3 {
		t.Fatalf("level transform = %v %v", x, y)
	}
	// A zero previous level skips that return pair.
	x, _ = transformAlignedSeries([]float64{1, 0, 2}, []float64{1, 2, 4}, "return")
	if len(x) != 1 {
		t.Fatalf("zero-level return pairs = %v", x)
	}
	if value := pearsonCorrelation([]float64{1, 2, 3}, []float64{2, 4, 6}); value == nil || *value < 0.999 {
		t.Fatalf("pearson = %v", value)
	}
	if value := pearsonCorrelation([]float64{1, 1, 1}, []float64{1, 2, 3}); value != nil {
		t.Fatalf("zero-variance pearson = %v", value)
	}
	if value := pearsonCorrelation([]float64{1, 2}, []float64{1, 2}); value != nil {
		t.Fatalf("short pearson = %v", value)
	}
}

func TestSentimentStatsKeepInsertionOrder(t *testing.T) {
	negative, positive := "negative", "positive"
	items := []RenderedItem{{Sentiment: &negative}, {Sentiment: nil}, {Sentiment: &positive}, {Sentiment: &negative}}
	counts, order := sentimentCounts(items)
	if counts["negative"] != 2 || counts["positive"] != 1 || counts["unknown"] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
	if strings.Join(order, ",") != "negative,unknown,positive" {
		t.Fatalf("order = %v", order)
	}
	encoded, err := marshalOrderedStats(counts, order)
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `{"negative":2,"unknown":1,"positive":1}` {
		t.Fatalf("stats json = %s", encoded)
	}
}

func TestClaimStatusesA2(t *testing.T) {
	normal := claimStatuses(0)
	if len(normal) != 2 || normal[0] != RunStatusPending || normal[1] != RunStatusFailed {
		t.Fatalf("normal statuses = %v", normal)
	}
	stalled := claimStatuses(1)
	if len(stalled) != 3 || stalled[2] != RunStatusRunning {
		t.Fatalf("stalled statuses = %v", stalled)
	}
}

func TestQuotaGateBranches(t *testing.T) {
	store := &fakeStore{}
	queue := &fakeQueue{}
	llm := &fakeLLM{}
	items := &fakeItems{}
	forecaster := &fakeForecaster{}
	publisher := &fakePublisher{}

	submitLimited := newTestService(store, queue, llm, fakeGovernance{snapshot: platformgovernance.AssistantQuotaSnapshot{
		Enabled: true, SubmitLimitPerHour: 5,
	}}, fakeModelAccess{keys: 1}, items, forecaster, publisher)
	if _, err := submitLimited.SubmitQuery(context.Background(), "org-1", QueryInput{Message: "hi"}, nil); err == nil {
		t.Fatal("submit limit did not reject")
	} else {
		var failure *Failure
		if !errors.As(err, &failure) || failure.Status != 429 || failure.Message != submitLimitMessage {
			t.Fatalf("submit limit error = %v", err)
		}
	}

	inFlightLimited := newTestService(store, queue, llm, fakeGovernance{snapshot: platformgovernance.AssistantQuotaSnapshot{
		Enabled: true, MaxInFlightPerOrg: 1, InFlight: 1,
	}}, fakeModelAccess{keys: 1}, items, forecaster, publisher)
	if _, err := inFlightLimited.SubmitQuery(context.Background(), "org-1", QueryInput{Message: "hi"}, nil); err == nil {
		t.Fatal("in-flight limit did not reject")
	} else {
		var failure *Failure
		if !errors.As(err, &failure) || failure.Message != inFlightLimitMessage {
			t.Fatalf("in-flight error = %v", err)
		}
	}

	budgetLimited := newTestService(store, queue, llm, fakeGovernance{snapshot: platformgovernance.AssistantQuotaSnapshot{
		Enabled: true, MonthlyTokenBudget: 100, TotalTokens: 100,
	}}, fakeModelAccess{keys: 1}, items, forecaster, publisher)
	if _, err := budgetLimited.SubmitQuery(context.Background(), "org-1", QueryInput{Message: "hi"}, nil); err == nil {
		t.Fatal("token budget did not reject")
	} else {
		var failure *Failure
		if !errors.As(err, &failure) || failure.Message != tokenBudgetMessage {
			t.Fatalf("budget error = %v", err)
		}
	}

	disabled := newTestService(store, queue, llm, fakeGovernance{snapshot: platformgovernance.AssistantQuotaSnapshot{Enabled: false}}, fakeModelAccess{keys: 1}, items, forecaster, publisher)
	if _, err := disabled.SubmitQuery(context.Background(), "org-1", QueryInput{Message: "hi"}, nil); err != nil {
		t.Fatalf("disabled quota rejected: %v", err)
	}
}

func TestSubmitQueryA1Compensation(t *testing.T) {
	store := &fakeStore{created: createdRun{ID: "run-1", Type: RunTypeQuery, Status: RunStatusPending, CreatedAt: time.Now().UTC()}}
	queue := &fakeQueue{addErr: errors.New("redis down")}
	publisher := &fakePublisher{}
	llm := &fakeLLM{}
	service := newTestService(store, queue, llm, fakeGovernance{snapshot: platformgovernance.AssistantQuotaSnapshot{Enabled: false}}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, publisher)
	if _, err := service.SubmitQuery(context.Background(), "org-1", QueryInput{Message: "hi"}, nil); err == nil || err.Error() != "redis down" {
		t.Fatalf("enqueue failure = %v", err)
	}
	if !store.savedFailed || store.failedMessage != "redis down" {
		t.Fatalf("orphan was not marked failed: %+v", store)
	}
	if len(publisher.events) != 1 || publisher.events[0].Run.Status != string(RunStatusFailed) || publisher.events[0].Run.Error == nil {
		t.Fatalf("failed event = %+v", publisher.events)
	}
}

func TestSubmitQueryHappyPathQueueContract(t *testing.T) {
	store := &fakeStore{created: createdRun{ID: "run-1", Type: RunTypeQuery, Status: RunStatusPending, CreatedAt: time.Now().UTC()}}
	queue := &fakeQueue{}
	service := newTestService(store, queue, &fakeLLM{}, fakeGovernance{snapshot: platformgovernance.AssistantQuotaSnapshot{Enabled: false}}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	run, err := service.SubmitQuery(context.Background(), "org-1", QueryInput{Message: "hi"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != RunStatusPending || run.ConversationID == nil || *run.ConversationID == "" {
		t.Fatalf("submitted run = %+v", run)
	}
	if queue.added == nil || queue.added.RunID != "run-1" || queue.added.OrgID != "org-1" || queue.added.Type != assistantqueue.JobTypeQuery {
		t.Fatalf("job data = %+v", queue.added)
	}
	if queue.addedOptions.JobID != "assistant:query:run-1" || queue.addedOptions.Attempts != 3 ||
		queue.addedOptions.Backoff.Type != "exponential" || queue.addedOptions.Backoff.Delay != 2000 {
		t.Fatalf("job options = %+v", queue.addedOptions)
	}
}

func TestSubmitQueryWebSearchUnsupported(t *testing.T) {
	store := &fakeStore{created: createdRun{ID: "run-1", Type: RunTypeQuery, Status: RunStatusPending, CreatedAt: time.Now().UTC()}}
	llm := &fakeLLM{capabilities: publicportal.AssistantRuntimeCapabilities{APISurface: "chat_completions"}}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{snapshot: platformgovernance.AssistantQuotaSnapshot{Enabled: false}}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	_, err := service.SubmitQuery(context.Background(), "org-1", QueryInput{Message: "hi", KnowledgeSource: KnowledgeSourceWebSearch}, nil)
	var failure *Failure
	if !errors.As(err, &failure) || failure.Status != 400 || failure.Code != "WEB_SEARCH_UNSUPPORTED" {
		t.Fatalf("web search error = %v", err)
	}
}

func TestDeleteRunRules(t *testing.T) {
	store := &fakeStore{state: &runState{Type: RunTypeQuery, Status: RunStatusRunning}}
	queue := &fakeQueue{}
	service := newTestService(store, queue, &fakeLLM{}, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	if _, err := service.DeleteRun(context.Background(), "org-1", " "); err == nil {
		t.Fatal("empty run id was accepted")
	}
	if _, err := service.DeleteRun(context.Background(), "org-1", "run-1"); err == nil {
		t.Fatal("running run was deleted")
	} else {
		var failure *Failure
		if !errors.As(err, &failure) || failure.Status != 409 {
			t.Fatalf("running error = %v", err)
		}
	}

	store.state = &runState{Type: RunTypeQuery, Status: RunStatusPending}
	store.deleted = true
	deleted, err := service.DeleteRun(context.Background(), "org-1", "run-1")
	if err != nil || !deleted {
		t.Fatalf("pending delete = %v %v", deleted, err)
	}
	if queue.removedJobID != "assistant:query:run-1" {
		t.Fatalf("removed job = %q", queue.removedJobID)
	}

	store.state = nil
	deleted, err = service.DeleteRun(context.Background(), "org-1", "missing")
	if err != nil || deleted {
		t.Fatalf("missing delete = %v %v", deleted, err)
	}
}

func TestProcessNewsQueryOutput(t *testing.T) {
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "negative gold news", ConversationID: "conv-1", KnowledgeSource: KnowledgeSourceSiteDB})
	published := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{
		claimRecord: record,
		rendered: []RenderedItem{{
			ItemMetaID:  "meta-1",
			Title:       stringPtr("Gold falls"),
			Summary:     stringPtr("summary"),
			Source:      stringPtr("wire"),
			PublishedAt: stringPtr("2026-10-19T12:00:00.000Z"),
			URL:         stringPtr("https://example.test/a"),
			Sentiment:   stringPtr("negative"),
		}},
	}
	items := &fakeItems{page: itemsreading.ItemConnectionResult{Edges: []itemsreading.ItemListEdge{{
		Row: itemsreading.ItemMetaRow{
			ID:          "meta-1",
			Name:        "Gold falls",
			MongoRef:    "507f1f77bcf86cd799439011",
			PublishedAt: &itemsreading.ISOTime{Time: published},
		},
	}}}}
	llm := &fakeLLM{
		responses: []publicportal.AssistantCompletionResult{{Content: `{"kind":"news_negative_list","topic":"gold","lookbackDays":7,"limit":20}`}},
		streamEvents: []publicportal.AssistantStreamEvent{
			{Model: "gpt-test", Delta: "hello "},
			{Model: "gpt-test", Delta: "world"},
		},
	}
	publisher := &fakePublisher{}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{}, fakeModelAccess{keys: 1}, items, &fakeForecaster{}, publisher)
	job := assistantqueue.ClaimedJob{ID: "assistant:query:" + record.ID.Hex(), Data: assistantqueue.JobData{Type: assistantqueue.JobTypeQuery, RunID: record.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	output := decodeOutput[QueryNewsOutput](t, store.completedOutput)
	if output.Plan.Kind != "news_negative_list" || output.Plan.Topic != "gold" {
		t.Fatalf("plan = %+v", output.Plan)
	}
	if len(output.Items) != 1 || output.Items[0].ItemMetaID != "meta-1" {
		t.Fatalf("items = %+v", output.Items)
	}
	if output.Summary != "hello world" || store.completedSum != "hello world" {
		t.Fatalf("summary = %q / %q", output.Summary, store.completedSum)
	}
	if output.Raw.Model == nil || *output.Raw.Model != "gpt-test" || !output.Raw.Stream {
		t.Fatalf("raw = %+v", output.Raw)
	}
	if len(items.calls) != 1 || items.calls[0].RankingMode != itemsreading.ItemsRankingRelevance || items.calls[0].Filters == nil ||
		len(items.calls[0].Filters.Sentiments) != 1 || items.calls[0].Filters.Sentiments[0] != "negative" {
		t.Fatalf("items query = %+v", items.calls)
	}
	if len(publisher.events) < 2 || publisher.events[0].Run.Status != string(RunStatusRunning) || publisher.events[len(publisher.events)-1].Run.Status != string(RunStatusCompleted) {
		t.Fatalf("events = %+v", publisher.events)
	}
}

func TestProcessGuardrailBlockedOutput(t *testing.T) {
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "hi", ConversationID: "conv-1", KnowledgeSource: KnowledgeSourceSiteDB})
	store := &fakeStore{claimRecord: record, rendered: []RenderedItem{}}
	llm := &fakeLLM{
		responses: []publicportal.AssistantCompletionResult{{Content: `{"kind":"unsupported"}`}},
		streamEvents: []publicportal.AssistantStreamEvent{{Err: &publicportal.AssistantGuardrailError{
			Message:           "Unable to complete request: blocked by content moderation.",
			Code:              "MODERATION_BLOCKED",
			AppliedGuardrails: []string{"openai-moderation-pre"},
			UpstreamStatus:    400,
		}}},
	}
	publisher := &fakePublisher{}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, publisher)
	job := assistantqueue.ClaimedJob{Data: assistantqueue.JobData{Type: assistantqueue.JobTypeQuery, RunID: record.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err != nil {
		t.Fatalf("guardrail must not be retried: %v", err)
	}
	if store.blocked == nil || !store.blocked.Blocked || store.blocked.Code != "MODERATION_BLOCKED" ||
		store.blocked.UpstreamStatus == nil || *store.blocked.UpstreamStatus != 400 {
		t.Fatalf("blocked output = %+v", store.blocked)
	}
	last := publisher.events[len(publisher.events)-1]
	if last.Run.Status != string(RunStatusCompleted) || last.Run.Summary == nil || *last.Run.Summary != store.blocked.Summary || last.Run.Error != nil {
		t.Fatalf("blocked event = %+v", last)
	}
}

func TestProcessStreamFailureKeepsPartialSummary(t *testing.T) {
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "hi", ConversationID: "conv-1", KnowledgeSource: KnowledgeSourceSiteDB})
	store := &fakeStore{claimRecord: record, rendered: []RenderedItem{}}
	llm := &fakeLLM{
		responses: []publicportal.AssistantCompletionResult{{Content: `{"kind":"unsupported"}`}},
		streamEvents: []publicportal.AssistantStreamEvent{
			{Delta: "par"},
			{Err: errors.New("stream broke")},
		},
	}
	publisher := &fakePublisher{}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, publisher)
	job := assistantqueue.ClaimedJob{Data: assistantqueue.JobData{Type: assistantqueue.JobTypeQuery, RunID: record.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err == nil {
		t.Fatal("stream failure must be retried")
	}
	if !store.savedFailed || store.failedSummary == nil || *store.failedSummary != "par" {
		t.Fatalf("failed summary = %+v", store)
	}
	last := publisher.events[len(publisher.events)-1]
	if last.Run.Status != string(RunStatusFailed) || last.Run.Error == nil || *last.Run.Error != "stream broke" {
		t.Fatalf("failed event = %+v", last)
	}
}

func TestProcessUnknownJobTypeFails(t *testing.T) {
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "hi"})
	store := &fakeStore{claimRecord: record}
	service := newTestService(store, &fakeQueue{}, &fakeLLM{}, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	job := assistantqueue.ClaimedJob{Data: assistantqueue.JobData{Type: "weird", RunID: record.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err == nil {
		t.Fatal("unknown job type did not fail")
	}
	if !store.savedFailed || !strings.Contains(store.failedMessage, "Unsupported assistant job type") {
		t.Fatalf("failed message = %q", store.failedMessage)
	}
}

func TestProcessReportAndForecast(t *testing.T) {
	reportRecord := testRunRecord(t, RunTypeReport, ReportInput{Period: "weekly", Topic: stringPtr("energy"), Limit: intPtr(10)})
	store := &fakeStore{claimRecord: reportRecord, rendered: []RenderedItem{{ItemMetaID: "m1", Sentiment: stringPtr("positive")}}}
	llm := &fakeLLM{streamEvents: []publicportal.AssistantStreamEvent{{Delta: "report"}}}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	job := assistantqueue.ClaimedJob{Data: assistantqueue.JobData{Type: assistantqueue.JobTypeReport, RunID: reportRecord.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	report := decodeOutput[ReportOutput](t, store.completedOutput)
	if report.Period != "weekly" || report.Topic == nil || *report.Topic != "energy" || report.Stats["positive"] != 1 || report.Summary != "report" {
		t.Fatalf("report output = %+v", report)
	}
}

func TestRuntimeCapabilitiesWebSearch(t *testing.T) {
	service := newTestService(&fakeStore{}, &fakeQueue{}, &fakeLLM{capabilities: publicportal.AssistantRuntimeCapabilities{APISurface: "responses", WebSearchSupported: true}}, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	if err := service.ensureWebSearchSupported(context.Background()); err != nil {
		t.Fatalf("supported profile rejected: %v", err)
	}
}

func stringPtr(value string) *string { return &value }

func TestProcessWebSearchBranchUsesResponsesTools(t *testing.T) {
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "latest gold news", ConversationID: "conv-1", KnowledgeSource: KnowledgeSourceWebSearch})
	store := &fakeStore{claimRecord: record}
	llm := &fakeLLM{
		capabilities: publicportal.AssistantRuntimeCapabilities{APISurface: "responses", WebSearchSupported: true},
		streamEvents: []publicportal.AssistantStreamEvent{{Model: "gpt-web", Delta: "answer"}},
	}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	job := assistantqueue.ClaimedJob{Data: assistantqueue.JobData{Type: assistantqueue.JobTypeQuery, RunID: record.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	output := decodeOutput[QueryWebSearchOutput](t, store.completedOutput)
	if output.KnowledgeSource != "web_search" || output.Summary != "answer" {
		t.Fatalf("output = %+v", output)
	}
	if len(llm.lastStream.Tools) != 1 || !strings.Contains(string(llm.lastStream.Tools[0]), "web_search_preview") {
		t.Fatalf("tools = %s", llm.lastStream.Tools)
	}
	if len(llm.responses) != 0 {
		t.Fatalf("planner must not run for web_search")
	}
}

func TestProcessCorrelationBranch(t *testing.T) {
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "gold vs usd", ConversationID: "conv-1", KnowledgeSource: KnowledgeSourceSiteDB})
	store := &fakeStore{claimRecord: record}
	llm := &fakeLLM{
		responses: []publicportal.AssistantCompletionResult{
			{Content: `{"kind":"correlation_two_series","seriesA":"gold","seriesB":"usd","lookbackDays":30,"transform":"return"}`},
			{Content: `{"fieldA":"close","fieldB":"close"}`},
		},
		streamEvents: []publicportal.AssistantStreamEvent{{Delta: "corr"}},
	}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, &fakeForecaster{}, &fakePublisher{})
	gold := &history.EconomicSeries{ID: "item-a", Slug: "gold_futures_main", DisplayName: "Gold"}
	usd := &history.EconomicSeries{ID: "item-b", Slug: "usd_index_history", DisplayName: "USD"}
	service.series = &fakeSeriesMap{
		bySlug: map[string]*history.EconomicSeries{
			"gold": gold, "usd": usd,
			"gold_futures_main": gold, "usd_index_history": usd,
		},
		candidates: []history.EconomicSeriesSuggestion{
			{Slug: "gold_futures_main", DisplayName: "Gold"},
		},
		fields: []history.SeriesFieldCount{{Name: "close", Count: 10}},
		points: []history.SeriesPoint{
			{RecordedAt: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Value: 1},
			{RecordedAt: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), Value: 2},
			{RecordedAt: time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC), Value: 3},
			{RecordedAt: time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC), Value: 4},
		},
	}
	job := assistantqueue.ClaimedJob{Data: assistantqueue.JobData{Type: assistantqueue.JobTypeQuery, RunID: record.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	output := decodeOutput[QueryCorrelationOutput](t, store.completedOutput)
	if output.Plan.Kind != "correlation_two_series" || output.Plan.SeriesA.Slug == "" || output.Plan.SeriesB.Slug == "" {
		t.Fatalf("plan = %+v", output.Plan)
	}
	if len(output.References) != 2 || output.Stats.Pearson == nil {
		t.Fatalf("output = %+v", output)
	}
}

// fakeSeriesMap resolves explicit slugs to distinct series.
type fakeSeriesMap struct {
	bySlug     map[string]*history.EconomicSeries
	candidates []history.EconomicSeriesSuggestion
	fields     []history.SeriesFieldCount
	points     []history.SeriesPoint
}

func (f *fakeSeriesMap) FindBySlug(_ context.Context, slug string) (*history.EconomicSeries, error) {
	return f.bySlug[slug], nil
}

func (f *fakeSeriesMap) SearchCandidates(context.Context, string, int) ([]history.EconomicSeriesSuggestion, error) {
	return f.candidates, nil
}

func (f *fakeSeriesMap) FieldCounts(context.Context, string, time.Time, time.Time) ([]history.SeriesFieldCount, error) {
	return f.fields, nil
}

func (f *fakeSeriesMap) Points(context.Context, string, string, time.Time, time.Time) ([]history.SeriesPoint, error) {
	return f.points, nil
}

func TestProcessForecastBranch(t *testing.T) {
	record := testRunRecord(t, RunTypeForecast, ForecastInput{Series: "gold", LookbackDays: intPtr(30), SourceField: stringPtr("close")})
	store := &fakeStore{claimRecord: record}
	llm := &fakeLLM{streamEvents: []publicportal.AssistantStreamEvent{{Delta: "forecast"}}}
	forecaster := &fakeForecaster{response: ModelServiceForecastResponse{
		Model:       json.RawMessage(`{"kind":"ets","seasonal_period":7}`),
		Forecast:    ForecastPoint{Timestamp: "2026-10-20T00:00:00.000Z", Expected: 9, Lower: 8, Upper: 10, Sigma: 0.5},
		Diagnostics: json.RawMessage(`{"aic":1.2}`),
	}}
	service := newTestService(store, &fakeQueue{}, llm, fakeGovernance{}, fakeModelAccess{keys: 1}, &fakeItems{}, forecaster, &fakePublisher{})
	gold := &history.EconomicSeries{ID: "item-a", Slug: "gold_futures_main", DisplayName: "Gold"}
	points := make([]history.SeriesPoint, 0, 12)
	for index := 0; index < 12; index++ {
		points = append(points, history.SeriesPoint{RecordedAt: time.Date(2026, 10, 1+index, 0, 0, 0, 0, time.UTC), Value: float64(index + 1)})
	}
	service.series = &fakeSeries{
		item:   gold,
		fields: []history.SeriesFieldCount{{Name: "close", Count: 12}},
		points: points,
	}
	job := assistantqueue.ClaimedJob{Data: assistantqueue.JobData{Type: assistantqueue.JobTypeForecast, RunID: record.ID.Hex(), OrgID: "org-1"}}
	if err := service.Process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	output := decodeOutput[ForecastOutput](t, store.completedOutput)
	if output.Series.Slug != "gold_futures_main" || output.Series.Field != "close" || !output.ModelServiceUsed {
		t.Fatalf("series = %+v", output.Series)
	}
	if output.Actual.Value != 12 || output.Forecast.Expected != 9 {
		t.Fatalf("actual/forecast = %+v %+v", output.Actual, output.Forecast)
	}
	if output.Errors.Error != 3 || output.Errors.PctError == nil || *output.Errors.PctError != 0.25 {
		t.Fatalf("errors = %+v", output.Errors)
	}
	if len(output.Model) == 0 || len(output.Diagnostics) == 0 || output.Summary != "forecast" {
		t.Fatalf("output = %+v", output)
	}
	if forecaster.request.RequestID != record.ID.Hex() || forecaster.request.Model.Kind != "ets" {
		t.Fatalf("model request = %+v", forecaster.request)
	}
}
