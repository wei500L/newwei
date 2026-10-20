package processeditemoutbox

// This file exposes the immediate delivery path to the item pipeline worker.
// The delivery body, the CAS claim and the compensation are unchanged: the
// worker calls DeliverNow right after the outbox-creating transaction commits
// (the NestJS NewsPipelineOutboxService event emitter branch), and a failed
// immediate delivery stays pending for this package's scheduled scanner.

import "context"

// DeliverNow delivers one pending outbox row immediately and reports whether it
// was delivered. It never panics and never claims a row owned by another
// executor: the shared conditional claim returns false in that case.
func (s *Service) DeliverNow(ctx context.Context, outboxID string) bool {
	if s == nil || outboxID == "" {
		return false
	}
	return s.deliverOne(ctx, outboxID)
}
