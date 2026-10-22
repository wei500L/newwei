package newsnowclusteringops

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

const (
	// msgFailureGroupNotFound is the 404 message of the clustering endpoints.
	msgFailureGroupNotFound = "News event clustering failure not found"
	// msgFailureGroupProcessing is the message reported when another recovery owns the group.
	msgFailureGroupProcessing = "Failure group is already processing"
	// msgFailureGroupUnrecoverable is returned for resolved and ignored groups.
	msgFailureGroupUnrecoverable = "Failure group can no longer be recovered"
)

// httpError is a typed failure carrying the HTTP status and message the handler
// must render.
type httpError struct {
	Status  int
	Message string
}

// Error implements the error interface.
func (e *httpError) Error() string {
	return e.Message
}

// newHTTPError builds a typed HTTP failure.
func newHTTPError(status int, message string) *httpError {
	return &httpError{Status: status, Message: message}
}

// httpStatusOf extracts the typed status of an error.
func httpStatusOf(err error) (int, string, bool) {
	var target *httpError
	if errors.As(err, &target) {
		return target.Status, target.Message, true
	}
	return 0, "", false
}

// mysqlDuplicateEntry is the MySQL error code for a unique constraint violation.
// Prisma reports the same condition as P2002.
const mysqlDuplicateEntry = 1062

// newsSignal is the local subset of NewsSignal consumed by the overlap matcher.
type newsSignal struct {
	ProcessedArticleID string
	ProcessedItemID    *string
	Timestamp          time.Time
	Language           *string
	Title              *string
	Summary            *string
	Topics             []string
	Entities           []clusteringFailureEntityDoc
	LegacyCategory     *string
	CategoryPath       *string
	CategoryConfidence *float64
}

// assignResult is the outcome of the local event assignment.
type assignResult struct {
	EventID string
	Created bool
}

// clusteringOverview assembles the failure-group counters of one organization.
func (s *Service) clusteringOverview(ctx context.Context, orgID string) (ClusteringFailureOverview, error) {
	pending, err := s.clustering.countByStatus(ctx, orgID, ClusteringFailureStatusPending)
	if err != nil {
		return ClusteringFailureOverview{}, err
	}
	processing, err := s.clustering.countByStatus(ctx, orgID, ClusteringFailureStatusProcessing)
	if err != nil {
		return ClusteringFailureOverview{}, err
	}
	resolved, err := s.clustering.countByStatus(ctx, orgID, ClusteringFailureStatusResolved)
	if err != nil {
		return ClusteringFailureOverview{}, err
	}
	ignored, err := s.clustering.countByStatus(ctx, orgID, ClusteringFailureStatusIgnored)
	if err != nil {
		return ClusteringFailureOverview{}, err
	}
	latest, err := s.clustering.latestFailureAt(ctx, orgID)
	if err != nil {
		return ClusteringFailureOverview{}, err
	}

	overview := ClusteringFailureOverview{
		PendingCount:    pending,
		ProcessingCount: processing,
		ResolvedCount:   resolved,
		IgnoredCount:    ignored,
	}
	if latest != nil {
		formatted := isoMillis(*latest)
		overview.LatestFailureAt = &formatted
	}
	return overview, nil
}

// clusteringFailures lists the failure groups of one organization.
func (s *Service) clusteringFailures(ctx context.Context, orgID string, status *ClusteringFailureStatus, limit int) ([]ClusteringFailureSummary, error) {
	effective := limit
	if effective <= 0 {
		effective = clusteringFailureDefaultListLimit
	}
	if effective < 1 {
		effective = 1
	}
	if effective > clusteringFailureMaxListLimit {
		effective = clusteringFailureMaxListLimit
	}
	rows, err := s.clustering.listFailures(ctx, orgID, status, effective)
	if err != nil {
		return nil, err
	}
	summaries := make([]ClusteringFailureSummary, 0, len(rows))
	for i := range rows {
		summaries = append(summaries, toClusteringFailureSummary(&rows[i]))
	}
	return summaries, nil
}

