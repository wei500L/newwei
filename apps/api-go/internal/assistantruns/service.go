package assistantruns

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/assistantqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// Env is the assistant runtime tuning read from the ASSISTANT_* environment.
type Env struct {
	QueueConcurrency int
	MaxRetries       int
	LLMTimeout       time.Duration
	StreamFlushChars int
	StreamFlushMs    int
}

// GovernanceReader is the platformgovernance read surface the submit gate and
// the worker guardrail selection use.
type GovernanceReader interface {
	AssistantQuotaSnapshot(ctx context.Context, orgID string) (platformgovernance.AssistantQuotaSnapshot, error)
	AssistantGuardrails(ctx context.Context) (platformgovernance.AssistantGuardrailConfig, error)
}

// ModelAccessReader is the modelaccesssettings read surface: the OpenAI key
// count used by guardrail bucketing and the model-service configuration.
type ModelAccessReader interface {
	AssistantOpenAIKeyCount(ctx context.Context) (int, error)
	AssistantModelServiceConfig(ctx context.Context) (modelaccesssettings.AssistantModelServiceConfig, error)
}

// ItemLister is the itemsreading list surface (page 1, PUBLISHED_DESC,
// optional RELEVANCE rerank).
type ItemLister interface {
	ListItems(ctx context.Context, orgID string, userID string, query itemsreading.ItemsListQuery) (itemsreading.ItemConnectionResult, error)
}

// CapabilityReader reuses the history assistantRuntimeCapabilities projection.
type CapabilityReader interface {
	RuntimeCapabilities(ctx context.Context) (history.AssistantRuntimeCapabilitiesModel, error)
}

// Forecaster is the external forecast service surface.
type Forecaster interface {
	ForecastHoldoutLast(ctx context.Context, request ModelServiceForecastRequest) (ModelServiceForecastResponse, error)
}

// runStore is the Mongo persistence surface. *Store is the production
// implementation; tests substitute a fake.
type runStore interface {
	CreateQuery(ctx context.Context, orgID string, input QueryInput, triggeredBy *string) (createdRun, error)
	CreateReport(ctx context.Context, orgID string, input ReportInput, triggeredBy *string) (createdRun, error)
	CreateForecast(ctx context.Context, orgID string, input ForecastInput, triggeredBy *string) (createdRun, error)
	Claim(ctx context.Context, job assistantqueue.ClaimedJob) (*runRecord, error)
	SaveCompleted(ctx context.Context, runID string, orgID string, output bson.Raw, summary string) error
	SaveFailed(ctx context.Context, runID string, orgID string, errMessage string, summary *string) error
	SaveBlocked(ctx context.Context, runID string, orgID string, output BlockedOutput) error
	GetState(ctx context.Context, orgID, runID string) (*runState, bool)
	Delete(ctx context.Context, orgID, runID string) (bool, error)
	History(ctx context.Context, orgID, conversationID, runID string, before time.Time) ([]historyDocument, error)
	RenderNewsItems(ctx context.Context, orgID string, rows []NewsSourceRow) ([]RenderedItem, error)
}

// queueProducer is the BullMQ producer surface. *assistantqueue.Producer is the
// production implementation.
type queueProducer interface {
	Add(ctx context.Context, name string, data assistantqueue.JobData, opts assistantqueue.AddOptions) (string, error)
	Remove(ctx context.Context, jobID string) (bool, error)
}

// Options wires the assistant run service. Every dependency is required; the
// caller only constructs the service when both switches need it.
type Options struct {
	Store        runStore
	Queue        queueProducer
	Redis        *redis.Client
	LLM          publicportal.AssistantLLM
	Items        ItemLister
	Series       SeriesReader
	Capabilities CapabilityReader
	Governance   GovernanceReader
	ModelAccess  ModelAccessReader
	Forecaster   Forecaster
	Publisher    Publisher
	Observer     RequestLogger
	Env          Env
}

