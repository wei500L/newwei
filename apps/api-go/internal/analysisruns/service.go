package analysisruns

// This file contains the request submitter and the queue handler that claims a
// run, dispatches one of the three computations and persists the terminal
// state under the BullMQ lock token.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/analysisqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// Submitter is the request-side analysis service: insert the pending Mongo
// document, then add the BullMQ job. The two writes are deliberately not a
// cross-store transaction; an enqueue failure is returned and leaves the
// pending row behind, exactly like the NestJS submit path.
type Submitter struct {
	store    *Store
	producer *analysisqueue.Producer
}

// NewSubmitter builds the request service.
func NewSubmitter(store *Store, producer *analysisqueue.Producer) *Submitter {
	return &Submitter{store: store, producer: producer}
}

// SubmitCorrelation persists and enqueues one correlation run.
func (s *Submitter) SubmitCorrelation(ctx context.Context, orgID string, input CorrelationInput, triggeredByID *string, traceID string) (PendingRecord, error) {
	return submitPending(ctx, s, orgID, TypeCorrelation, input, triggeredByID, traceID)
}

// SubmitAnomaly persists and enqueues one anomaly run.
func (s *Submitter) SubmitAnomaly(ctx context.Context, orgID string, input AnomalyInput, triggeredByID *string, traceID string) (PendingRecord, error) {
	return submitPending(ctx, s, orgID, TypeAnomaly, input, triggeredByID, traceID)
}

// SubmitGeoTransport persists and enqueues one geo transport run.
func (s *Submitter) SubmitGeoTransport(ctx context.Context, orgID string, input GeoTransportInput, triggeredByID *string, traceID string) (PendingRecord, error) {
	return submitPending(ctx, s, orgID, TypeGeoTransport, input, triggeredByID, traceID)
}

func submitPending[T any](
	ctx context.Context,
	submitter *Submitter,
	orgID string,
	analysisType Type,
	input T,
	triggeredByID *string,
	traceID string,
) (PendingRecord, error) {
	if submitter == nil || submitter.store == nil {
		return PendingRecord{}, fmt.Errorf("analysisruns: store is not configured")
	}
	if submitter.producer == nil {
		return PendingRecord{}, fmt.Errorf("analysisruns: analysis queue is not configured")
	}
	record, err := InsertPending(ctx, submitter.store, orgID, analysisType, input, triggeredByID)
	if err != nil {
		return PendingRecord{}, err
	}
	if _, err := submitter.producer.Add(ctx, analysisqueue.Payload{
		Type:       string(analysisType),
		AnalysisID: record.ID,
		OrgID:      orgID,
		TraceID:    traceID,
	}); err != nil {
		return PendingRecord{}, err
	}
	return record, nil
}

// Handler consumes analysis jobs. It owns the claim/fence lifecycle and the
// three real computations.
type Handler struct {
	store         *Store
	geo           *GeoBuilder
	streamer      publicportal.AnalysisStreamer
	prompts       *PromptBuilder
	events        *EventPublisher
	notifications *NotificationWriter
	logs          *llmlogs.AnalysisStreamWriter
	flushChars    int
	flushMs       int
	timeoutMs     int
}

// HandlerOptions are the production dependencies of the worker handler.
type HandlerOptions struct {
	Store         *Store
	Geo           *GeoBuilder
	Streamer      publicportal.AnalysisStreamer
	Prompts       *PromptBuilder
	Events        *EventPublisher
	Notifications *NotificationWriter
	Logs          *llmlogs.AnalysisStreamWriter
	FlushChars    int
	FlushMs       int
	TimeoutMs     int
}

// NewHandler validates and builds the worker handler.
func NewHandler(options HandlerOptions) (*Handler, error) {
	if options.Store == nil {
		return nil, fmt.Errorf("analysisruns: handler requires a store")
	}
	if options.Geo == nil {
		return nil, fmt.Errorf("analysisruns: handler requires a geo builder")
	}
	if options.Streamer == nil {
		return nil, fmt.Errorf("analysisruns: handler requires an analysis streamer")
	}
	if options.Prompts == nil {
		options.Prompts = NewPromptBuilder(PromptOverrides{})
	}
	if options.Events == nil {
		return nil, fmt.Errorf("analysisruns: handler requires an event publisher")
	}
	if options.Notifications == nil {
		return nil, fmt.Errorf("analysisruns: handler requires a notification writer")
	}
	if options.FlushChars < 1 {
		options.FlushChars = 80
	}
	if options.FlushMs < 0 {
		options.FlushMs = 0
	}
	if options.TimeoutMs < 0 {
		options.TimeoutMs = 300_000
	}
	return &Handler{
		store:         options.Store,
		geo:           options.Geo,
		streamer:      options.Streamer,
		prompts:       options.Prompts,
		events:        options.Events,
		notifications: options.Notifications,
		logs:          options.Logs,
		flushChars:    options.FlushChars,
		flushMs:       options.FlushMs,
		timeoutMs:     options.TimeoutMs,
	}, nil
}

