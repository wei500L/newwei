package itempipeline

// Status writes for one item attempt. Every method ports QueueProcessor's
// private helpers with the same failure containment: the worker must never fail
// a job because a status write failed, so each write is warn-only.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Item status values (common/pipeline-status.ts).
const (
	itemStatusProcessing = "processing"
	itemStatusFailed     = "failed"
	itemStatusDuplicate  = "Duplicate"
)

// PipelineJobStatus values (Prisma enum).
const (
	pipelineStatusRunning   = "running"
	pipelineStatusCompleted = "completed"
	pipelineStatusFailed    = "failed"
	pipelineStatusDelayed   = "delayed"
)

const (
	processedItemsCollection = "processeditems"
	itemReadModelsCollection = "itemreadmodels"
	rawItemsCollection       = "rawitems"
)

// processingState is the markProcessingState input.
type processingState struct {
	ItemMetaID      string
	RawItemID       string
	OrgID           string
	ProcessedItemID string
	PipelineJobID   *string
	SourceID        *string
}

// successState is the markSuccessState input.
type successState struct {
	ItemMetaID    string
	OrgID         string
	PipelineJobID *string
	SourceID      *string
}

// failureState is the markFailureState input.
type failureState struct {
	ItemMetaID      string
	RawItemID       string
	OrgID           string
	ProcessedItemID string
	PipelineJobID   *string
	SourceID        *string
	Error           error
	AttemptsMade    int
	FinalFailure    bool
}

// updateItemMetaStatus is updateItemMetaStatus.
func (p *Processor) updateItemMetaStatus(ctx context.Context, itemMetaID, status string, skipIfDuplicate bool) {
	if p == nil || p.db == nil || itemMetaID == "" {
		return
	}
	now := msTime(p.now())
	var err error
	if skipIfDuplicate {
		_, err = p.db.ExecContext(ctx,
			"UPDATE `ItemMeta` SET status = ?, updatedAt = ? WHERE id = ? AND status <> ?",
			status, now, itemMetaID, itemStatusDuplicate)
	} else {
		_, err = p.db.ExecContext(ctx,
			"UPDATE `ItemMeta` SET status = ?, updatedAt = ? WHERE id = ?",
			status, now, itemMetaID)
	}
	if err != nil {
		log.Printf("itempipeline: failed to update item meta status itemMetaId=%s status=%s: %v", itemMetaID, status, err)
	}
}

// processedItemUpdate is the $set/$unset/$setOnInsert field set.
type processedItemUpdate struct {
	ProcessedItemID string
	RawItemID       string
	ItemMetaID      string
	OrgID           string
	Status          string
	Error           *sanitizedError
}

// upsertProcessedItemStatus is upsertProcessedItemStatus.
func (p *Processor) upsertProcessedItemStatus(ctx context.Context, update processedItemUpdate) {
	if p == nil || p.mongo == nil {
		return
	}
	processedID, okProcessed := objectIDFromJSValue(update.ProcessedItemID)
	rawID, okRaw := objectIDFromJSValue(update.RawItemID)
	if !okProcessed || !okRaw {
		log.Printf("itempipeline: skipped processed item upsert due to invalid object id processedItemId=%s rawItemId=%s",
			update.ProcessedItemID, update.RawItemID)
		return
	}
	now := msTime(p.now())
	set := bson.D{
		{Key: "rawItemId", Value: rawID},
		{Key: "itemMetaId", Value: update.ItemMetaID},
		{Key: "orgId", Value: update.OrgID},
		{Key: "status", Value: update.Status},
		{Key: "updatedAt", Value: now},
	}
	if update.Error != nil {
		set = append(set, bson.E{Key: "error", Value: *update.Error})
	}
	unset := bson.D{
		{Key: "hasLocation", Value: ""},
		{Key: "result", Value: ""},
		{Key: "duplicateOf", Value: ""},
		{Key: "duplicateSimilarity", Value: ""},
		{Key: "summaryEmbedding", Value: ""},
		{Key: "summaryEmbeddingModel", Value: ""},
		{Key: "summaryEmbeddingDimensions", Value: ""},
	}
	if update.Error == nil {
		unset = append(unset, bson.E{Key: "error", Value: ""})
	}
	setOnInsert := bson.D{
		{Key: "_id", Value: processedID},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
		{Key: "ingestedAt", Value: now},
		{Key: "sortAt", Value: now},
		{Key: "tags", Value: bson.A{}},
	}
	_, err := p.mongo.Collection(processedItemsCollection).UpdateOne(ctx,
		bson.D{{Key: "_id", Value: processedID}},
		bson.D{
			{Key: "$set", Value: set},
			{Key: "$unset", Value: unset},
			{Key: "$setOnInsert", Value: setOnInsert},
		},
		options.Update().SetUpsert(true),
	)
	if err != nil {
		log.Printf("itempipeline: failed to upsert processed item processedItemId=%s status=%s: %v",
			update.ProcessedItemID, update.Status, err)
	}
}