// Service implements the assistant submit/delete mutations and the worker
// business chain.
type Service struct {
	store        runStore
	queue        queueProducer
	redis        *redis.Client
	llm          publicportal.AssistantLLM
	items        ItemLister
	series       SeriesReader
	capabilities CapabilityReader
	governance   GovernanceReader
	modelAccess  ModelAccessReader
	forecaster   Forecaster
	publisher    Publisher
	observer     RequestLogger
	env          Env
}

// NewService builds the assistant run service.
func NewService(options Options) *Service {
	env := options.Env
	if env.MaxRetries <= 0 {
		env.MaxRetries = 3
	}
	if env.LLMTimeout <= 0 {
		env.LLMTimeout = 300 * time.Second
	}
	if env.StreamFlushChars <= 0 {
		env.StreamFlushChars = 80
	}
	if env.StreamFlushMs < 0 {
		env.StreamFlushMs = 250
	}
	return &Service{
		store:        options.Store,
		queue:        options.Queue,
		redis:        options.Redis,
		llm:          options.LLM,
		items:        options.Items,
		series:       options.Series,
		capabilities: options.Capabilities,
		governance:   options.Governance,
		modelAccess:  options.ModelAccess,
		forecaster:   options.Forecaster,
		publisher:    options.Publisher,
		observer:     options.Observer,
		env:          env,
	}
}

// SubmitQuery ports submitQuery. The conversation id is normalized (invalid
// values become a fresh UUID), the knowledge source defaults to site_db and a
// web_search request is rejected when the active profile cannot serve it.
func (s *Service) SubmitQuery(ctx context.Context, orgID string, input QueryInput, triggeredBy *string) (SubmittedRun, error) {
	if err := s.assertCanSubmit(ctx, orgID); err != nil {
		return SubmittedRun{}, err
	}
	conversationID := normalizeConversationID(input.ConversationID)
	if conversationID == "" {
		generated, err := newUUID()
		if err != nil {
			return SubmittedRun{}, err
		}
		conversationID = generated
	}
	knowledgeSource := normalizeKnowledgeSource(input.KnowledgeSource)
	if knowledgeSource == KnowledgeSourceWebSearch {
		if err := s.ensureWebSearchSupported(ctx); err != nil {
			return SubmittedRun{}, err
		}
	}
	stored := QueryInput{Message: input.Message, ConversationID: conversationID, KnowledgeSource: knowledgeSource}
	created, err := s.store.CreateQuery(ctx, orgID, stored, triggeredBy)
	if err != nil {
		return SubmittedRun{}, err
	}
	if err := s.enqueue(ctx, created, RunTypeQuery, orgID); err != nil {
		return SubmittedRun{}, s.compensateEnqueueFailure(ctx, created, err)
	}
	return SubmittedRun{
		ID:             created.ID,
		Type:           created.Type,
		Status:         created.Status,
		ConversationID: &conversationID,
		CreatedAt:      created.CreatedAt,
	}, nil
}

// SubmitReport ports submitReport.
func (s *Service) SubmitReport(ctx context.Context, orgID string, input ReportInput, triggeredBy *string) (SubmittedRun, error) {
	if err := s.assertCanSubmit(ctx, orgID); err != nil {
		return SubmittedRun{}, err
	}
	created, err := s.store.CreateReport(ctx, orgID, input, triggeredBy)
	if err != nil {
		return SubmittedRun{}, err
	}
	if err := s.enqueue(ctx, created, RunTypeReport, orgID); err != nil {
		return SubmittedRun{}, s.compensateEnqueueFailure(ctx, created, err)
	}
	return SubmittedRun{ID: created.ID, Type: created.Type, Status: created.Status, CreatedAt: created.CreatedAt}, nil
}

