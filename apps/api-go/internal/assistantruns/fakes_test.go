package assistantruns

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

type fakeStore struct {
	created         createdRun
	createErr       error
	claimRecord     *runRecord
	claimErr        error
	completedOutput bson.Raw
	completedSum    string
	savedFailed     bool
	failedMessage   string
	failedSummary   *string
	blocked         *BlockedOutput
	state           *runState
	deleted         bool
	removed         bool
	rendered        []RenderedItem
	history         []historyDocument
}

func (f *fakeStore) CreateQuery(_ context.Context, orgID string, input QueryInput, _ *string) (createdRun, error) {
	if f.createErr != nil {
		return createdRun{}, f.createErr
	}
	run := f.created
	run.orgID = orgID
	return run, nil
}

func (f *fakeStore) CreateReport(context.Context, string, ReportInput, *string) (createdRun, error) {
	return f.created, f.createErr
}

func (f *fakeStore) CreateForecast(context.Context, string, ForecastInput, *string) (createdRun, error) {
	return f.created, f.createErr
}

func (f *fakeStore) Claim(context.Context, assistantqueue.ClaimedJob) (*runRecord, error) {
	return f.claimRecord, f.claimErr
}

func (f *fakeStore) SaveCompleted(_ context.Context, _ string, _ string, output bson.Raw, summary string) error {
	f.completedOutput = output
	f.completedSum = summary
	return nil
}

func (f *fakeStore) SaveFailed(_ context.Context, _ string, _ string, message string, summary *string) error {
	f.savedFailed = true
	f.failedMessage = message
	f.failedSummary = summary
	return nil
}

func (f *fakeStore) SaveBlocked(_ context.Context, _ string, _ string, output BlockedOutput) error {
	f.blocked = &output
	return nil
}

func (f *fakeStore) GetState(context.Context, string, string) (*runState, bool) {
	return f.state, f.state != nil
}

func (f *fakeStore) Delete(context.Context, string, string) (bool, error) {
	return f.deleted, nil
}

func (f *fakeStore) History(context.Context, string, string, string, time.Time) ([]historyDocument, error) {
	return f.history, nil
}

func (f *fakeStore) RenderNewsItems(context.Context, string, []NewsSourceRow) ([]RenderedItem, error) {
	return f.rendered, nil
}

type fakeQueue struct {
	added        *assistantqueue.JobData
	addedOptions assistantqueue.AddOptions
	addErr       error
	removedJobID string
	removeErr    error
}

func (f *fakeQueue) Add(_ context.Context, _ string, data assistantqueue.JobData, opts assistantqueue.AddOptions) (string, error) {
	f.added = &data
	f.addedOptions = opts
	return opts.JobID, f.addErr
}

func (f *fakeQueue) Remove(_ context.Context, jobID string) (bool, error) {
	f.removedJobID = jobID
	return true, f.removeErr
}

type fakeGovernance struct {
	snapshot  platformgovernance.AssistantQuotaSnapshot
	guardrail platformgovernance.AssistantGuardrailConfig
}

func (f fakeGovernance) AssistantQuotaSnapshot(context.Context, string) (platformgovernance.AssistantQuotaSnapshot, error) {
	return f.snapshot, nil
}

func (f fakeGovernance) AssistantGuardrails(context.Context) (platformgovernance.AssistantGuardrailConfig, error) {
	return f.guardrail, nil
}

type fakeModelAccess struct {
	keys   int
	config modelaccesssettings.AssistantModelServiceConfig
}

func (f fakeModelAccess) AssistantOpenAIKeyCount(context.Context) (int, error) { return f.keys, nil }
func (f fakeModelAccess) AssistantModelServiceConfig(context.Context) (modelaccesssettings.AssistantModelServiceConfig, error) {
	return f.config, nil
}

type fakeLLM struct {
	responses      []publicportal.AssistantCompletionResult
	streamEvents   []publicportal.AssistantStreamEvent
	capabilities   publicportal.AssistantRuntimeCapabilities
	modelOverride  string
	completionErr  error
	streamErr      error
	lastCompletion publicportal.AssistantCompletionRequest
	lastStream     publicportal.AssistantCompletionRequest
}

func (f *fakeLLM) Complete(_ context.Context, req publicportal.AssistantCompletionRequest) (publicportal.AssistantCompletionResult, error) {
	f.lastCompletion = req
	if f.completionErr != nil {
		return publicportal.AssistantCompletionResult{}, f.completionErr
	}
	if len(f.responses) == 0 {
		return publicportal.AssistantCompletionResult{}, errors.New("no completion queued")
	}
	result := f.responses[0]
	f.responses = f.responses[1:]
	return result, nil
}