// ignoreClusteringFailure marks one failure group ignored.
func (s *Service) ignoreClusteringFailure(ctx context.Context, orgID, actorID, groupID string) (ClusteringFailureSummary, error) {
	resolvedAt := time.Now().UTC().Truncate(time.Millisecond)
	doc, err := s.clustering.ignoreFailureGroup(ctx, orgID, groupID, actorID, resolvedAt)
	if err != nil {
		return ClusteringFailureSummary{}, err
	}
	if doc == nil {
		return ClusteringFailureSummary{}, newHTTPError(404, msgFailureGroupNotFound)
	}
	return toClusteringFailureSummary(doc), nil
}

// vectorBackfillClusteringFailure claims one pending group atomically and
// assigns its items through local title/topic/entity matching.
//
// The atomic claim is the fix for the third shared defect: the NestJS original
// read the document, checked the status, and only flipped it to processing at
// the very end, so two concurrent requests both passed the check and processed
// the same items twice.
func (s *Service) vectorBackfillClusteringFailure(ctx context.Context, orgID, actorID, groupID string) (VectorBackfillResult, error) {
	existing, err := s.clustering.findFailureGroup(ctx, orgID, groupID)
	if err != nil {
		return VectorBackfillResult{}, err
	}
	if existing == nil {
		return VectorBackfillResult{}, newHTTPError(404, msgFailureGroupNotFound)
	}
	if existing.Status == ClusteringFailureStatusProcessing {
		return VectorBackfillResult{}, newHTTPError(400, msgFailureGroupProcessing)
	}
	if existing.Status == ClusteringFailureStatusResolved || existing.Status == ClusteringFailureStatusIgnored {
		return VectorBackfillResult{}, newHTTPError(400, msgFailureGroupUnrecoverable)
	}

	startedAt := time.Now().UTC().Truncate(time.Millisecond)
	nextAttemptCount := existing.AttemptCount
	if nextAttemptCount < 0 {
		nextAttemptCount = 0
	}
	nextAttemptCount++

	claimed, err := s.clustering.claimFailureGroup(ctx, orgID, groupID, startedAt, nextAttemptCount)
	if err != nil {
		return VectorBackfillResult{}, err
	}
	if claimed == nil {
		// Lost the race: classify by re-reading the current document.
		current, err := s.clustering.findFailureGroup(ctx, orgID, groupID)
		if err != nil {
			return VectorBackfillResult{}, err
		}
		if current == nil {
			return VectorBackfillResult{}, newHTTPError(404, msgFailureGroupNotFound)
		}
		switch current.Status {
		case ClusteringFailureStatusResolved, ClusteringFailureStatusIgnored:
			return VectorBackfillResult{}, newHTTPError(400, msgFailureGroupUnrecoverable)
		default:
			return VectorBackfillResult{}, newHTTPError(400, msgFailureGroupProcessing)
		}
	}

	settings := s.clustering.readOrgNewsEventSettings(ctx, orgID)
	resolvedEventIDs := make([]string, 0, len(claimed.Items))
	seenEventIDs := make(map[string]struct{}, len(claimed.Items))
	assignedCount := 0
	skippedCount := 0

	for i := range claimed.Items {
		item := claimed.Items[i]
		signal := signalFromFailureItem(item, startedAt)
		result, err := s.assignSignalToEvent(ctx, orgID, signal, settings)
		if err != nil {
			message := err.Error()
			// Return the group to pending so an operator can retry it.
			_ = s.clustering.releaseFailureGroup(ctx, orgID, groupID, message)
			s.clustering.insertTaskLog(ctx, taskLogEntry{
				Queue:   "news_events",
				JobID:   groupID,
				OrgID:   orgID,
				Stage:   "bertopic_vector_backfill",
				Status:  "failed",
				Message: message,
				Now:     time.Now().UTC().Truncate(time.Millisecond),
			})
			return VectorBackfillResult{}, err
		}
		if result.EventID != "" {
			if _, ok := seenEventIDs[result.EventID]; !ok {
				seenEventIDs[result.EventID] = struct{}{}
				resolvedEventIDs = append(resolvedEventIDs, result.EventID)
			}
		}
		if result.Created {
			assignedCount++
		} else {
			skippedCount++
		}
	}

	resolvedAt := time.Now().UTC().Truncate(time.Millisecond)
	if err := s.clustering.finalizeFailureGroup(ctx, orgID, groupID, actorID, resolvedAt, len(claimed.Items), resolvedEventIDs); err != nil {
		return VectorBackfillResult{}, err
	}
	sortStrings(resolvedEventIDs)
	s.clustering.insertTaskLog(ctx, taskLogEntry{
		Queue:  "news_events",
		JobID:  groupID,
		OrgID:  orgID,
		Stage:  "bertopic_vector_backfill",
		Status: "completed",
		Data: taskLogVectorBackfillData{
			ItemCount:        len(claimed.Items),
			AssignedCount:    assignedCount,
			SkippedCount:     skippedCount,
			ResolvedEventIDs: resolvedEventIDs,
		},
		Now: resolvedAt,
	})

	return VectorBackfillResult{
		GroupID:          groupID,
		AssignedCount:    assignedCount,
		SkippedCount:     skippedCount,
		ResolvedEventIDs: resolvedEventIDs,
		ResolvedAt:       isoMillis(resolvedAt),
	}, nil
}