// Handle implements analysisqueue.Processor.
func (h *Handler) Handle(ctx context.Context, job analysisqueue.Job) error {
	if job.Payload.AnalysisID == "" {
		return &analysisqueue.UnrecoverableError{Err: fmt.Errorf("analysis job has no analysisId")}
	}
	id, err := bson.ObjectIDFromHex(job.Payload.AnalysisID)
	if err != nil {
		// The source findOneAndUpdate would throw a CastError and the run could
		// never succeed; no record exists to mutate or notify.
		log.Printf("analysisruns: job %s has an invalid analysisId", job.ID)
		return nil
	}
	record, found, err := h.store.Load(ctx, id)
	if err != nil {
		return err
	}
	if !found {
		log.Printf("analysisruns: analysis record %s not found; acknowledging job %s", job.Payload.AnalysisID, job.ID)
		return nil
	}
	if job.Payload.OrgID != "" && job.Payload.OrgID != record.OrgID {
		// Never touch another organization's document, publish its events or
		// notify its user, even if the payload was forged.
		log.Printf("analysisruns: job %s org does not match the result record", job.ID)
		return &analysisqueue.UnrecoverableError{Err: fmt.Errorf("analysis job org does not match the result record")}
	}
	if Type(job.Payload.Type) != record.Type {
		log.Printf("analysisruns: job %s type does not match the result record", job.ID)
		return &analysisqueue.UnrecoverableError{Err: fmt.Errorf("analysis job type does not match the result record")}
	}
	if record.Status == StatusCompleted {
		// Completed runs are never recomputed; acknowledge the job.
		return nil
	}
	if record.Status != StatusPending && record.Status != StatusFailed && record.Status != StatusRunning {
		return nil
	}

	claimed, ok, err := h.store.Claim(ctx, id, job.Token)
	if err != nil {
		return err
	}
	if !ok {
		// Another attempt completed or replaced the record between the read and
		// the claim. Do not run the model again.
		return nil
	}
	record = claimed
	if record.CreatedAt.IsZero() {
		// Historical documents without timestamps use the current time for the
		// event/chunk createdAt, exactly like the NestJS fallback.
		record.CreatedAt = nowMillis()
	}

	h.publishRunning(ctx, record)

	if job.DeferredFailure != "" {
		// BullMQ marked the job unrecoverable because it stalled more than the
		// allowable limit. This attempt owns the new lease and must advance the
		// Mongo/event/notification terminal state instead of leaving running.
		return h.failRun(ctx, job, record, errors.New(job.DeferredFailure))
	}

	summary, output, runErr := h.compute(ctx, record)
	if runErr != nil {
		return h.failRun(ctx, job, record, runErr)
	}
	matched, err := h.store.Complete(ctx, record.ID, job.Token, output, summary)
	if err != nil {
		return err
	}
	if !matched {
		return &analysisqueue.LeaseLostError{Reason: "result was superseded before completion"}
	}
	record.Status = StatusCompleted
	record.Summary = &summary
	record.Error = nil
	h.publishTerminal(ctx, record, &summary, nil)
	h.notifyCompleted(ctx, record)
	return nil
}

// compute dispatches the three real computations. It never writes Mongo; the
// caller owns the fencing update.
func (h *Handler) compute(ctx context.Context, record Record) (string, OutputDocument, error) {
	switch record.Type {
	case TypeCorrelation:
		input, err := decodeInput[CorrelationInput](record.Input)
		if err != nil {
			return "", nil, err
		}
		messages := h.prompts.CorrelationMessages(input)
		collector := h.collector(record, messages)
		summary, raw, err := collector.run(ctx, "")
		if err != nil {
			return "", nil, err
		}
		return summary, CorrelationOutput{Summary: summary, Raw: raw}, nil
	case TypeAnomaly:
		input, err := decodeInput[AnomalyInput](record.Input)
		if err != nil {
			return "", nil, err
		}
		messages, findings, statsSummary := h.prompts.AnomalyMessages(input)
		prefix := ""
		if len(findings) > 0 {
			prefix = "统计检测：\n" + statsSummary + "\n\n"
		}
		collector := h.collector(record, messages)
		summary, raw, err := collector.run(ctx, prefix)
		if err != nil {
			return "", nil, err
		}
		return summary, AnomalyOutput{
			Summary:             summary,
			Raw:                 raw,
			StatisticalFindings: findings,
		}, nil
	case TypeGeoTransport:
		input, err := decodeInput[GeoTransportInput](record.Input)
		if err != nil {
			return "", nil, err
		}
		geoContext, err := h.geo.Build(ctx, record.OrgID, input)
		if err != nil {
			return "", nil, err
		}
		messages := h.prompts.GeoTransportMessages(input, geoContext)
		collector := h.collector(record, messages)
		summary, raw, err := collector.run(ctx, "")
		if err != nil {
			return "", nil, err
		}
		return summary, GeoTransportOutput{
			Summary:       summary,
			Raw:           raw,
			PromptVersion: GeoPromptVersion,
			Context:       geoContext,
		}, nil
	default:
		return "", nil, fmt.Errorf("analysisruns: unsupported analysis type %q", record.Type)
	}
}

