package newseventsingest

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

// assignmentMethod is the NewsEventItem.assignedBy value.
type assignmentMethod string

const (
	// assignmentMethodOverlap is NewsEventAssignmentMethod.overlap.
	assignmentMethodOverlap assignmentMethod = "overlap"
	// assignmentMethodVector is NewsEventAssignmentMethod.vector.
	assignmentMethodVector assignmentMethod = "vector"
	// assignmentMethodManual is NewsEventAssignmentMethod.manual.
	assignmentMethodManual assignmentMethod = "manual"
)

// dayMillis is DAY_MS.
const dayMillis int64 = 24 * 60 * 60 * 1000

// AssignResult is the {eventId, created} pair every assign function returns.
// EventID may be empty only for the internal "no candidate" assignment value.
type AssignResult struct {
	EventID string
	Created bool
}

// VectorSearchMatch is one vector-go search hit.
type VectorSearchMatch struct {
	ProcessedItemID string
	Score           float64
}

// VectorSearchRequest is the POST /v1/search body of @modular/vector-client.
type VectorSearchRequest struct {
	OrgID          string
	EmbeddingModel string
	Vector         []float64
	Limit          int
	MinScore       float64
	LookbackMs     int64
}

// VectorSearcher is the best-effort vector retrieval port. The second result is
// false when the service is unavailable, which the caller treats as an empty
// match list (the NestJS `matches ?? []`).
type VectorSearcher interface {
	SearchBestEffort(ctx context.Context, request VectorSearchRequest) ([]VectorSearchMatch, bool)
}

// derivedSignal is the per-assignment derivation both pickers consume.
type derivedSignal struct {
	Timestamp     time.Time
	Language      *string
	PrimaryTopic  string
	PrimaryEntity string
}

// assignment is one picker result. EventID is empty when no candidate matched,
// which makes createEvent run.
type assignment struct {
	EventID    string
	Similarity *float64
	Method     assignmentMethod
}

// scoredEvent is one candidate with its gated score.
type scoredEvent struct {
	EventID string
	Score   float64
}

// assigner owns the assignment path. leaves is the O1 batch prefetch: the
// ProcessedItem leaves of the current ingestion batch, keyed by the trimmed
// cleanedMarkdownRef. An empty map means "no processed item data this round",
// which is also what a failed prefetch produces — never a second read.
type assigner struct {
	store   *store
	model   ModelServiceClient
	vectors VectorSearcher
	leaves  map[string]processedItemLeaf
	now     func() time.Time
}