// SubmitForecast ports submitForecast.
func (s *Service) SubmitForecast(ctx context.Context, orgID string, input ForecastInput, triggeredBy *string) (SubmittedRun, error) {
	if err := s.assertCanSubmit(ctx, orgID); err != nil {
		return SubmittedRun{}, err
	}
	created, err := s.store.CreateForecast(ctx, orgID, input, triggeredBy)
	if err != nil {
		return SubmittedRun{}, err
	}
	if err := s.enqueue(ctx, created, RunTypeForecast, orgID); err != nil {
		return SubmittedRun{}, s.compensateEnqueueFailure(ctx, created, err)
	}
	return SubmittedRun{ID: created.ID, Type: created.Type, Status: created.Status, CreatedAt: created.CreatedAt}, nil
}

// enqueue adds the BullMQ job with the NestJS job id, attempts, exponential
// backoff and removeOnComplete=true.
func (s *Service) enqueue(ctx context.Context, run createdRun, typ RunType, orgID string) error {
	if s.queue == nil {
		return errors.New("assistant queue is not configured")
	}
	traceID := httpx.TraceIDFromContext(ctx)
	if traceID == "" {
		traceID = httpx.EnsureTraceID("")
	}
	jobID := fmt.Sprintf("assistant:%s:%s", typ, run.ID)
	_, err := s.queue.Add(ctx, string(typ), assistantqueue.JobData{
		Type:    assistantqueue.JobType(typ),
		RunID:   run.ID,
		OrgID:   orgID,
		TraceID: traceID,
	}, assistantqueue.AddOptions{
		JobID:    jobID,
		Attempts: s.env.MaxRetries,
		Backoff:  assistantqueue.Backoff{Type: "exponential", Delay: 2_000},
	})
	return err
}

// compensateEnqueueFailure is A1: an enqueue failure marks the orphan pending
// row failed, publishes that status and returns the original error (500). The
// row then stops consuming the in-flight quota and can be deleted.
func (s *Service) compensateEnqueueFailure(ctx context.Context, run createdRun, cause error) error {
	message := cause.Error()
	if err := s.store.SaveFailed(ctx, run.ID, run.OrgID(), message, nil); err != nil {
		log.Printf("api-go: assistant run %s enqueue compensation failed: %v", run.ID, err)
	}
	s.publish(ctx, run.OrgID(), run.ID, run.Type, RunStatusFailed, nil, &message, run.CreatedAt)
	return cause
}

// OrgID is stored on the created run by the submit methods; createdRun keeps it
// private because the GraphQL projection does not expose it.
func (r createdRun) OrgID() string { return r.orgID }

// DeleteRun ports deleteRun. A malformed or missing id answers false; a running
// run answers 409; a pending run removes its queue job best effort before the
// document is deleted.
func (s *Service) DeleteRun(ctx context.Context, orgID, runID string) (bool, error) {
	normalized := strings.TrimSpace(runID)
	if normalized == "" {
		return false, failure(400, "runId is required")
	}
	state, ok := s.store.GetState(ctx, orgID, normalized)
	if !ok {
		return false, nil
	}
	if state.Status == RunStatusRunning {
		return false, failure(409, "Assistant run is currently running and cannot be deleted")
	}
	if state.Status == RunStatusPending && s.queue != nil {
		jobID := fmt.Sprintf("assistant:%s:%s", state.Type, normalized)
		removed, err := s.queue.Remove(ctx, jobID)
		if err != nil {
			log.Printf("api-go: failed to remove pending assistant job before deleting run %s: %v", normalized, err)
		} else if !removed {
			log.Printf("api-go: pending assistant job %s was already claimed or missing; deleting run %s anyway", jobID, normalized)
		}
	}
	return s.store.Delete(ctx, orgID, normalized)
}