// markProcessingState is markProcessingState: ItemMeta Processing (skipping
// Duplicate), ProcessedItem processing, PipelineJob running, NewsSource
// lastRunAt, then the ops snapshot refresh.
func (p *Processor) markProcessingState(ctx context.Context, state processingState) {
	now := msTime(p.now())
	p.updateItemMetaStatus(ctx, state.ItemMetaID, itemStatusProcessing, true)
	p.upsertProcessedItemStatus(ctx, processedItemUpdate{
		ProcessedItemID: state.ProcessedItemID,
		RawItemID:       state.RawItemID,
		ItemMetaID:      state.ItemMetaID,
		OrgID:           state.OrgID,
		Status:          itemStatusProcessing,
	})
	if p.db != nil && state.PipelineJobID != nil && *state.PipelineJobID != "" {
		if _, err := p.db.ExecContext(ctx,
			"UPDATE `PipelineJob` SET status = ?, startedAt = ?, error = NULL, updatedAt = ? WHERE id = ?",
			pipelineStatusRunning, now, now, *state.PipelineJobID); err != nil {
			log.Printf("itempipeline: failed to mark pipeline job running id=%s: %v", *state.PipelineJobID, err)
		}
	}
	if p.db != nil && state.SourceID != nil && *state.SourceID != "" {
		if _, err := p.db.ExecContext(ctx,
			"UPDATE `NewsSource` SET lastRunAt = ?, updatedAt = ? WHERE id = ?",
			now, now, *state.SourceID); err != nil {
			log.Printf("itempipeline: failed to update news source lastRunAt id=%s: %v", *state.SourceID, err)
		}
	}
	p.refreshSnapshot(ctx, state.OrgID, state.SourceID)
}

// markSuccessState is markSuccessState: PipelineJob completed, NewsSource
// success reset, then the ops snapshot refresh.
func (p *Processor) markSuccessState(ctx context.Context, state successState) {
	now := msTime(p.now())
	if p.db != nil && state.PipelineJobID != nil && *state.PipelineJobID != "" {
		if _, err := p.db.ExecContext(ctx,
			"UPDATE `PipelineJob` SET status = ?, completedAt = ?, error = NULL, updatedAt = ? WHERE id = ?",
			pipelineStatusCompleted, now, now, *state.PipelineJobID); err != nil {
			log.Printf("itempipeline: failed to mark pipeline job completed id=%s: %v", *state.PipelineJobID, err)
		}
	}
	if p.db != nil && state.SourceID != nil && *state.SourceID != "" {
		if _, err := p.db.ExecContext(ctx,
			"UPDATE `NewsSource` SET lastSuccessAt = ?, consecutiveFailures = 0, circuitOpenUntil = NULL, updatedAt = ? WHERE id = ?",
			now, now, *state.SourceID); err != nil {
			log.Printf("itempipeline: failed to update news source success id=%s: %v", *state.SourceID, err)
		}
	}
	p.refreshSnapshot(ctx, state.OrgID, state.SourceID)
}