// clock returns the current time with millisecond precision.
func (a *assigner) clock() time.Time {
	if a.now != nil {
		return a.now().UTC().Truncate(time.Millisecond)
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}

// summaryVectorOf resolves the summary embedding of one leaf, mirroring
// tryResolveSummaryEmbedding. A nil result means "no vector": the item is
// missing, the array is empty or non-numeric, or the model name is blank.
func (a *assigner) summaryVectorOf(processedItemID *string) *summaryVector {
	normalized := jsNormalizeOptionalString(processedItemID)
	if normalized == nil {
		return nil
	}
	leaf, found := a.leaves[*normalized]
	if !found {
		return nil
	}
	return leaf.summaryVector()
}

// AssignNewsSignalToEvent mirrors NewsEventsService.assignNewsSignalToEvent: the
// idempotency pre-check, the vector then overlap pickers with their category gate
// logs, and the assignment transaction with the in-transaction re-check.
func (a *assigner) AssignNewsSignalToEvent(ctx context.Context, orgID string, signal NewsSignal, settings Settings) (AssignResult, error) {
	existingEventID, found, err := a.store.findNewsEventItem(ctx, orgID, signal.ProcessedArticleID)
	if err != nil {
		return AssignResult{}, err
	}
	if found {
		return AssignResult{EventID: existingEventID, Created: false}, nil
	}

	now := a.clock()
	timestamp := clampFutureTimestamp(signal.Timestamp, now)
	derived := derivedSignal{
		Timestamp:     timestamp,
		Language:      jsNormalizeOptionalString(signal.Language),
		PrimaryTopic:  pickPrimaryTopic(signal.Topics),
		PrimaryEntity: pickPrimaryEntity(signal.Entities),
	}

	session := &assignmentSession{orgID: orgID, settings: settings}
	picked, pickErr := a.pickEventForSignal(ctx, orgID, signal, derived, session)
	// The NestJS finally block flushes the collected decisions whether the
	// pickers succeeded or not.
	session.flushCategoryGateDecisionLogs(ctx, a.store, now)
	if pickErr != nil {
		return AssignResult{}, pickErr
	}
	return a.persistAssignment(ctx, orgID, signal, derived, picked)
}

// pickEventForSignal mirrors pickEventForSignal: the vector path first, then the
// overlap path, then the "create a new event" fallback.
func (a *assigner) pickEventForSignal(ctx context.Context, orgID string, signal NewsSignal, derived derivedSignal, session *assignmentSession) (assignment, error) {
	if vector := a.summaryVectorOf(signal.ProcessedItemID); vector != nil && a.vectors != nil {
		matches, _ := a.vectors.SearchBestEffort(ctx, VectorSearchRequest{
			OrgID:          orgID,
			EmbeddingModel: vector.Model,
			Vector:         vector.Embedding,
			Limit:          vectorSearchLimit,
			MinScore:       session.settings.VectorMinScore,
			LookbackMs:     int64(session.settings.LookbackDays) * dayMillis,
		})

		matchIDs := make([]string, 0, len(matches))
		for _, match := range matches {
			if match.ProcessedItemID == "" {
				continue
			}
			if signal.ProcessedItemID != nil && match.ProcessedItemID == *signal.ProcessedItemID {
				continue
			}
			matchIDs = append(matchIDs, match.ProcessedItemID)
		}

		if len(matchIDs) > 0 {
			memberships, err := a.store.listMemberships(ctx, orgID, matchIDs)
			if err != nil {
				return assignment{}, err
			}
			// Map insertion order matters: the first event id that reaches the
			// best-score loop wins a tie. The last membership row of a duplicated
			// processedItemId wins, exactly like `new Map(entries)`.
			membershipByProcessedItemID := make(map[string]string, len(memberships))
			for _, row := range memberships {
				normalized := jsNormalizeOptionalString(row.ProcessedItemID)
				if normalized == nil {
					continue
				}
				membershipByProcessedItemID[*normalized] = row.EventID
			}

			scores := newOrderedScores()
			for _, match := range matches {
				eventID, ok := membershipByProcessedItemID[match.ProcessedItemID]
				if !ok || eventID == "" {
					continue
				}
				scores.setIfHigher(eventID, match.Score)
			}

			if scores.len() > 0 {
				events, err := a.store.listActiveEventsByIDs(ctx, orgID, scores.keys)
				if err != nil {
					return assignment{}, err
				}
				best := scoreVectorCandidates(scores.keys, scores.values, events, signal, derived, session)
				if best != nil && best.Score >= session.settings.VectorMinScore {
					similarity := best.Score
					return assignment{EventID: best.EventID, Similarity: &similarity, Method: assignmentMethodVector}, nil
				}
			}
		}
	}

	overlap, err := a.pickEventByOverlap(ctx, orgID, signal, derived, session)
	if err != nil {
		return assignment{}, err
	}
	if overlap != nil {
		return *overlap, nil
	}
	return assignment{Method: assignmentMethodOverlap}, nil
}

// pickEventByOverlap mirrors pickEventByOverlap.
func (a *assigner) pickEventByOverlap(ctx context.Context, orgID string, signal NewsSignal, derived derivedSignal, session *assignmentSession) (*assignment, error) {
	candidates, err := a.pickOverlapCandidates(ctx, orgID, signal, derived, session)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	best := candidates[0]
	similarity := best.Score
	return &assignment{EventID: best.EventID, Similarity: &similarity, Method: assignmentMethodOverlap}, nil
}

// pickOverlapCandidates mirrors pickOverlapCandidates: the SQL candidates are
// re-checked case-sensitively in memory, scored, gated, then stably sorted by
// descending score.
//
// The NestJS comparator is `b.score - a.score`. A NaN score makes that
// comparator return NaN, which the specification treats as "equal", so a stable
// sort keeps the candidate order. Using `a.Score > b.Score` for
// sort.SliceStable has exactly the same effect for NaN.
func (a *assigner) pickOverlapCandidates(ctx context.Context, orgID string, signal NewsSignal, derived derivedSignal, session *assignmentSession) ([]scoredEvent, error) {
	if derived.PrimaryTopic == "" && derived.PrimaryEntity == "" {
		return nil, nil
	}
	since := a.clock().Add(-time.Duration(session.settings.LookbackDays) * 24 * time.Hour)
	candidates, err := a.store.listOverlapCandidates(ctx, orgID, since, derived.PrimaryTopic, derived.PrimaryEntity)
	if err != nil {
		return nil, err
	}

	scored := scoreOverlapCandidates(candidates, signal, derived, session)
	sortScoredEvents(scored)
	return scored, nil
}

// scoreVectorCandidates walks the scored event ids in insertion order, applies
// the language penalty and the category gate, and keeps the strictly best
// gated score. The first event id wins a tie, which is why the caller passes
// the ordered keys of the Map the NestJS code iterates.
func scoreVectorCandidates(orderedEventIDs []string, rawScores map[string]float64, events map[string]eventRecord, signal NewsSignal, derived derivedSignal, session *assignmentSession) *scoredEvent {
	var best *scoredEvent
	for _, eventID := range orderedEventIDs {
		event, ok := events[eventID]
		if !ok {
			continue
		}
		adjusted := applyLanguagePenalty(rawScores[eventID], derived.Language, event.Language, session.settings)
		categoryAdjusted, accepted := session.applyCategoryGate(adjusted, signal, event.MetadataJSON)
		if !accepted {
			continue
		}
		if best == nil || categoryAdjusted > best.Score {
			best = &scoredEvent{EventID: eventID, Score: categoryAdjusted}
		}
	}
	return best
}

// scoreOverlapCandidates re-checks the SQL candidates case-sensitively, scores
// them by matching fields, and applies the language penalty and the category
// gate in that order.
func scoreOverlapCandidates(candidates []eventRecord, signal NewsSignal, derived derivedSignal, session *assignmentSession) []scoredEvent {
	scored := make([]scoredEvent, 0, len(candidates))
	for _, candidate := range candidates {
		topicMatch := derived.PrimaryTopic != "" && candidate.PrimaryTopic != nil && *candidate.PrimaryTopic == derived.PrimaryTopic
		entityMatch := derived.PrimaryEntity != "" && candidate.PrimaryEntity != nil && *candidate.PrimaryEntity == derived.PrimaryEntity
		matches := 0
		if topicMatch {
			matches++
		}
		if entityMatch {
			matches++
		}
		if matches <= 0 {
			continue
		}

		// A topic and an entity match weigh half each, so a double match scores
		// 1.0 and a single match 0.5 before the penalties.
		score := float64(matches) / 2
		score = applyLanguagePenalty(score, derived.Language, candidate.Language, session.settings)
		categoryAdjusted, accepted := session.applyCategoryGate(score, signal, candidate.MetadataJSON)
		if !accepted {
			continue
		}
		scored = append(scored, scoredEvent{EventID: candidate.ID, Score: categoryAdjusted})
	}
	return scored
}

// sortScoredEvents is the stable descending sort. The NestJS comparator is
// `b.score - a.score`; a NaN score makes that comparator return NaN, which the
// specification treats as "equal", so a stable sort keeps the candidate order.
// Sorting on `a.Score > b.Score` has exactly the same effect for NaN.
func sortScoredEvents(scored []scoredEvent) {
	sort.SliceStable(scored, func(left, right int) bool { return scored[left].Score > scored[right].Score })
}

// persistAssignment mirrors the runInTransaction body of
// assignNewsSignalToEvent.
func (a *assigner) persistAssignment(ctx context.Context, orgID string, signal NewsSignal, derived derivedSignal, picked assignment) (AssignResult, error) {
	now := a.clock()
	tx, err := a.store.db.BeginTx(ctx, nil)
	if err != nil {
		return AssignResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// Re-check inside the transaction: a concurrent writer (the clustering
	// recovery worker, the LLM backfill worker or an operator backfill) may have
	// assigned this article between the pre-check and here. Without it, creating
	// a fresh event for an already-assigned article would commit an empty
	// "orphan" event and return the wrong eventId.
	if racedEventID, found, err := findNewsEventItemTx(ctx, tx, orgID, signal.ProcessedArticleID); err != nil {
		return AssignResult{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return AssignResult{}, err
		}
		committed = true
		return AssignResult{EventID: racedEventID, Created: false}, nil
	}

	eventID := picked.EventID
	if eventID == "" {
		created, err := createEventTx(ctx, tx, orgID, signal, derived, now)
		if err != nil {
			return AssignResult{}, err
		}
		eventID = created
	}

	itemID, err := newPrismaID()
	if err != nil {
		return AssignResult{}, err
	}
	item := newsEventItemInsert{
		ID:                 itemID,
		OrgID:              orgID,
		EventID:            eventID,
		ProcessedArticleID: signal.ProcessedArticleID,
		ProcessedItemID:    jsNormalizeOptionalString(signal.ProcessedItemID),
		Similarity:         picked.Similarity,
		AssignedBy:         string(picked.Method),
		CreatedAt:          now,
	}
	if err := insertNewsEventItemTx(ctx, tx, item); err != nil {
		if isDuplicateEntry(err) {
			// Lost the race: resolve the ACTUAL event that holds the article (the
			// winner's event), never the one created in this transaction.
			winner, found, lookupErr := findNewsEventItemTx(ctx, tx, orgID, signal.ProcessedArticleID)
			if lookupErr != nil {
				return AssignResult{}, lookupErr
			}
			if err := tx.Commit(); err != nil {
				return AssignResult{}, err
			}
			committed = true
			winnerID := eventID
			if found {
				winnerID = winner
			}
			return AssignResult{EventID: winnerID, Created: false}, nil
		}
		return AssignResult{}, err
	}

	if picked.EventID != "" {
		startAt, lastAt, err := loadEventWindowTx(ctx, tx, eventID)
		if err != nil {
			if !errors.Is(err, errNoNewsEvent) {
				return AssignResult{}, err
			}
			startAt, lastAt = derived.Timestamp, derived.Timestamp
		}
		newStart := minTime(clampFutureTimestamp(startAt, now), derived.Timestamp)
		newLast := maxTime(clampFutureTimestamp(lastAt, now), derived.Timestamp)
		if err := updateEventWindowTx(ctx, tx, eventID, newStart, newLast, now); err != nil {
			return AssignResult{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return AssignResult{}, err
	}
	committed = true
	return AssignResult{EventID: eventID, Created: true}, nil
}

// createEventTx mirrors createEvent: one active event whose window starts at the
// signal timestamp, with metadata.classification only when the signal carries a
// recognized category.
func createEventTx(ctx context.Context, tx *sql.Tx, orgID string, signal NewsSignal, derived derivedSignal, now time.Time) (string, error) {
	eventID, err := newPrismaID()
	if err != nil {
		return "", err
	}
	event := newsEventInsert{
		ID:                               eventID,
		OrgID:                            orgID,
		Language:                         derived.Language,
		PrimaryTopic:                     stringPointerOrNil(derived.PrimaryTopic),
		PrimaryEntity:                    stringPointerOrNil(derived.PrimaryEntity),
		Title:                            signal.Title,
		Summary:                          signal.Summary,
		StartAt:                          derived.Timestamp,
		LastAt:                           derived.Timestamp,
		RepresentativeProcessedArticleID: signal.ProcessedArticleID,
		RepresentativeProcessedItemID:    jsNormalizeOptionalString(signal.ProcessedItemID),
		MetadataJSON:                     buildClassificationMetadata(signal),
		CreatedAt:                        now,
		UpdatedAt:                        now,
	}
	if err := insertNewsEventTx(ctx, tx, event); err != nil {
		return "", err
	}
	return eventID, nil
}

// AssignNewsSignalToSpecificEvent mirrors
// NewsEventsService.assignNewsSignalToSpecificEvent: attach the article to the
// requested event and widen its window. Unlike the picker path, a duplicate
// (orgId, processedArticleId) returns the REQUESTED event id with created=false
// and does not resolve the winner.
func (a *assigner) AssignNewsSignalToSpecificEvent(ctx context.Context, orgID, eventID string, signal NewsSignal, similarity *float64, assignedBy assignmentMethod) (AssignResult, error) {
	existingEventID, found, err := a.store.findNewsEventItem(ctx, orgID, signal.ProcessedArticleID)
	if err != nil {
		return AssignResult{}, err
	}
	if found {
		return AssignResult{EventID: existingEventID, Created: false}, nil
	}

	now := a.clock()
	timestamp := clampFutureTimestamp(signal.Timestamp, now)
	tx, err := a.store.db.BeginTx(ctx, nil)
	if err != nil {
		return AssignResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	itemID, err := newPrismaID()
	if err != nil {
		return AssignResult{}, err
	}
	if assignedBy == "" {
		assignedBy = assignmentMethodManual
	}
	item := newsEventItemInsert{
		ID:                 itemID,
		OrgID:              orgID,
		EventID:            eventID,
		ProcessedArticleID: signal.ProcessedArticleID,
		ProcessedItemID:    jsNormalizeOptionalString(signal.ProcessedItemID),
		Similarity:         similarity,
		AssignedBy:         string(assignedBy),
		CreatedAt:          now,
	}
	if err := insertNewsEventItemTx(ctx, tx, item); err != nil {
		if isDuplicateEntry(err) {
			if err := tx.Commit(); err != nil {
				return AssignResult{}, err
			}
			committed = true
			return AssignResult{EventID: eventID, Created: false}, nil
		}
		return AssignResult{}, err
	}

	startAt, lastAt, err := loadEventWindowTx(ctx, tx, eventID)
	if err != nil {
		// The NewsEventItem insert has a foreign key to NewsEvent in production,
		// so a missing event fails earlier. Returning the error keeps the NestJS
		// behaviour for a schema without the constraint (Prisma update throws
		// P2025) instead of reporting a silent success.
		return AssignResult{}, err
	}
	newStart := minTime(clampFutureTimestamp(startAt, now), timestamp)
	newLast := maxTime(clampFutureTimestamp(lastAt, now), timestamp)
	if err := updateEventWindowTx(ctx, tx, eventID, newStart, newLast, now); err != nil {
		return AssignResult{}, err
	}

	if err := tx.Commit(); err != nil {
		return AssignResult{}, err
	}
	committed = true
	return AssignResult{EventID: eventID, Created: true}, nil
}

// AssignNewsSignalToSpecificEventWithSettings mirrors
// NewsEventsService.assignNewsSignalToSpecificEventWithSettings: resolve the
// target event, apply the language penalty and the category gate, and fall back
// to the full picker when the target is unusable or the gated score is below the
// vector floor.
func (a *assigner) AssignNewsSignalToSpecificEventWithSettings(ctx context.Context, orgID, eventID string, signal NewsSignal, settings Settings, similarity *float64, assignedBy assignmentMethod) (AssignResult, error) {
	normalizedEventID := jsNormalizeOptionalString(&eventID)
	if normalizedEventID == nil {
		return a.AssignNewsSignalToEvent(ctx, orgID, signal, settings)
	}

	now := a.clock()
	target, found, err := a.store.findActiveEvent(ctx, orgID, *normalizedEventID)
	if err != nil {
		return AssignResult{}, err
	}
	if !found {
		return a.AssignNewsSignalToEvent(ctx, orgID, signal, settings)
	}

	score := 0.0
	if similarity != nil && isFinite(*similarity) {
		score = *similarity
	}
	languageAdjusted := applyLanguagePenalty(score,
		jsNormalizeOptionalString(signal.Language),
		jsNormalizeOptionalString(target.Language),
		settings)
	session := &assignmentSession{orgID: orgID, settings: settings}
	categoryAdjusted, accepted := session.applyCategoryGate(languageAdjusted, signal, target.MetadataJSON)
	session.flushCategoryGateDecisionLogs(ctx, a.store, now)
	if !accepted || categoryAdjusted < settings.VectorMinScore {
		return a.AssignNewsSignalToEvent(ctx, orgID, signal, settings)
	}

	adjusted := categoryAdjusted
	return a.AssignNewsSignalToSpecificEvent(ctx, orgID, *normalizedEventID, signal, &adjusted, assignedBy)
}

// pickPrimaryTopic mirrors pickPrimaryTopic: the first non-blank topic.
func pickPrimaryTopic(topics []string) string {
	for _, topic := range topics {
		if normalized := jsTrim(topic); normalized != "" {
			return normalized
		}
	}
	return ""
}

// pickPrimaryEntity mirrors pickPrimaryEntity: the highest-confidence entity,
// with the first named entity as the fallback. Ties keep the first entity.
func pickPrimaryEntity(entities []NewsSignalEntity) string {
	fallback := ""
	bestName := ""
	bestConfidence := 0.0
	hasBest := false
	for _, entity := range entities {
		normalizedName := jsTrim(entity.Name)
		if normalizedName == "" {
			continue
		}
		if fallback == "" {
			fallback = normalizedName
		}
		if entity.Confidence == nil || !isFinite(*entity.Confidence) {
			continue
		}
		if !hasBest || *entity.Confidence > bestConfidence {
			bestName = normalizedName
			bestConfidence = *entity.Confidence
			hasBest = true
		}
	}
	if hasBest {
		return bestName
	}
	return fallback
}

// minTime returns the earlier of two timestamps.
func minTime(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}

// maxTime returns the later of two timestamps.
func maxTime(left, right time.Time) time.Time {
	if left.After(right) {
		return left
	}
	return right
}

// orderedScores is an insertion-ordered event id -> score map. Go maps have no
// iteration order, and the NestJS Map order decides which event wins a tie.
type orderedScores struct {
	keys   []string
	values map[string]float64
}

// newOrderedScores builds an empty ordered score map.
func newOrderedScores() *orderedScores {
	return &orderedScores{values: make(map[string]float64)}
}

// setIfHigher stores a strictly higher score, keeping the first event id that
// reached it.
func (s *orderedScores) setIfHigher(eventID string, score float64) {
	if existing, ok := s.values[eventID]; ok {
		if score > existing {
			s.values[eventID] = score
		}
		return
	}
	s.keys = append(s.keys, eventID)
	s.values[eventID] = score
}

// len reports the number of scored events.
func (s *orderedScores) len() int {
	return len(s.keys)
}