// Process is the BullMQ handler. It claims the run, publishes running, executes
// the task type, and applies the completed / guardrail-blocked / failed rules.
func (s *Service) Process(ctx context.Context, job assistantqueue.ClaimedJob) error {
	record, err := s.store.Claim(ctx, job)
	if err != nil {
		log.Printf("api-go: assistant run %s claim failed: %v", job.Data.RunID, err)
		return err
	}
	if record == nil {
		log.Printf("api-go: assistant run %s is not claimable", job.Data.RunID)
		return nil
	}
	createdAt := record.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	s.publish(ctx, record.OrgID, record.ID.Hex(), record.Type, RunStatusRunning, nil, nil, createdAt)

	guardrailConfig, err := s.governance.AssistantGuardrails(ctx)
	if err != nil {
		return s.failRun(ctx, record, createdAt, err)
	}
	guardrails, err := s.pickGuardrails(ctx, record.ID.Hex(), guardrailConfig.Guardrails)
	if err != nil {
		return s.failRun(ctx, record, createdAt, err)
	}
	assistantModel, err := s.llm.AssistantModelOverride(ctx)
	if err != nil {
		return s.failRun(ctx, record, createdAt, err)
	}

	jobType := job.Data.Type
	if jobType == "" {
		jobType = assistantqueue.JobType(record.Type)
	}
	var output bson.Raw
	var summary string
	switch jobType {
	case assistantqueue.JobTypeQuery:
		var input QueryInput
		if len(record.Input) > 0 {
			if err := bson.Unmarshal(record.Input, &input); err != nil {
				return s.failRun(ctx, record, createdAt, err)
			}
		}
		output, summary, err = s.runQuery(ctx, record, createdAt, input, guardrails, assistantModel)
	case assistantqueue.JobTypeReport:
		var input ReportInput
		if len(record.Input) > 0 {
			if err := bson.Unmarshal(record.Input, &input); err != nil {
				return s.failRun(ctx, record, createdAt, err)
			}
		}
		output, summary, err = s.runReport(ctx, record, createdAt, input, guardrails, assistantModel)
	case assistantqueue.JobTypeForecast:
		var input ForecastInput
		if len(record.Input) > 0 {
			if err := bson.Unmarshal(record.Input, &input); err != nil {
				return s.failRun(ctx, record, createdAt, err)
			}
		}
		output, summary, err = s.runForecast(ctx, record, createdAt, input, guardrails, assistantModel)
	default:
		err = fmt.Errorf("Unsupported assistant job type: %s", jobType)
	}
	if err != nil {
		var guardrail *publicportal.AssistantGuardrailError
		if errors.As(err, &guardrail) {
			log.Printf("api-go: assistant run %s blocked by guardrails %v (upstream=%d)", record.ID.Hex(), guardrail.AppliedGuardrails, guardrail.UpstreamStatus)
			blocked := BlockedOutput{
				Blocked:           true,
				Code:              guardrail.Code,
				Summary:           guardrail.Message,
				AppliedGuardrails: guardrail.AppliedGuardrails,
				UpstreamStatus:    optionalInt(guardrail.UpstreamStatus),
			}
			if blocked.AppliedGuardrails == nil {
				blocked.AppliedGuardrails = []string{}
			}
			if saveErr := s.store.SaveBlocked(ctx, record.ID.Hex(), record.OrgID, blocked); saveErr != nil {
				return saveErr
			}
			s.publish(ctx, record.OrgID, record.ID.Hex(), record.Type, RunStatusCompleted, &blocked.Summary, nil, createdAt)
			return nil
		}
		return s.failRun(ctx, record, createdAt, err)
	}
	if err := s.store.SaveCompleted(ctx, record.ID.Hex(), record.OrgID, output, summary); err != nil {
		return s.failRun(ctx, record, createdAt, err)
	}
	s.publish(ctx, record.OrgID, record.ID.Hex(), record.Type, RunStatusCompleted, &summary, nil, createdAt)
	return nil
}

// failRun writes status=failed (keeping the partial stream summary), publishes
// failed with the error and returns the error so BullMQ retries the job.
func (s *Service) failRun(ctx context.Context, record *runRecord, createdAt time.Time, cause error) error {
	message := cause.Error()
	var summary *string
	var streamError *assistantStreamError
	if errors.As(cause, &streamError) {
		partial := streamError.PartialSummary
		summary = &partial
	}
	if err := s.store.SaveFailed(ctx, record.ID.Hex(), record.OrgID, message, summary); err != nil {
		log.Printf("api-go: assistant run %s failure write failed: %v", record.ID.Hex(), err)
	}
	s.publish(ctx, record.OrgID, record.ID.Hex(), record.Type, RunStatusFailed, summary, &message, createdAt)
	return cause
}

