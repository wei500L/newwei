package itemsingest

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"math/rand"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

const (
	outboxStaleLockWindow = 5 * time.Minute
	outboxBatchSize       = 50
	outboxMaxAttempts     = 10
	outboxRetryBaseDelay  = 30 * time.Second
	outboxBackoffCap      = 5
)

// deliverNow ports RawItemOutboxService.deliverNow. It never forces a row whose
// availableAt is still in the future; that decision belongs to the claim.
func (s *Service) deliverNow(ctx context.Context, outboxID string) bool {
	entry, err := s.store.getOutboxEntry(ctx, outboxID)
	if err != nil {
		log.Printf("itemsingest: read raw-item outbox failed outboxId=%s: %v", outboxID, err)
		return false
	}
	if entry == nil {
		return false
	}
	return s.deliverEntry(ctx, *entry)
}

// deliverEntry parses, claims and executes one outbox row.
func (s *Service) deliverEntry(ctx context.Context, entry OutboxEntry) bool {
	payload, parseErr := parseOutboxPayload(entry.Payload, entry.OrgID)
	if parseErr != nil || payload == nil {
		// An untrusted payload is dead-lettered and attempts is bumped, but no
		// reference compensation runs: the referenced ids are not credible.
		attempts := entry.Attempts + 1
		_ = s.store.markOutboxDead(ctx, entry.ID, attempts, "Invalid raw-item outbox payload", nil)
		return false
	}

	var claimed *OutboxEntry
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var claimErr error
		claimed, claimErr = s.store.claimOutboxTx(ctx, tx, entry)
		return claimErr
	})
	if err != nil {
		log.Printf("itemsingest: claim raw-item outbox failed outboxId=%s: %v", entry.ID, err)
		return false
	}
	if claimed == nil {
		return false
	}

	if err := s.writeRawItemFromPayload(ctx, *payload); err != nil {
		s.failOutboxEntry(ctx, entry.ID, *claimed, payload, err)
		return false
	}
	if err := s.applyRawItemPersisted(ctx, payload.OrgID, payload.ItemMetaID, payload.RawItemID, payload.PipelineJobID, payload.SourceID, payload.Priority); err != nil {
		s.failOutboxEntry(ctx, entry.ID, *claimed, payload, err)
		return false
	}
	if err := s.store.deleteOutbox(ctx, entry.ID); err != nil {
		// The raw document and queue job exist; keeping the row lets the
		// stale-processing recovery replay the idempotent steps.
		s.failOutboxEntry(ctx, entry.ID, *claimed, payload, err)
		return false
	}
	return true
}

// applyRawItemPersisted ports ItemsIngestService.applyRawItemPersisted: enqueue
// first, then hydrate. An "already exists" queue error is tolerated.
func (s *Service) applyRawItemPersisted(
	ctx context.Context,
	orgID, itemMetaID, rawItemID string,
	pipelineJobID, sourceID *string,
	priority *int64,
) error {
	if s.enqueuer == nil {
		return NewFailure(500, "itemPipeline producer is not configured")
	}
	_, err := s.enqueuer.EnqueueItem(ctx, orgID, itemMetaID, rawItemID, EnqueueOptions{
		Priority:      priority,
		TraceID:       httpx.TraceIDFromContext(ctx),
		PipelineJobID: pipelineJobID,
		SourceID:      sourceID,
	})
	if err != nil && !strings.Contains(err.Error(), "already exists") {
		return err
	}
	return s.hydrate(ctx, orgID, itemMetaID)
}

func (s *Service) writeRawItemFromPayload(ctx context.Context, payload OutboxPayload) error {
	doc, err := newRawItemDocument(payload.ItemMetaID, payload.RawItemID, payload.Source, payload.Payload, s.now())
	if err != nil {
		return err
	}
	return s.insertRawItem(ctx, doc)
}

func (s *Service) failOutboxEntry(ctx context.Context, outboxID string, claimed OutboxEntry, payload *OutboxPayload, err error) {
	attempts := claimed.Attempts
	if attempts < 1 {
		attempts = 1
	}
	message := err.Error()
	if attempts >= outboxMaxAttempts {
		if markErr := s.store.markOutboxDead(ctx, outboxID, attempts, message, payload); markErr != nil {
			log.Printf("itemsingest: mark raw-item outbox dead failed outboxId=%s: %v", outboxID, markErr)
		}
		return
	}
	delay := s.backoffDelay(attempts)
	availableAt := s.now().UTC().Add(delay)
	if updateErr := s.store.markOutboxFailure(ctx, outboxID, attempts, message, availableAt); updateErr != nil {
		log.Printf("itemsingest: write raw-item outbox failure state failed outboxId=%s: %v", outboxID, updateErr)
	}
}

