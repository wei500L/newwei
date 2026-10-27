package newsnowclusteringops

import (
	"context"
	"time"
)

// newsEventAssignmentManual is the NewsEventAssignmentMethod.manual value the
// LLM backfill writes on every item, matching the NestJS
// NewsEventAssignmentMethod.manual argument.
const newsEventAssignmentManual = "manual"

// assignSignalToNewEvent mirrors NewsEventsService.assignNewsSignalToNewEvent:
// create one active event and attach the article to it. The
// (orgId, processedArticleId) unique key makes the operation idempotent; a
// raced transaction resolves the winner's event instead of the empty event it
// created.
func (s *Service) assignSignalToNewEvent(ctx context.Context, orgID string, signal newsSignal) (assignResult, error) {
	if existingEventID, found, err := s.clustering.findNewsEventItemEventID(ctx, orgID, signal.ProcessedArticleID); err != nil {
		return assignResult{}, err
	} else if found {
		return assignResult{EventID: existingEventID, Created: false}, nil
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	timestamp := clampFutureDate(signal.Timestamp, now)
	language := normalizeOptionalString(signal.Language)
	primaryTopic := pickPrimaryTopic(signal.Topics)
	primaryEntity := pickPrimaryEntity(signal.Entities)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return assignResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// Re-check inside the transaction: a concurrent writer may have assigned
	// this article between the pre-check and here.
	if racedEventID, found, err := findNewsEventItemEventIDTx(ctx, tx, orgID, signal.ProcessedArticleID); err != nil {
		return assignResult{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return assignResult{}, err
		}
		committed = true
		return assignResult{EventID: racedEventID, Created: false}, nil
	}

	eventID, err := newPrismaID()
	if err != nil {
		return assignResult{}, err
	}
	event := newsEventInsert{
		ID:                               eventID,
		OrgID:                            orgID,
		Language:                         language,
		PrimaryTopic:                     stringPointerOrNil(primaryTopic),
		PrimaryEntity:                    stringPointerOrNil(primaryEntity),
		Title:                            signal.Title,
		Summary:                          signal.Summary,
		StartAt:                          timestamp,
		LastAt:                           timestamp,
		RepresentativeProcessedArticleID: signal.ProcessedArticleID,
		RepresentativeProcessedItemID:    normalizeOptionalString(signal.ProcessedItemID),
		MetadataJSON:                     buildClassificationMetadata(signal),
		CreatedAt:                        now,
		UpdatedAt:                        now,
	}
	if err := insertNewsEventTx(ctx, tx, event); err != nil {
		return assignResult{}, err
	}

	itemID, err := newPrismaID()
	if err != nil {
		return assignResult{}, err
	}
	item := newsEventItemInsert{
		ID:                 itemID,
		OrgID:              orgID,
		EventID:            eventID,
		ProcessedArticleID: signal.ProcessedArticleID,
		ProcessedItemID:    normalizeOptionalString(signal.ProcessedItemID),
		Similarity:         nil,
		AssignedBy:         newsEventAssignmentManual,
		CreatedAt:          now,
	}
	if err := insertNewsEventItemTx(ctx, tx, item); err != nil {
		if isDuplicateEntry(err) {
			// Lost the race against a writer that committed the same
			// (orgId, processedArticleId) first. Roll this transaction back so the
			// event created above never lands — a committed active event with no
			// item is an empty duplicate in the console. The winner is resolved with
			// a read outside the transaction, because the snapshot of this
			// transaction predates the winner's commit.
			_ = tx.Rollback()
			// The transaction is finished; the deferred rollback must not run again.
			committed = true
			winner, found, lookupErr := s.clustering.findNewsEventItemEventID(ctx, orgID, signal.ProcessedArticleID)
			if lookupErr != nil {
				return assignResult{}, lookupErr
			}
			if !found {
				return assignResult{}, err
			}
			return assignResult{EventID: winner, Created: false}, nil
		}
		return assignResult{}, err
	}

	if err := tx.Commit(); err != nil {
		return assignResult{}, err
	}
	committed = true
	return assignResult{EventID: eventID, Created: true}, nil
}

// assignSignalToSpecificEvent mirrors
// NewsEventsService.assignNewsSignalToSpecificEvent: attach the article to an
// existing event with the candidate score and widen the event window. A
// duplicate (orgId, processedArticleId) returns the requested event id with
// created=false, exactly like the NestJS P2002 branch.
func (s *Service) assignSignalToSpecificEvent(ctx context.Context, orgID, eventID string, signal newsSignal, similarity *float64) (assignResult, error) {
	if existingEventID, found, err := s.clustering.findNewsEventItemEventID(ctx, orgID, signal.ProcessedArticleID); err != nil {
		return assignResult{}, err
	} else if found {
		return assignResult{EventID: existingEventID, Created: false}, nil
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	timestamp := clampFutureDate(signal.Timestamp, now)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return assignResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	itemID, err := newPrismaID()
	if err != nil {
		return assignResult{}, err
	}
	item := newsEventItemInsert{
		ID:                 itemID,
		OrgID:              orgID,
		EventID:            eventID,
		ProcessedArticleID: signal.ProcessedArticleID,
		ProcessedItemID:    normalizeOptionalString(signal.ProcessedItemID),
		Similarity:         similarity,
		AssignedBy:         newsEventAssignmentManual,
		CreatedAt:          now,
	}
	if err := insertNewsEventItemTx(ctx, tx, item); err != nil {
		if isDuplicateEntry(err) {
			if err := tx.Commit(); err != nil {
				return assignResult{}, err
			}
			committed = true
			return assignResult{EventID: eventID, Created: false}, nil
		}
		return assignResult{}, err
	}

	startAt, lastAt, err := loadEventWindowTx(ctx, tx, eventID)
	if err != nil {
		// Production has a foreign key from NewsEventItem to NewsEvent, so a
		// missing event fails the insert first. The explicit check keeps the
		// NestJS behaviour (Prisma update throws P2025) for a schema without
		// the constraint: the caller sees an error, never a silent success.
		return assignResult{}, err
	}
	newStart := minTime(clampFutureDate(startAt, now), timestamp)
	newLast := maxTime(clampFutureDate(lastAt, now), timestamp)
	if err := updateEventWindowTx(ctx, tx, eventID, newStart, newLast, now); err != nil {
		return assignResult{}, err
	}

	if err := tx.Commit(); err != nil {
		return assignResult{}, err
	}
	committed = true
	return assignResult{EventID: eventID, Created: true}, nil
}
