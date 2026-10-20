package newspipeline

import (
	"context"
	"encoding/json"
	"time"
)

// This file ports the create side of news-pipeline-outbox.service.ts that the
// pipeline call path executes: buildProcessedItemOutboxPayload,
// buildPendingProcessedItem and the immediate-delivery hook. The Mongo write of
// the processed item itself belongs to the #116 delivery owner
// (internal/processeditemoutbox), reached through OutboxDispatcher.
//
// Deliberate difference from NestJS: the in-process outbox retry timer
// (setTimeout + retryPendingOutbox queue) is not ported. The migration runs the
// #116 scanner as the sole compensation owner in go mode, so a failed immediate
// delivery is compensated by the scanner's next tick instead of by a per-entry
// timer in this worker. The immediate delivery after commit is kept, bounded by
// pipeline.outboxDeliveryConcurrency, and it runs off the caller's context for
// the same reason the NestJS setImmediate flush does.

// processedItemOutboxPayload is ProcessedItemOutboxPayload.
type processedItemOutboxPayload struct {
	Type     string                      `json:"type"`
	Document processedItemOutboxDocument `json:"document"`
}

// processedItemOutboxDocument is the document member. Optional members are
// pointers without omitempty only where the TypeScript object always writes the
// key (sourceId is `?? null`), and pointers with omitempty where an undefined
// value is dropped by JSON.stringify.
type processedItemOutboxDocument struct {
	ID                    string      `json:"_id"`
	RawItemID             string      `json:"rawItemId"`
	ItemMetaID            string      `json:"itemMetaId"`
	OrgID                 string      `json:"orgId"`
	SourceID              *string     `json:"sourceId"`
	Status                string      `json:"status"`
	Tags                  []string    `json:"tags"`
	Result                CleanedNews `json:"result"`
	LLM                   LLMMetadata `json:"llm"`
	SummaryEmbedding      *[]float64  `json:"summaryEmbedding,omitempty"`
	SummaryEmbeddingModel *string     `json:"summaryEmbeddingModel,omitempty"`
	DuplicateOf           *string     `json:"duplicateOf,omitempty"`
	DuplicateSimilarity   *float64    `json:"duplicateSimilarity,omitempty"`
}

// processedItemOutboxInput is buildProcessedItemOutboxPayload's input.
type processedItemOutboxInput struct {
	ProcessedItemID       string
	Raw                   RawItem
	OrgID                 string
	SourceID              *string
	Payload               NormalizedPayload
	Cleaned               CleanedNews
	LLM                   LLMMetadata
	SummaryEmbedding      []float64
	SummaryEmbeddingModel *string
	DuplicateOf           *string
	DuplicateSimilarity   *float64
}

// buildProcessedItemOutboxPayload is buildProcessedItemOutboxPayload.
func buildProcessedItemOutboxPayload(input processedItemOutboxInput) processedItemOutboxPayload {
	tags := buildTags(input.Payload, input.Cleaned)
	if tags == nil {
		tags = []string{}
	}
	document := processedItemOutboxDocument{
		ID:                    input.ProcessedItemID,
		RawItemID:             input.Raw.ID,
		ItemMetaID:            input.Raw.ItemMetaID,
		OrgID:                 input.OrgID,
		SourceID:              input.SourceID,
		Status:                "completed",
		Tags:                  tags,
		Result:                input.Cleaned,
		LLM:                   input.LLM,
		SummaryEmbeddingModel: input.SummaryEmbeddingModel,
		DuplicateOf:           input.DuplicateOf,
		DuplicateSimilarity:   input.DuplicateSimilarity,
	}
	if input.SummaryEmbedding != nil {
		summaryEmbedding := input.SummaryEmbedding
		document.SummaryEmbedding = &summaryEmbedding
	}
	return processedItemOutboxPayload{Type: "processed_item", Document: document}
}

// pipelinePendingProcessedItemDocument is the document the BullMQ job returns:
// the pending processed item projection spread with its id. The persisted form
// of the item is written later by the delivery owner.
func pipelinePendingProcessedItemDocument(processedItemID string) json.RawMessage {
	encoded, err := json.Marshal(struct {
		ID     string `json:"_id"`
		ItemID string `json:"id"`
	}{ID: processedItemID, ItemID: processedItemID})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

// buildMongoOutboxInsertQuery is the MongoOutbox INSERT of the persist
// transaction. The row mirrors the Prisma create: org-scoped, processed_item
// type, pending status, zero attempts, available now.
func buildMongoOutboxInsertQuery(outboxID, orgID string, payload []byte, now time.Time) (string, []any) {
	query := "INSERT INTO `MongoOutbox` (`id`,`orgId`,`type`,`payload`,`status`,`attempts`,`lastError`,`availableAt`,`lockedAt`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
	args := []any{
		outboxID,
		orgID,
		"processed_item",
		string(payload),
		"pending",
		0,
		nil,
		now.UTC().Truncate(time.Millisecond),
		nil,
		now.UTC().Truncate(time.Millisecond),
		now.UTC().Truncate(time.Millisecond),
	}
	return query, args
}

// pipelineDeliveryTimeout bounds one immediate delivery attempt. The NestJS
// flush has no explicit timeout (the Prisma calls time out individually); the
// scanner compensates either way.
const pipelineDeliveryTimeout = 2 * time.Minute

// dispatchOutboxDelivery schedules the immediate delivery of one committed
// outbox row, bounded by pipeline.outboxDeliveryConcurrency. It never blocks the
// pipeline and never changes its result.
func (s *Service) dispatchOutboxDelivery(outboxID string) {
	if s.outbox == nil || outboxID == "" {
		return
	}
	s.asyncWG.Add(1)
	go func() {
		defer s.asyncWG.Done()
		if s.deliverySlots != nil {
			s.deliverySlots <- struct{}{}
			defer func() { <-s.deliverySlots }()
		}
		ctx, cancel := context.WithTimeout(context.Background(), pipelineDeliveryTimeout)
		defer cancel()
		if delivered := s.outbox.DeliverNow(ctx, outboxID); !delivered {
			s.logf("immediate processed_item outbox delivery failed; #116 scanner will retry: outboxId=%s", outboxID)
		}
	}()
}

// dispatchSnapshotRefresh mirrors createOutboxEntry's fire-and-forget
// refreshSnapshotForSource call: only a job-level sourceId triggers it, and a
// failure is swallowed.
func (s *Service) dispatchSnapshotRefresh(orgID string, sourceID *string) {
	if s.snapshots == nil || sourceID == nil || *sourceID == "" {
		return
	}
	s.asyncWG.Add(1)
	go func() {
		defer s.asyncWG.Done()
		ctx, cancel := context.WithTimeout(context.Background(), pipelineDeliveryTimeout)
		defer cancel()
		if err := s.snapshots.RefreshNewsSourceSnapshot(ctx, orgID, *sourceID); err != nil {
			s.logf("failed to refresh news source ops snapshot for sourceId %s: %v", *sourceID, err)
		}
	}()
}

// waitAsync blocks until every immediate-delivery and snapshot goroutine this
// service started has finished. It exists for tests and graceful shutdown; the
// pipeline path never calls it.
func (s *Service) waitAsync() {
	s.asyncWG.Wait()
}