// backoffDelay ports computeBackoffDelay:
// round(30000 * 2^(min(attempt,5)-1) * (0.5 + random)).
func (s *Service) backoffDelay(attempt int) time.Duration {
	exponent := math.Min(float64(attempt), outboxBackoffCap)
	if exponent < 1 {
		exponent = 1
	}
	exponential := float64(outboxRetryBaseDelay) * math.Pow(2, exponent-1)
	jitter := 0.5 + rand.Float64()
	return time.Duration(math.Round(exponential * jitter))
}

// deliverPendingForItemMeta targets one item directly. The store filters on the
// JSON payload's itemMetaId before the 50-row cut, so unrelated items cannot
// hide this item's pending rows.
func (s *Service) deliverPendingForItemMeta(ctx context.Context, orgID, itemMetaID string) {
	entries, err := s.store.listOutboxForItemMeta(ctx, orgID, itemMetaID)
	if err != nil {
		log.Printf("itemsingest: list raw-item outbox for item failed orgId=%s itemMetaId=%s: %v", orgID, itemMetaID, err)
		return
	}
	for _, entry := range entries {
		payload, err := parseOutboxPayload(entry.Payload, entry.OrgID)
		if err != nil || payload == nil || payload.ItemMetaID != itemMetaID {
			// NestJS skips invalid rows here instead of dead-lettering them.
			continue
		}
		s.deliverEntry(ctx, entry)
	}
}

// retryPendingOutbox is the per-minute owner body.
func (s *Service) retryPendingOutbox(ctx context.Context) {
	entries, err := s.store.listRetryEntries(ctx)
	if err != nil {
		log.Printf("itemsingest: raw-item outbox retry scan failed: %v", err)
		return
	}
	for _, entry := range entries {
		if ctx.Err() != nil {
			return
		}
		s.deliverEntry(ctx, entry)
	}
}

// parseOutboxPayload validates the raw_item envelope. The payload.orgId must
// equal the row orgId; a mismatch is invalid like any schema failure.
func parseOutboxPayload(raw []byte, rowOrgID string) (*OutboxPayload, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, errors.New("empty payload")
	}
	var envelope struct {
		Type          string          `json:"type"`
		OrgID         string          `json:"orgId"`
		ItemMetaID    string          `json:"itemMetaId"`
		RawItemID     string          `json:"rawItemId"`
		Source        string          `json:"source"`
		Payload       json.RawMessage `json:"payload"`
		PipelineJobID *string         `json:"pipelineJobId"`
		SourceID      *string         `json:"sourceId"`
		Priority      *json.Number    `json:"priority"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&envelope); err != nil {
		return nil, err
	}
	if envelope.Type != "raw_item" {
		return nil, errors.New("unexpected outbox type")
	}
	orgID := strings.TrimSpace(envelope.OrgID)
	if orgID == "" || orgID != rowOrgID {
		return nil, errors.New("outbox org mismatch")
	}
	itemMetaID := strings.TrimSpace(envelope.ItemMetaID)
	rawItemID := strings.TrimSpace(envelope.RawItemID)
	source := strings.TrimSpace(envelope.Source)
	if itemMetaID == "" || rawItemID == "" || source == "" {
		return nil, errors.New("missing outbox identity")
	}
	payload, err := NormalizeNewsPayload(envelope.Payload)
	if err != nil {
		return nil, err
	}
	var pipelineJobID *string
	if envelope.PipelineJobID != nil {
		value := strings.TrimSpace(*envelope.PipelineJobID)
		if value == "" {
			return nil, errors.New("empty pipelineJobId")
		}
		pipelineJobID = &value
	}
	var sourceID *string
	if envelope.SourceID != nil {
		value := strings.TrimSpace(*envelope.SourceID)
		if value == "" {
			return nil, errors.New("empty sourceId")
		}
		sourceID = &value
	}
	var priority *int64
	if envelope.Priority != nil {
		number, err := envelope.Priority.Float64()
		if err != nil || number != math.Trunc(number) {
			return nil, errors.New("priority must be an integer")
		}
		value := int64(number)
		priority = &value
	}
	return &OutboxPayload{
		Type:          "raw_item",
		OrgID:         orgID,
		ItemMetaID:    itemMetaID,
		RawItemID:     rawItemID,
		Source:        source,
		Payload:       payload,
		PipelineJobID: pipelineJobID,
		SourceID:      sourceID,
		Priority:      priority,
	}, nil
}