func (f *fakeLLM) Stream(_ context.Context, req publicportal.AssistantCompletionRequest) (<-chan publicportal.AssistantStreamEvent, error) {
	f.lastStream = req
	if f.streamErr != nil {
		return nil, f.streamErr
	}
	events := make(chan publicportal.AssistantStreamEvent, len(f.streamEvents)+1)
	for _, event := range f.streamEvents {
		events <- event
	}
	close(events)
	return events, nil
}

func (f *fakeLLM) RuntimeCapabilities(context.Context) (publicportal.AssistantRuntimeCapabilities, error) {
	return f.capabilities, nil
}

func (f *fakeLLM) AssistantModelOverride(context.Context) (string, error) {
	return f.modelOverride, nil
}

type fakeCapabilities struct {
	caps publicportal.AssistantRuntimeCapabilities
}

func (f fakeCapabilities) RuntimeCapabilities(context.Context) (history.AssistantRuntimeCapabilitiesModel, error) {
	model := history.AssistantRuntimeCapabilitiesModel{WebSearchSupported: f.caps.WebSearchSupported}
	if f.caps.APISurface != "" {
		surface := f.caps.APISurface
		model.APISurface = &surface
	}
	if f.caps.AssistantModel != "" {
		name := f.caps.AssistantModel
		model.AssistantModel = &name
	}
	return model, nil
}

type fakeItems struct {
	page  itemsreading.ItemConnectionResult
	err   error
	calls []itemsreading.ItemsListQuery
}

func (f *fakeItems) ListItems(_ context.Context, _ string, _ string, query itemsreading.ItemsListQuery) (itemsreading.ItemConnectionResult, error) {
	f.calls = append(f.calls, query)
	return f.page, f.err
}

type fakeForecaster struct {
	response ModelServiceForecastResponse
	err      error
	request  ModelServiceForecastRequest
}

func (f *fakeForecaster) ForecastHoldoutLast(_ context.Context, request ModelServiceForecastRequest) (ModelServiceForecastResponse, error) {
	f.request = request
	return f.response, f.err
}

type fakePublisher struct {
	events []AssistantEvent
}

func (f *fakePublisher) PublishAssistant(_ context.Context, event AssistantEvent) error {
	f.events = append(f.events, event)
	return nil
}

type fakeSeries struct {
	item       *history.EconomicSeries
	candidates []history.EconomicSeriesSuggestion
	fields     []history.SeriesFieldCount
	points     []history.SeriesPoint
	findErr    error
}

func (f *fakeSeries) FindBySlug(context.Context, string) (*history.EconomicSeries, error) {
	return f.item, f.findErr
}

func (f *fakeSeries) SearchCandidates(context.Context, string, int) ([]history.EconomicSeriesSuggestion, error) {
	return f.candidates, f.findErr
}

func (f *fakeSeries) FieldCounts(context.Context, string, time.Time, time.Time) ([]history.SeriesFieldCount, error) {
	return f.fields, nil
}

func (f *fakeSeries) Points(context.Context, string, string, time.Time, time.Time) ([]history.SeriesPoint, error) {
	return f.points, nil
}

func newTestService(store runStore, queue queueProducer, llm publicportal.AssistantLLM, gov fakeGovernance, access fakeModelAccess, items ItemLister, forecaster Forecaster, publisher Publisher) *Service {
	capabilities := CapabilityReader(fakeCapabilities{})
	if fake, ok := llm.(*fakeLLM); ok {
		capabilities = fakeCapabilities{caps: fake.capabilities}
	}
	return NewService(Options{
		Store:        store,
		Queue:        queue,
		LLM:          llm,
		Items:        items,
		Series:       &fakeSeries{},
		Capabilities: capabilities,
		Governance:   gov,
		ModelAccess:  access,
		Forecaster:   forecaster,
		Publisher:    publisher,
		Env:          Env{MaxRetries: 3, LLMTimeout: 300 * time.Second, StreamFlushChars: 3, StreamFlushMs: 0},
	})
}

func testRunRecord(t *testing.T, typ RunType, input any) *runRecord {
	t.Helper()
	raw, err := bson.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return &runRecord{
		ID:        bson.NewObjectID(),
		OrgID:     "org-1",
		Type:      typ,
		Status:    RunStatusRunning,
		Input:     bson.Raw(raw),
		CreatedAt: time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
	}
}

func decodeOutput[T any](t *testing.T, raw bson.Raw) T {
	t.Helper()
	var out T
	if len(raw) == 0 {
		t.Fatalf("no output was saved")
	}
	if err := bson.Unmarshal(raw, &out); err != nil {
		t.Fatalf("output decode: %v", err)
	}
	return out
}

func marshalJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
