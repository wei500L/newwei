package archivepreparation

// This file exposes the status transitions the Go worker must write. It reuses
// writeStatus, so the key, JSON record, TTL, index score and 200-entry trim stay
// byte-identical to the producer's QUEUED record.

import "context"

// MarkProcessing writes the PROCESSING record.
func (p *Producer) MarkProcessing(ctx context.Context, payload Payload) error {
	return p.writeStatus(ctx, payload, "PROCESSING", "")
}

// MarkPartial writes the PARTIAL record.
func (p *Producer) MarkPartial(ctx context.Context, payload Payload) error {
	return p.writeStatus(ctx, payload, "PARTIAL", "")
}

// MarkReady writes the READY record.
func (p *Producer) MarkReady(ctx context.Context, payload Payload) error {
	return p.writeStatus(ctx, payload, "READY", "")
}

// MarkFailed writes the FAILED record with the worker's raw error message,
// exactly like ArchivePreparationProcessor's 'failed' handler.
func (p *Producer) MarkFailed(ctx context.Context, payload Payload, errorMessage string) error {
	return p.writeStatus(ctx, payload, "FAILED", errorMessage)
}