func (h *Handler) collector(record Record, messages []publicportal.AnalysisMessage) *streamCollector {
	return &streamCollector{
		streamer:     h.streamer,
		events:       h.events,
		orgID:        record.OrgID,
		analysisID:   record.ID.Hex(),
		analysisType: record.Type,
		createdAt:    record.CreatedAt,
		flushChars:   h.flushChars,
		flushMs:      h.flushMs,
		timeoutMs:    h.timeoutMs,
		messages:     messages,
		observer:     &analysisStreamLogObserver{writer: h.logs},
	}
}

func (h *Handler) failRun(ctx context.Context, job analysisqueue.Job, record Record, cause error) error {
	if errors.Is(context.Cause(ctx), analysisqueue.ErrLeaseLost) {
		return &analysisqueue.LeaseLostError{Reason: "lock lost during execution"}
	}
	if ctx.Err() != nil {
		// Worker shutdown or an already-canceled lease: do not write a terminal
		// state. The job stays active and stalled recovery claims it again.
		return ctx.Err()
	}
	message := cause.Error()
	partial, hasPartial := partialSummaryFromError(cause)
	matched, err := h.store.Fail(ctx, record.ID, job.Token, message, partial, hasPartial)
	if err != nil {
		return err
	}
	if !matched {
		return &analysisqueue.LeaseLostError{Reason: "result was superseded before failure"}
	}
	failed := record
	failed.Status = StatusFailed
	failed.Error = &message
	if hasPartial {
		failed.Summary = &partial
	}
	var summaryPointer *string
	switch {
	case hasPartial:
		summaryPointer = &partial
	case record.Summary != nil:
		summaryPointer = record.Summary
	}
	h.publishTerminal(ctx, failed, summaryPointer, &message)
	if job.FinalFailure() {
		h.notifyFinalFailure(ctx, failed)
	}
	return cause
}

func (h *Handler) publishRunning(ctx context.Context, record Record) {
	if err := h.events.Publish(ctx, record.OrgID, record.ID.Hex(), record.Type, StatusRunning, nil, nil, record.CreatedAt); err != nil && ctx.Err() == nil {
		log.Printf("analysisruns: publish running event: %v", err)
	}
}

func (h *Handler) publishTerminal(ctx context.Context, record Record, summary *string, errText *string) {
	if err := h.events.Publish(ctx, record.OrgID, record.ID.Hex(), record.Type, record.Status, summary, errText, record.CreatedAt); err != nil && ctx.Err() == nil {
		log.Printf("analysisruns: publish %s event: %v", record.Status, err)
	}
}

// Notification writes use a short independent context: the SQL row is the
// durable notification result, while the job context may be canceled at the
// worker shutdown deadline after the Mongo result was already written. The
// write is still bounded so shutdown cannot hang on a dead database.
func (h *Handler) notifyCompleted(_ context.Context, record Record) {
	notifyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.notifications.NotifyCompleted(notifyCtx, record); err != nil {
		log.Printf("analysisruns: failed to send analysis notification: %v", err)
	}
}

func (h *Handler) notifyFinalFailure(_ context.Context, record Record) {
	notifyCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.notifications.NotifyFinalFailure(notifyCtx, record); err != nil {
		log.Printf("analysisruns: failed to send analysis failure notification: %v", err)
	}
}

// analysisStreamLogObserver writes one llmrequestlogs row per real stream
// attempt. It uses an independent short context so a canceled job context does
// not drop the log, and a write failure only warns.
type analysisStreamLogObserver struct {
	writer *llmlogs.AnalysisStreamWriter
}

func (o *analysisStreamLogObserver) ObserveAnalysisStreamAttempt(ctx context.Context, attempt publicportal.AnalysisStreamAttempt) {
	if o == nil || o.writer == nil {
		return
	}
	status := "error"
	if attempt.Success {
		status = "success"
	}
	errorText := ""
	if attempt.Err != nil {
		errorText = attempt.Err.Error()
	}
	governance := attempt.GovernanceApplied
	entry := llmlogs.AnalysisStreamLogEntry{
		OrgID:   attempt.OrgID,
		Model:   attempt.Model,
		Status:  status,
		Error:   errorText,
		Latency: attempt.Latency,
		Usage: llmlogs.CompletionUsage{
			PromptTokens:     attempt.Usage.PromptTokens,
			CompletionTokens: attempt.Usage.CompletionTokens,
			TotalTokens:      attempt.Usage.TotalTokens,
			CostUSD:          attempt.Usage.CostUSD,
		},
		GatewayProfileID:          attempt.GatewayProfileID,
		GovernanceApplied:         &governance,
		AuthMode:                  attempt.AuthMode,
		GovernanceTargetProfileID: attempt.GovernanceTargetProfileID,
		APISurface:                attempt.APISurface,
		OccurredAt:                time.Now(),
	}
	logCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := o.writer.WriteAttempt(logCtx, entry); err != nil {
		log.Printf("analysisruns: analysis LLM request log write failed: %v", err)
	}
}