// pickGuardrails deduplicates the effective guardrails and, when more than one
// OpenAI key is configured, maps the moderation guardrails to the key shard of
// this run id (stableBucket).
func (s *Service) pickGuardrails(ctx context.Context, runID string, base []string) ([]string, error) {
	normalized := make([]string, 0, len(base))
	seen := make(map[string]bool, len(base))
	for _, entry := range base {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		normalized = append(normalized, trimmed)
	}
	if len(normalized) == 0 {
		return nil, nil
	}
	keyCount, err := s.modelAccess.AssistantOpenAIKeyCount(ctx)
	if err != nil {
		return nil, err
	}
	if keyCount <= 1 {
		return normalized, nil
	}
	bucket := stableBucket(runID, keyCount)
	mapped := make([]string, 0, len(normalized))
	for _, name := range normalized {
		mapped = append(mapped, mapOpenAIGuardrailName(name, bucket))
	}
	return mapped, nil
}

func stableBucket(input string, buckets int) int {
	if buckets < 1 {
		buckets = 1
	}
	digest := sha256.Sum256([]byte(input))
	value := uint32(digest[0])<<24 | uint32(digest[1])<<16 | uint32(digest[2])<<8 | uint32(digest[3])
	return int(value % uint32(buckets))
}

func mapOpenAIGuardrailName(name string, bucket int) string {
	if bucket <= 0 {
		return name
	}
	if name == "openai-moderation-pre" || name == "openai-moderation-post" {
		return fmt.Sprintf("%s-%d", name, bucket+1)
	}
	return name
}

// ensureWebSearchSupported ports ensureWebSearchSupported.
func (s *Service) ensureWebSearchSupported(ctx context.Context) error {
	capabilities, err := s.llm.RuntimeCapabilities(ctx)
	if err != nil {
		return err
	}
	if !capabilities.WebSearchSupported {
		return &Failure{Status: 400, Code: "WEB_SEARCH_UNSUPPORTED", Message: "Active assistant profile does not support web search."}
	}
	return nil
}

// publish emits one assistantEvents message. The createdAt is rendered with
// JavaScript toISOString precision.
func (s *Service) publish(ctx context.Context, orgID, id string, typ RunType, status RunStatus, summary, errorMessage *string, createdAt time.Time) {
	if s.publisher == nil {
		return
	}
	_ = s.publisher.PublishAssistant(ctx, AssistantEvent{
		OrgID: orgID,
		Run: AssistantRunRef{
			ID:        id,
			Type:      string(typ),
			Status:    string(status),
			Summary:   summary,
			Error:     errorMessage,
			CreatedAt: createdAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		},
	})
}

// normalizeConversationID ports normalizeConversationId: trim, enforce the
// 128-character and [A-Za-z0-9:_-] rules, and return "" for anything invalid.
func normalizeConversationID(value string) string {
	normalized := strings.TrimSpace(value)
	if normalized == "" || len([]rune(normalized)) > 128 {
		return ""
	}
	for _, r := range normalized {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == ':' || r == '_' || r == '-':
		default:
			return ""
		}
	}
	return normalized
}

func normalizeKnowledgeSource(value KnowledgeSource) KnowledgeSource {
	if value == KnowledgeSourceWebSearch {
		return KnowledgeSourceWebSearch
	}
	return KnowledgeSourceSiteDB
}

func optionalInt(value int) *int {
	if value == 0 {
		return nil
	}
	return &value
}

// newUUID returns a random RFC 4122 version 4 UUID, the shape Node
// randomUUID() produces.
func newUUID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buf)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