// markFailureState is markFailureState. ItemMeta/read model/source failure are
// final-failure only; ProcessedItem and PipelineJob update on every failure.
func (p *Processor) markFailureState(ctx context.Context, state failureState) {
	now := msTime(p.now())
	sanitized := sanitizeError(state.Error)
	if state.ItemMetaID != "" && state.FinalFailure {
		p.updateItemMetaStatus(ctx, state.ItemMetaID, itemStatusFailed, true)
	}
	if state.ProcessedItemID != "" && state.RawItemID != "" && state.ItemMetaID != "" {
		p.upsertProcessedItemStatus(ctx, processedItemUpdate{
			ProcessedItemID: state.ProcessedItemID,
			RawItemID:       state.RawItemID,
			ItemMetaID:      state.ItemMetaID,
			OrgID:           state.OrgID,
			Status:          itemStatusFailed,
			Error:           &sanitized,
		})
	}
	if p.db != nil && state.PipelineJobID != nil && *state.PipelineJobID != "" {
		status := pipelineStatusDelayed
		var completedAt any
		if state.FinalFailure {
			status = pipelineStatusFailed
			completedAt = now
		}
		attempts := state.AttemptsMade
		if attempts < 0 {
			attempts = 0
		}
		if _, err := p.db.ExecContext(ctx,
			"UPDATE `PipelineJob` SET status = ?, completedAt = ?, error = ?, attempts = ?, updatedAt = ? WHERE id = ?",
			status, completedAt, sanitized.Message, attempts, now, *state.PipelineJobID); err != nil {
			log.Printf("itempipeline: failed to mark pipeline job failure id=%s: %v", *state.PipelineJobID, err)
		}
	}
	if state.FinalFailure && state.ItemMetaID != "" && p.mongo != nil {
		var errorName any
		if sanitized.Name != nil {
			errorName = *sanitized.Name
		}
		_, err := p.mongo.Collection(itemReadModelsCollection).UpdateOne(ctx,
			bson.D{
				{Key: "orgId", Value: state.OrgID},
				{Key: "itemMetaId", Value: state.ItemMetaID},
			},
			bson.D{{Key: "$set", Value: bson.D{
				{Key: "status", Value: itemStatusFailed},
				{Key: "processed.status", Value: itemStatusFailed},
				{Key: "processed.error", Value: bson.D{
					{Key: "message", Value: sanitized.Message},
					{Key: "name", Value: errorName},
				}},
				{Key: "processed.updatedAt", Value: now},
				{Key: "updatedAt", Value: now},
			}}},
		)
		if err != nil {
			log.Printf("itempipeline: failed to sync read model failure itemMetaId=%s: %v", state.ItemMetaID, err)
		}
	}
	if state.SourceID != nil && *state.SourceID != "" && state.FinalFailure {
		p.markSourceFailureState(ctx, *state.SourceID, now)
	}
	p.refreshSnapshot(ctx, state.OrgID, state.SourceID)
}

// SourceFailureConfig is NewsSourceSchedulerConfig's failure/circuit block.
type SourceFailureConfig struct {
	CircuitBreakerThreshold   float64
	AutoDisableThreshold      float64
	FailureRecoveryDelayMs    int
	FailureMaxDelayMs         int
	CircuitBreakerBaseDelayMs int
	CircuitBreakerMaxDelayMs  int
}

// sourceFailureNotification is the data payload of the two system
// notifications, in NestJS member order.
type sourceFailureNotification struct {
	SourceID            string                   `json:"sourceId"`
	SourceName          string                   `json:"sourceName"`
	ConsecutiveFailures int                      `json:"consecutiveFailures"`
	CircuitOpenUntil    string                   `json:"circuitOpenUntil,omitempty"`
	Presentation        notificationPresentation `json:"presentation"`
}