// signalFromFailureItem converts one stored failure item into a news signal the
// way NewsEventClusteringFailureService.toSignal does.
func signalFromFailureItem(item clusteringFailureItemDoc, fallback time.Time) newsSignal {
	timestamp := fallback
	switch {
	case item.PublishedAt != nil:
		timestamp = *item.PublishedAt
	case item.CrawlAt != nil:
		timestamp = *item.CrawlAt
	case item.ProcessedAt != nil:
		timestamp = *item.ProcessedAt
	}
	return newsSignal{
		ProcessedArticleID: item.ProcessedArticleID,
		ProcessedItemID:    item.ProcessedItemID,
		Timestamp:          timestamp,
		Language:           item.Language,
		Title:              item.Title,
		Summary:            item.Summary,
		Topics:             item.Topics,
		Entities:           item.Entities,
		LegacyCategory:     item.Category,
		CategoryPath:       item.CategoryPath,
		CategoryConfidence: item.CategoryConfidence,
	}
}

// assignSignalToEvent mirrors the local (non-vector, non-LLM) subset of
// NewsEventsService.assignNewsSignalToEvent: an exact primaryTopic or
// primaryEntity overlap inside the lookback window wins, otherwise a new event
// is created.
func (s *Service) assignSignalToEvent(ctx context.Context, orgID string, signal newsSignal, settings newsEventSettings) (assignResult, error) {
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

	assignmentEventID := ""
	var assignmentSimilarity *float64
	if primaryTopic != "" || primaryEntity != "" {
		lookbackDays := settings.LookbackDays
		if lookbackDays < 1 {
			lookbackDays = 1
		}
		since := now.Add(-time.Duration(lookbackDays) * 24 * time.Hour)
		candidates, err := s.clustering.listNewsEventCandidates(ctx, orgID, since, primaryTopic, primaryEntity)
		if err != nil {
			return assignResult{}, err
		}
		bestID := ""
		bestScore := 0.0
		bestFound := false
		for i := range candidates {
			score, ok := scoreCandidate(candidates[i], signal, primaryTopic, primaryEntity, settings)
			if !ok {
				continue
			}
			// Descending score with a stable first-wins tie break, matching
			// the stable Array.prototype.sort of the NestJS implementation.
			if !bestFound || score > bestScore {
				bestID = candidates[i].ID
				bestScore = score
				bestFound = true
			}
		}
		if bestFound {
			assignmentEventID = bestID
			similarity := bestScore
			assignmentSimilarity = &similarity
		}
	}

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
	// this item between the pre-check and here.
	if racedEventID, found, err := findNewsEventItemEventIDTx(ctx, tx, orgID, signal.ProcessedArticleID); err != nil {
		return assignResult{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return assignResult{}, err
		}
		committed = true
		return assignResult{EventID: racedEventID, Created: false}, nil
	}

	eventID := assignmentEventID
	createdEvent := false
	if eventID == "" {
		generated, err := newPrismaID()
		if err != nil {
			return assignResult{}, err
		}
		event := newsEventInsert{
			ID:                               generated,
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
		eventID = generated
		createdEvent = true
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
		Similarity:         assignmentSimilarity,
		AssignedBy:         newsEventAssignmentOverlap,
		CreatedAt:          now,
	}
	if err := insertNewsEventItemTx(ctx, tx, item); err != nil {
		if isDuplicateEntry(err) {
			// Lost the race against a writer that committed the same
			// (orgId, processedArticleId) first. Roll this transaction back so a
			// newly created event never lands without an item, then resolve the
			// winner with a read outside the transaction: the snapshot of this
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

	if assignmentEventID != "" {
		startAt, lastAt, err := loadEventWindowTx(ctx, tx, assignmentEventID)
		if err != nil {
			if !errors.Is(err, errNoNewsEvent) {
				return assignResult{}, err
			}
			startAt, lastAt = timestamp, timestamp
		}
		newStart := minTime(clampFutureDate(startAt, now), timestamp)
		newLast := maxTime(clampFutureDate(lastAt, now), timestamp)
		if err := updateEventWindowTx(ctx, tx, assignmentEventID, newStart, newLast, now); err != nil {
			return assignResult{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return assignResult{}, err
	}
	committed = true
	return assignResult{EventID: eventID, Created: createdEvent}, nil
}

// scoreCandidate applies the language penalty and the category gate to one
// candidate event, reporting false when the gate rejects it.
func scoreCandidate(candidate newsEventCandidate, signal newsSignal, primaryTopic, primaryEntity string, settings newsEventSettings) (float64, bool) {
	topicMatch := primaryTopic != "" && candidate.PrimaryTopic != nil && *candidate.PrimaryTopic == primaryTopic
	entityMatch := primaryEntity != "" && candidate.PrimaryEntity != nil && *candidate.PrimaryEntity == primaryEntity
	matches := 0
	if topicMatch {
		matches++
	}
	if entityMatch {
		matches++
	}
	if matches == 0 {
		return 0, false
	}

	// Exact topic and entity matches weigh half each, so a double match scores
	// 1.0 and a single match 0.5 before the penalties.
	score := float64(matches) / 2
	score = applyLanguagePenalty(score, signal.Language, candidate.Language, settings)
	adjusted, ok := applyCategoryGate(score, signal, candidate.MetadataJSON, settings)
	if !ok {
		return 0, false
	}
	return adjusted, true
}

// applyLanguagePenalty scales the score when the article and the event declare
// different languages. A missing or equal language leaves the score untouched.
func applyLanguagePenalty(score float64, signalLanguage, eventLanguage *string, settings newsEventSettings) float64 {
	signalValue := normalizeOptionalString(signalLanguage)
	eventValue := normalizeOptionalString(eventLanguage)
	// A missing language on either side, or an exact (case-sensitive) match,
	// leaves the score untouched.
	if signalValue == nil || eventValue == nil || *signalValue == *eventValue {
		return score
	}
	penalty := clampRange(settings.CrossLanguagePenalty, 0, 1)
	return score * (1 - penalty)
}

// applyCategoryGate implements the eight-decision category ladder. The second
// result is false for the hard-reject decisions.
func applyCategoryGate(score float64, signal newsSignal, eventMetadataJSON []byte, settings newsEventSettings) (float64, bool) {
	if !settings.ClassificationGateEnabled {
		return score, true
	}

	signalCategory := normalizeLegacyCategory(signal.LegacyCategory)
	signalConfidence := clampConfidence(signal.CategoryConfidence)
	if signalCategory == "" {
		return score, true
	}
	if signalConfidence == nil || *signalConfidence < settings.MinCategoryConfidenceForGate {
		return score, true
	}

	eventClassification := extractEventClassification(eventMetadataJSON)
	if eventClassification.LegacyCategory == "" {
		return score, true
	}
	if eventClassification.LegacyCategory != signalCategory {
		if settings.CategoryConflictReject {
			return 0, false
		}
		adjusted := score * (1 - clampUnit(settings.CategorySoftPenalty))
		return adjusted, true
	}

	signalPath := normalizeCategoryPathOptional(signal.CategoryPath)
	eventPath := normalizeCategoryPath(eventClassification.CategoryPath)
	if signalPath == "" || eventPath == "" || signalPath == eventPath {
		return score, true
	}
	adjusted := score * (1 - clampUnit(settings.CategorySoftPenalty*0.5))
	return adjusted, true
}

// eventClassification is the classification block stored in NewsEvent.metadata.
type eventClassification struct {
	LegacyCategory string
	CategoryPath   string
	Confidence     *float64
}

// extractEventClassification reads metadata.classification from a JSON column.
func extractEventClassification(metadataJSON []byte) eventClassification {
	if len(metadataJSON) == 0 {
		return eventClassification{}
	}
	var document struct {
		Classification *struct {
			LegacyCategory json.RawMessage `json:"legacyCategory"`
			CategoryPath   json.RawMessage `json:"categoryPath"`
			Confidence     json.RawMessage `json:"confidence"`
		} `json:"classification"`
	}
	if err := json.Unmarshal(metadataJSON, &document); err != nil || document.Classification == nil {
		return eventClassification{}
	}
	return eventClassification{
		LegacyCategory: normalizeLegacyCategoryRaw(document.Classification.LegacyCategory),
		CategoryPath:   normalizeCategoryPathRaw(document.Classification.CategoryPath),
		Confidence:     clampConfidenceRaw(document.Classification.Confidence),
	}
}

// classificationMetadata is the `classification` object stored on a new event.
type classificationMetadata struct {
	LegacyCategory string   `json:"legacyCategory"`
	CategoryPath   string   `json:"categoryPath,omitempty"`
	Confidence     *float64 `json:"confidence,omitempty"`
}

// classificationEnvelope wraps the classification block the way
// NewsEventsService.createEvent stores it.
type classificationEnvelope struct {
	Classification classificationMetadata `json:"classification"`
}

// buildClassificationMetadata renders the NewsEvent.metadata column. A nil
// result means SQL NULL.
func buildClassificationMetadata(signal newsSignal) []byte {
	legacyCategory := normalizeLegacyCategory(signal.LegacyCategory)
	if legacyCategory == "" {
		return nil
	}
	envelope := classificationEnvelope{Classification: classificationMetadata{LegacyCategory: legacyCategory}}
	if categoryPath := normalizeCategoryPathOptional(signal.CategoryPath); categoryPath != "" {
		envelope.Classification.CategoryPath = categoryPath
	}
	envelope.Classification.Confidence = clampConfidence(signal.CategoryConfidence)
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return nil
	}
	return encoded
}

// legacyCategories is the closed set accepted by normalizeLegacyCategory.
var legacyCategories = map[string]struct{}{
	"politics": {},
	"tech":     {},
	"finance":  {},
	"gov":      {},
	"ai":       {},
	"intel":    {},
}

// normalizeLegacyCategory lowercases and whitelists a legacy category.
func normalizeLegacyCategory(value *string) string {
	if value == nil {
		return ""
	}
	normalized := strings.ToLower(strings.TrimSpace(*value))
	if _, ok := legacyCategories[normalized]; !ok {
		return ""
	}
	return normalized
}

// normalizeLegacyCategoryRaw applies normalizeLegacyCategory to a raw JSON
// string.
func normalizeLegacyCategoryRaw(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return normalizeLegacyCategory(&value)
}

// normalizeCategoryPathOptional applies normalizeCategoryPath to a nullable
// value, mapping nil to the empty string.
func normalizeCategoryPathOptional(value *string) string {
	if value == nil {
		return ""
	}
	return normalizeCategoryPath(*value)
}

// normalizeCategoryPath mirrors normalizeCategoryPath: trim, lowercase,
// backslashes to slashes, whitespace runs to "-", collapse slashes, then strip
// leading and trailing slashes.
func normalizeCategoryPath(value string) string {
	normalized := strings.TrimSpace(value)
	normalized = strings.ToLower(normalized)
	normalized = strings.ReplaceAll(normalized, "\\", "/")
	normalized = collapseWhitespaceToDash(normalized)
	normalized = collapseSlashes(normalized)
	normalized = strings.Trim(normalized, "/")
	return normalized
}

// normalizeCategoryPathRaw applies normalizeCategoryPath to a raw JSON string.
func normalizeCategoryPathRaw(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return normalizeCategoryPath(value)
}

// clampConfidence clamps a category confidence to 0..1, returning nil when the
// value is absent or not finite.
func clampConfidence(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	clamped := clampUnit(*value)
	return &clamped
}

// clampConfidenceRaw applies clampConfidence to a raw JSON value.
func clampConfidenceRaw(raw json.RawMessage) *float64 {
	if len(raw) == 0 {
		return nil
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return clampConfidence(&value)
}

// pickPrimaryTopic returns the first non-blank topic.
func pickPrimaryTopic(topics []string) string {
	for _, topic := range topics {
		if normalized := strings.TrimSpace(topic); normalized != "" {
			return normalized
		}
	}
	return ""
}

// pickPrimaryEntity returns the highest-confidence entity name, falling back to
// the first named entity. Ties keep the first entity.
func pickPrimaryEntity(entities []clusteringFailureEntityDoc) string {
	fallback := ""
	bestName := ""
	bestConfidence := 0.0
	hasBest := false
	for _, entity := range entities {
		normalizedName := strings.TrimSpace(entity.Name)
		if normalizedName == "" {
			continue
		}
		if fallback == "" {
			fallback = normalizedName
		}
		if entity.Confidence == nil || math.IsNaN(*entity.Confidence) || math.IsInf(*entity.Confidence, 0) {
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

// normalizeOptionalString trims a string and maps an empty result to nil.
func normalizeOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// stringPointerOrNil returns a pointer to a non-empty string, else nil.
func stringPointerOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// clampFutureDate caps a timestamp at "now" and replaces invalid values with
// now, mirroring NewsEventsService.clampFutureDate.
func clampFutureDate(value, now time.Time) time.Time {
	if value.IsZero() || value.UnixMilli() <= 0 {
		return now
	}
	if value.After(now) {
		return now
	}
	return value
}

// minTime returns the earlier of two timestamps.
func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// maxTime returns the later of two timestamps.
func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// isDuplicateEntry reports a MySQL unique constraint violation.
func isDuplicateEntry(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == mysqlDuplicateEntry
	}
	return false
}

// collapseWhitespaceToDash replaces every whitespace run with a single dash.
func collapseWhitespaceToDash(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	inRun := false
	for _, r := range value {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' {
			if !inRun {
				b.WriteByte('-')
				inRun = true
			}
			continue
		}
		inRun = false
		b.WriteRune(r)
	}
	return b.String()
}

// collapseSlashes replaces every slash run with a single slash.
func collapseSlashes(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	inRun := false
	for _, r := range value {
		if r == '/' {
			if !inRun {
				b.WriteByte('/')
				inRun = true
			}
			continue
		}
		inRun = false
		b.WriteRune(r)
	}
	return b.String()
}

// clampUnit clamps a value into 0..1 without rounding.
func clampUnit(value float64) float64 {
	if math.IsNaN(value) {
		return 0
	}
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

// clampRange clamps a value into [min,max].
func clampRange(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// findNewsEventItemEventIDTx is the transaction-scoped idempotency lookup.
func findNewsEventItemEventIDTx(ctx context.Context, tx *sql.Tx, orgID, processedArticleID string) (string, bool, error) {
	var eventID string
	err := tx.QueryRowContext(ctx,
		"SELECT eventId FROM NewsEventItem WHERE orgId = ? AND processedArticleId = ? LIMIT 1",
		orgID, processedArticleID).Scan(&eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(eventID), true, nil
}

// insertNewsEventTx inserts one NewsEvent row inside a transaction.
func insertNewsEventTx(ctx context.Context, tx *sql.Tx, event newsEventInsert) error {
	_, err := tx.ExecContext(ctx,
		"INSERT INTO NewsEvent (id, orgId, status, language, primaryTopic, primaryEntity, title, summary,"+
			" startAt, lastAt, representativeProcessedArticleId, representativeProcessedItemId, metadata, createdAt, updatedAt)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		event.ID, event.OrgID, newsEventStatusActive, event.Language, event.PrimaryTopic, event.PrimaryEntity,
		event.Title, event.Summary, event.StartAt, event.LastAt, event.RepresentativeProcessedArticleID,
		event.RepresentativeProcessedItemID, event.MetadataJSON, event.CreatedAt, event.UpdatedAt)
	return err
}

// insertNewsEventItemTx inserts one NewsEventItem row inside a transaction.
func insertNewsEventItemTx(ctx context.Context, tx *sql.Tx, item newsEventItemInsert) error {
	_, err := tx.ExecContext(ctx,
		"INSERT INTO NewsEventItem (id, orgId, eventId, processedArticleId, processedItemId, similarity, assignedBy, createdAt)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		item.ID, item.OrgID, item.EventID, item.ProcessedArticleID, item.ProcessedItemID,
		item.Similarity, item.AssignedBy, item.CreatedAt)
	return err
}

// loadEventWindowTx reads an event window inside a transaction.
func loadEventWindowTx(ctx context.Context, tx *sql.Tx, eventID string) (time.Time, time.Time, error) {
	var startAt, lastAt time.Time
	err := tx.QueryRowContext(ctx,
		"SELECT startAt, lastAt FROM NewsEvent WHERE id = ? LIMIT 1", eventID).Scan(&startAt, &lastAt)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, time.Time{}, errNoNewsEvent
	}
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	return startAt, lastAt, nil
}

// updateEventWindowTx widens an event window inside a transaction.
func updateEventWindowTx(ctx context.Context, tx *sql.Tx, eventID string, startAt, lastAt, updatedAt time.Time) error {
	_, err := tx.ExecContext(ctx,
		"UPDATE NewsEvent SET startAt = ?, lastAt = ?, updatedAt = ? WHERE id = ?",
		startAt, lastAt, updatedAt, eventID)
	return err
}

// isoMillis renders a timestamp the way Date.prototype.toISOString does.
func isoMillis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// toClusteringFailureSummary maps a stored document to the response row.
func toClusteringFailureSummary(doc *clusteringFailureDoc) ClusteringFailureSummary {
	status := doc.Status
	switch status {
	case ClusteringFailureStatusPending, ClusteringFailureStatusProcessing,
		ClusteringFailureStatusResolved, ClusteringFailureStatusIgnored:
	default:
		status = ClusteringFailureStatusPending
	}
	clusteringMode := doc.ClusteringMode
	if clusteringMode == "" {
		clusteringMode = "bertopic_primary"
	}
	failureReason := doc.FailureReason
	if failureReason == "" {
		failureReason = "unknown_failure"
	}
	sampleTitles := doc.SampleTitles
	if sampleTitles == nil {
		sampleTitles = []string{}
	}
	resolvedEventIDs := doc.ResolvedEventIDs
	if resolvedEventIDs == nil {
		resolvedEventIDs = []string{}
	}
	summary := ClusteringFailureSummary{
		GroupID:                doc.GroupID,
		Status:                 status,
		ClusteringMode:         clusteringMode,
		FailureReason:          failureReason,
		FailureMessage:         doc.FailureMessage,
		Language:               doc.Language,
		EmbeddingModel:         doc.EmbeddingModel,
		ItemCount:              maxInt(doc.ItemCount, 0),
		SampleTitles:           sampleTitles,
		AttemptCount:           maxInt(doc.AttemptCount, 0),
		LastError:              doc.LastError,
		ActiveJobID:            doc.ActiveJobID,
		ProgressProcessedCount: maxInt(doc.ProgressProcessedCount, 0),
		ProgressTotalCount:     maxInt(doc.ProgressTotalCount, 0),
		LastRecoveryModel:      doc.LastRecoveryModel,
		ResolutionMode:         doc.ResolutionMode,
		ResolvedEventIDs:       resolvedEventIDs,
		CreatedAt:              isoMillis(doc.CreatedAt),
		UpdatedAt:              isoMillis(doc.UpdatedAt),
	}
	if doc.LastAttemptAt != nil {
		formatted := isoMillis(*doc.LastAttemptAt)
		summary.LastAttemptAt = &formatted
	}
	if doc.ResolvedAt != nil {
		formatted := isoMillis(*doc.ResolvedAt)
		summary.ResolvedAt = &formatted
	}
	return summary
}

// maxInt returns the larger of two integers.
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
