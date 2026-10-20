package itemsingest

import (
	"context"
	"database/sql"
)

// This file exposes the two raw_item outbox primitives the news-source RSS seed
// path needs. The scheduler creates PipelineJob + ItemMeta + the outbox row in
// one MySQL transaction and then asks the outbox service to write the Mongo
// document and enqueue the item pipeline job, exactly like
// RawItemOutboxService.enqueueWrite + deliverNow. Keeping the envelope format in
// this package is deliberate: the MongoOutbox payload is one contract shared by
// every producer.

// OutboxWrite is the enqueueWrite input.
type OutboxWrite struct {
	OrgID         string
	ItemMetaID    string
	RawItemID     string
	Source        string
	Payload       NormalizedNewsPayload
	PipelineJobID *string
	SourceID      *string
	Priority      *int64
}

// WriteRawItemOutboxTx writes one pending raw_item outbox row inside the
// caller's transaction and returns the row id.
func WriteRawItemOutboxTx(ctx context.Context, tx *sql.Tx, write OutboxWrite) (string, error) {
	return insertOutboxTx(ctx, tx, OutboxPayload{
		Type:          "raw_item",
		OrgID:         write.OrgID,
		ItemMetaID:    write.ItemMetaID,
		RawItemID:     write.RawItemID,
		Source:        write.Source,
		Payload:       write.Payload,
		PipelineJobID: write.PipelineJobID,
		SourceID:      write.SourceID,
		Priority:      write.Priority,
	})
}

// DeliverOutboxNow is RawItemOutboxService.deliverNow: parse, claim, write the
// raw document, enqueue the item pipeline job and delete the row. A false
// return means the delivery was deferred to the replay owner.
func (s *Service) DeliverOutboxNow(ctx context.Context, outboxID string) bool {
	if s == nil || s.store == nil {
		return false
	}
	return s.deliverNow(ctx, outboxID)
}