// notificationPresentation is the presentation descriptor.
type notificationPresentation struct {
	Kind   string             `json:"kind"`
	Params notificationParams `json:"params"`
}

// notificationParams is the circuit/auto-disable params object. The
// circuitOpenUntil member is only present for the circuit-open notification.
type notificationParams struct {
	SourceID            string `json:"sourceId"`
	SourceName          string `json:"sourceName"`
	ConsecutiveFailures int    `json:"consecutiveFailures"`
	CircuitOpenUntil    string `json:"circuitOpenUntil,omitempty"`
}

// markSourceFailureState is markSourceFailureState: consecutiveFailures+1,
// jittered retry backoff, circuit breaker, auto-disable, nextRunAt and the two
// system notifications, inside one transaction.
func (p *Processor) markSourceFailureState(ctx context.Context, sourceID string, failureAt time.Time) {
	if p == nil || p.db == nil || sourceID == "" {
		return
	}
	cfg := p.sourceFailure
	threshold := int(math.Max(0, math.Floor(cfg.CircuitBreakerThreshold)))
	autoDisableThreshold := 0
	if !math.IsNaN(cfg.AutoDisableThreshold) && !math.IsInf(cfg.AutoDisableThreshold, 0) {
		autoDisableThreshold = int(math.Max(0, math.Floor(cfg.AutoDisableThreshold)))
	}
	var notifyCircuitOpen bool
	var notifyAutoDisable bool
	var circuitOpenUntil time.Time
	var sourceName string
	var sourceOrgID string

	err := p.withTx(ctx, func(tx *sql.Tx) error {
		var previousFailures int
		var isActive bool
		var orgID string
		var name string
		row := tx.QueryRowContext(ctx,
			"SELECT consecutiveFailures, isActive, orgId, name FROM `NewsSource` WHERE id = ?", sourceID)
		if err := row.Scan(&previousFailures, &isActive, &orgID, &name); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			return err
		}
		if !isActive {
			return nil
		}
		sourceOrgID = orgID
		consecutiveFailures := previousFailures + 1
		retryDelayMs := JitterBackoff(cfg.FailureRecoveryDelayMs, consecutiveFailures, cfg.FailureMaxDelayMs, p.random)
		retryAt := failureAt.Add(time.Duration(retryDelayMs) * time.Millisecond)
		var circuitUntil *time.Time
		if threshold > 0 && consecutiveFailures >= threshold {
			circuitAttempt := consecutiveFailures - threshold + 1
			circuitDelayMs := JitterBackoff(cfg.CircuitBreakerBaseDelayMs, circuitAttempt, cfg.CircuitBreakerMaxDelayMs, p.random)
			value := failureAt.Add(time.Duration(circuitDelayMs) * time.Millisecond)
			circuitUntil = &value
		}
		if threshold > 0 && consecutiveFailures == threshold && circuitUntil != nil {
			notifyCircuitOpen = true
			circuitOpenUntil = *circuitUntil
			sourceName = name
		}
		nextRunAt := retryAt
		if circuitUntil != nil && circuitUntil.After(retryAt) {
			nextRunAt = *circuitUntil
		}
		shouldDisable := autoDisableThreshold > 0 && consecutiveFailures >= autoDisableThreshold
		if shouldDisable && consecutiveFailures == autoDisableThreshold {
			notifyAutoDisable = true
			sourceName = name
		}
		var circuitValue any
		if circuitUntil != nil {
			circuitValue = msTime(*circuitUntil)
		}
		var nextRunValue any
		if !shouldDisable {
			nextRunValue = msTime(nextRunAt)
		}
		now := msTime(p.now())
		var updateErr error
		if shouldDisable {
			_, updateErr = tx.ExecContext(ctx,
				"UPDATE `NewsSource` SET lastFailureAt = ?, consecutiveFailures = ?, circuitOpenUntil = ?, nextRunAt = NULL, isActive = 0, updatedAt = ? WHERE id = ?",
				msTime(failureAt), consecutiveFailures, circuitValue, now, sourceID)
		} else {
			_, updateErr = tx.ExecContext(ctx,
				"UPDATE `NewsSource` SET lastFailureAt = ?, consecutiveFailures = ?, circuitOpenUntil = ?, nextRunAt = ?, updatedAt = ? WHERE id = ?",
				msTime(failureAt), consecutiveFailures, circuitValue, nextRunValue, now, sourceID)
		}
		return updateErr
	})
	if err != nil {
		log.Printf("itempipeline: failed to mark news source failure sourceId=%s: %v", sourceID, err)
		return
	}
	// Notifications are published only after the transaction committed, so a
	// rolled-back counter update never alerts. The row lock guarantees only the
	// transaction that crossed the threshold reaches these branches.
	if notifyCircuitOpen {
		p.notifyCircuitOpened(ctx, sourceOrgID, sourceID, sourceName, threshold, circuitOpenUntil)
	}
	if notifyAutoDisable {
		p.notifyAutoDisabled(ctx, sourceOrgID, sourceID, sourceName, autoDisableThreshold)
	}
}

func (p *Processor) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// circuitOpenNotification reproduces the QueueProcessor circuit-open system
// notification: title, body and data verbatim.
func circuitOpenNotification(sourceID, sourceName string, threshold int, until time.Time) (string, string, json.RawMessage) {
	untilISO := isoMillis(until)
	data, err := json.Marshal(sourceFailureNotification{
		SourceID:            sourceID,
		SourceName:          sourceName,
		ConsecutiveFailures: threshold,
		CircuitOpenUntil:    untilISO,
		Presentation: notificationPresentation{
			Kind: "news_source_circuit_opened",
			Params: notificationParams{
				SourceID:            sourceID,
				SourceName:          sourceName,
				ConsecutiveFailures: threshold,
				CircuitOpenUntil:    untilISO,
			},
		},
	})
	if err != nil {
		return "", "", nil
	}
	body := "News source \"" + sourceName + "\" reached " + itoa(threshold) +
		" consecutive failures and is paused until " + untilISO + "."
	return "News source circuit opened", body, data
}

// autoDisableNotification reproduces the QueueProcessor auto-disable system
// notification.
func autoDisableNotification(sourceID, sourceName string, failures int) (string, string, json.RawMessage) {
	data, err := json.Marshal(sourceFailureNotification{
		SourceID:            sourceID,
		SourceName:          sourceName,
		ConsecutiveFailures: failures,
		Presentation: notificationPresentation{
			Kind: "news_source_auto_disabled",
			Params: notificationParams{
				SourceID:            sourceID,
				SourceName:          sourceName,
				ConsecutiveFailures: failures,
			},
		},
	})
	if err != nil {
		return "", "", nil
	}
	body := "News source \"" + sourceName + "\" was disabled after " + itoa(failures) + " consecutive failures."
	return "News source disabled after failures", body, data
}

func (p *Processor) notifyCircuitOpened(ctx context.Context, orgID, sourceID, sourceName string, threshold int, until time.Time) {
	if p.notifier == nil {
		return
	}
	title, body, data := circuitOpenNotification(sourceID, sourceName, threshold, until)
	if data == nil {
		return
	}
	p.notifier.NotifySystem(ctx, orgID, title, body, data)
}

func (p *Processor) notifyAutoDisabled(ctx context.Context, orgID, sourceID, sourceName string, failures int) {
	if p.notifier == nil {
		return
	}
	title, body, data := autoDisableNotification(sourceID, sourceName, failures)
	if data == nil {
		return
	}
	p.notifier.NotifySystem(ctx, orgID, title, body, data)
}

func itoa(value int) string { return strconv.Itoa(value) }
