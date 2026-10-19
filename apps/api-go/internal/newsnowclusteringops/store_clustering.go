package newsnowclusteringops

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	// newsEventStatusActive is the only NewsEvent.status value the local
	// assignment path considers.
	newsEventStatusActive = "active"
	// defaultCandidateEventsLimit mirrors DEFAULT_CANDIDATE_EVENTS_LIMIT.
	defaultCandidateEventsLimit = 30
	// clusteringFailureDefaultListLimit mirrors the controller default.
	clusteringFailureDefaultListLimit = 20
	// clusteringFailureMaxListLimit mirrors the controller clamp.
	clusteringFailureMaxListLimit = 200
)

// clusteringFailureEntityDoc is one entity inside a failure group item.
type clusteringFailureEntityDoc struct {
	Name       string   `bson:"name"`
	Type       *string  `bson:"type"`
	Confidence *float64 `bson:"confidence"`
}

// clusteringFailureItemDoc is one failed article of a failure group.
type clusteringFailureItemDoc struct {
	ProcessedArticleID string                       `bson:"processedArticleId"`
	ProcessedItemID    *string                      `bson:"processedItemId"`
	ArticleID          string                       `bson:"articleId"`
	Title              *string                      `bson:"title"`
	Summary            *string                      `bson:"summary"`
	Language           *string                      `bson:"language"`
	Category           *string                      `bson:"category"`
	CategoryPath       *string                      `bson:"categoryPath"`
	CategoryConfidence *float64                     `bson:"categoryConfidence"`
	Topics             []string                     `bson:"topics"`
	Entities           []clusteringFailureEntityDoc `bson:"entities"`
	QualityScore       *float64                     `bson:"qualityScore"`
	PublishedAt        *time.Time                   `bson:"publishedAt"`
	ProcessedAt        *time.Time                   `bson:"processedAt"`
	CrawlAt            *time.Time                   `bson:"crawlAt"`
}

// clusteringFailureDoc is the Mongo newseventclusteringfailures document.
// Every field carries the exact bson tag of the Mongoose schema.
type clusteringFailureDoc struct {
	ID                     bson.ObjectID              `bson:"_id,omitempty"`
	OrgID                  string                     `bson:"orgId"`
	GroupID                string                     `bson:"groupId"`
	Status                 ClusteringFailureStatus    `bson:"status"`
	ClusteringMode         string                     `bson:"clusteringMode"`
	FailureReason          string                     `bson:"failureReason"`
	FailureMessage         *string                    `bson:"failureMessage"`
	RequestID              *string                    `bson:"requestId"`
	Language               *string                    `bson:"language"`
	EmbeddingModel         *string                    `bson:"embeddingModel"`
	ItemCount              int                        `bson:"itemCount"`
	SampleTitles           []string                   `bson:"sampleTitles"`
	Items                  []clusteringFailureItemDoc `bson:"items"`
	AttemptCount           int                        `bson:"attemptCount"`
	LastAttemptAt          *time.Time                 `bson:"lastAttemptAt"`
	LastError              *string                    `bson:"lastError"`
	ActiveJobID            *string                    `bson:"activeJobId"`
	ProgressProcessedCount int                        `bson:"progressProcessedCount"`
	ProgressTotalCount     int                        `bson:"progressTotalCount"`
	LastRecoveryModel      *string                    `bson:"lastRecoveryModel"`
	ResolvedAt             *time.Time                 `bson:"resolvedAt"`
	ResolvedByID           *string                    `bson:"resolvedById"`
	ResolutionMode         *string                    `bson:"resolutionMode"`
	ResolvedEventIDs       []string                   `bson:"resolvedEventIds"`
	CreatedAt              time.Time                  `bson:"createdAt"`
	UpdatedAt              time.Time                  `bson:"updatedAt"`
}

// newsEventSettings is the subset of NewsEventSettings the local assignment
// path consumes, after normalization.
type newsEventSettings struct {
	LookbackDays                 int
	VectorMinScore               float64
	CrossLanguagePenalty         float64
	ClassificationGateEnabled    bool
	CategoryConflictReject       bool
	CategorySoftPenalty          float64
	MinCategoryConfidenceForGate float64
}

// newsEventSettingsDoc is the persisted news_event_settings:<orgId> document.
// Raw messages are used because the stored numbers may be numbers or numeric
// strings, exactly like the NestJS toNumber helper accepts.
type newsEventSettingsDoc struct {
	LookbackDays                 json.RawMessage `json:"lookbackDays"`
	VectorMinScore               json.RawMessage `json:"vectorMinScore"`
	CrossLanguagePenalty         json.RawMessage `json:"crossLanguagePenalty"`
	ClassificationGateEnabled    json.RawMessage `json:"classificationGateEnabled"`
	CategoryConflictReject       json.RawMessage `json:"categoryConflictReject"`
	CategorySoftPenalty          json.RawMessage `json:"categorySoftPenalty"`
	MinCategoryConfidenceForGate json.RawMessage `json:"minCategoryConfidenceForGate"`
}

// newsEventCandidate is one active NewsEvent row considered by the local
// overlap matcher.
type newsEventCandidate struct {
	ID            string
	Language      *string
	PrimaryTopic  *string
	PrimaryEntity *string
	MetadataJSON  []byte
	StartAt       time.Time
	LastAt        time.Time
}

// clusteringStore owns every Mongo and MySQL access of the clustering failure
// endpoints.
type clusteringStore struct {
	mongo *mongo.Database
	db    *sql.DB
}

// newClusteringStore builds the clustering store.
func newClusteringStore(database *mongo.Database, db *sql.DB) *clusteringStore {
	return &clusteringStore{mongo: database, db: db}
}

// failures returns the failure-group collection handle.
func (s *clusteringStore) failures() *mongo.Collection {
	return s.mongo.Collection(clusteringFailuresCollection)
}

// countByStatus counts the failure groups of one organization in one status.
func (s *clusteringStore) countByStatus(ctx context.Context, orgID string, status ClusteringFailureStatus) (int, error) {
	count, err := s.failures().CountDocuments(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: status},
	})
	if err != nil {
		return 0, err
	}
	return int(count), nil
}

// latestFailureAt returns the createdAt of the newest failure group of one
// organization, or nil when the organization has none.
func (s *clusteringStore) latestFailureAt(ctx context.Context, orgID string) (*time.Time, error) {
	var doc struct {
		CreatedAt time.Time `bson:"createdAt"`
	}
	err := s.failures().FindOne(ctx,
		bson.D{{Key: "orgId", Value: orgID}},
		options.FindOne().
			SetProjection(bson.D{{Key: "createdAt", Value: 1}}).
			SetSort(bson.D{{Key: "createdAt", Value: -1}}),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc.CreatedAt, nil
}

// listFailures returns the newest failure groups of one organization, newest
// first, optionally filtered by status.
func (s *clusteringStore) listFailures(ctx context.Context, orgID string, status *ClusteringFailureStatus, limit int) ([]clusteringFailureDoc, error) {
	filter := bson.D{{Key: "orgId", Value: orgID}}
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	cursor, err := s.failures().Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()

	rows := make([]clusteringFailureDoc, 0, limit)
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// findFailureGroup reads one failure group of one organization. The orgId
// predicate is the tenant boundary: another organization's group is reported as
// missing, never as forbidden.
func (s *clusteringStore) findFailureGroup(ctx context.Context, orgID, groupID string) (*clusteringFailureDoc, error) {
	var doc clusteringFailureDoc
	err := s.failures().FindOne(ctx, bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "groupId", Value: groupID},
	}).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc, nil
}

// claimFailureGroup atomically flips a pending failure group to processing.
// The { status: "pending" } predicate is what makes concurrent vector-backfill
// requests safe: exactly one caller wins, the others observe a nil result and
// are classified by the caller. This fixes the duplicate-event bug of the
// NestJS original, which never took the lock.
func (s *clusteringStore) claimFailureGroup(ctx context.Context, orgID, groupID string, startedAt time.Time, nextAttemptCount int) (*clusteringFailureDoc, error) {
	var doc clusteringFailureDoc
	err := s.failures().FindOneAndUpdate(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
			{Key: "status", Value: ClusteringFailureStatusPending},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: ClusteringFailureStatusProcessing},
			{Key: "lastAttemptAt", Value: startedAt},
			{Key: "attemptCount", Value: nextAttemptCount},
		}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc, nil
}

// finalizeFailureGroup marks a claimed group resolved.
func (s *clusteringStore) finalizeFailureGroup(ctx context.Context, orgID, groupID, actorID string, resolvedAt time.Time, processedCount int, resolvedEventIDs []string) error {
	sorted := make([]string, len(resolvedEventIDs))
	copy(sorted, resolvedEventIDs)
	sortStrings(sorted)

	_, err := s.failures().UpdateOne(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: ClusteringFailureStatusResolved},
			{Key: "lastError", Value: nil},
			{Key: "activeJobId", Value: nil},
			{Key: "progressProcessedCount", Value: processedCount},
			{Key: "progressTotalCount", Value: processedCount},
			{Key: "resolvedAt", Value: resolvedAt},
			{Key: "resolvedById", Value: actorID},
			{Key: "resolutionMode", Value: "vector_backfill"},
			{Key: "resolvedEventIds", Value: sorted},
		}}},
	)
	return err
}

// releaseFailureGroup returns a claimed group to pending after a failure.
func (s *clusteringStore) releaseFailureGroup(ctx context.Context, orgID, groupID, message string) error {
	_, err := s.failures().UpdateOne(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: ClusteringFailureStatusPending},
			{Key: "lastError", Value: message},
			{Key: "activeJobId", Value: nil},
		}}},
	)
	return err
}

// ignoreFailureGroup marks a group ignored. The second result is false when the
// group does not exist inside the organization.
func (s *clusteringStore) ignoreFailureGroup(ctx context.Context, orgID, groupID, actorID string, resolvedAt time.Time) (*clusteringFailureDoc, error) {
	var doc clusteringFailureDoc
	err := s.failures().FindOneAndUpdate(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "groupId", Value: groupID},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: ClusteringFailureStatusIgnored},
			{Key: "activeJobId", Value: nil},
			{Key: "resolvedById", Value: actorID},
			{Key: "resolvedAt", Value: resolvedAt},
			{Key: "resolutionMode", Value: "ignored"},
		}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &doc, nil
}

// readOrgNewsEventSettings reads news_event_settings:<orgId> and normalizes the
// six fields the local assignment path uses. A missing row or a database error
// yields the NestJS defaults.
func (s *clusteringStore) readOrgNewsEventSettings(ctx context.Context, orgID string) newsEventSettings {
	settings := defaultNewsEventSettings()
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1",
		"news_event_settings:"+orgID).Scan(&raw)
	if err != nil || len(raw) == 0 {
		return settings
	}
	var doc newsEventSettingsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return settings
	}
	settings.LookbackDays = clampIntRaw(doc.LookbackDays, 1, 180, settings.LookbackDays)
	settings.VectorMinScore = clampFloatRaw(doc.VectorMinScore, 0, 1, settings.VectorMinScore)
	settings.CrossLanguagePenalty = clampFloatRaw(doc.CrossLanguagePenalty, 0, 1, settings.CrossLanguagePenalty)
	settings.ClassificationGateEnabled = boolRaw(doc.ClassificationGateEnabled, settings.ClassificationGateEnabled)
	settings.CategoryConflictReject = boolRaw(doc.CategoryConflictReject, settings.CategoryConflictReject)
	settings.CategorySoftPenalty = clampFloatRaw(doc.CategorySoftPenalty, 0, 1, settings.CategorySoftPenalty)
	settings.MinCategoryConfidenceForGate = clampFloatRaw(doc.MinCategoryConfidenceForGate, 0, 1, settings.MinCategoryConfidenceForGate)
	return settings
}

// defaultNewsEventSettings mirrors the six relevant fields of
// NewsEventsSettingsService.getFallbackSettings.
func defaultNewsEventSettings() newsEventSettings {
	return newsEventSettings{
		LookbackDays:                 30,
		VectorMinScore:               0.82,
		CrossLanguagePenalty:         0.1,
		ClassificationGateEnabled:    true,
		CategoryConflictReject:       true,
		CategorySoftPenalty:          0.15,
		MinCategoryConfidenceForGate: 0.4,
	}
}

// findNewsEventItemEventID looks up the event a processed article already
// belongs to. This is the idempotency check keyed by
// (orgId, processedArticleId).
func (s *clusteringStore) findNewsEventItemEventID(ctx context.Context, orgID, processedArticleID string) (string, bool, error) {
	var eventID string
	err := s.db.QueryRowContext(ctx,
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

// listNewsEventCandidates returns the active events of one organization whose
// primaryTopic or primaryEntity equals one of the derived signals and whose
// lastAt is inside the lookback window, newest first.
//
// The SQL equality relies on the MySQL column collation (utf8mb4_unicode_ci,
// case-insensitive), while the caller's in-memory re-check is case-sensitive.
// That asymmetry is intentional: it reproduces the NestJS behaviour exactly.
// The two "? <> ”" guards reproduce the NestJS OR-clause construction: an
// empty signal simply contributes no clause, and when both are empty the
// predicate matches nothing.
func (s *clusteringStore) listNewsEventCandidates(ctx context.Context, orgID string, since time.Time, primaryTopic, primaryEntity string) ([]newsEventCandidate, error) {
	if primaryTopic == "" && primaryEntity == "" {
		return nil, nil
	}
	const query = "SELECT id, language, primaryTopic, primaryEntity, metadata, startAt, lastAt FROM NewsEvent" +
		" WHERE orgId = ? AND status = 'active' AND lastAt >= ?" +
		" AND ((? <> '' AND primaryTopic = ?) OR (? <> '' AND primaryEntity = ?))" +
		" ORDER BY lastAt DESC, startAt DESC LIMIT 30"

	rows, err := s.db.QueryContext(ctx, query, orgID, since, primaryTopic, primaryTopic, primaryEntity, primaryEntity)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	candidates := make([]newsEventCandidate, 0, defaultCandidateEventsLimit)
	for rows.Next() {
		var candidate newsEventCandidate
		var language, topic, entity sql.NullString
		var metadata []byte
		if err := rows.Scan(&candidate.ID, &language, &topic, &entity, &metadata, &candidate.StartAt, &candidate.LastAt); err != nil {
			return nil, err
		}
		candidate.Language = nullStringPointer(language)
		candidate.PrimaryTopic = nullStringPointer(topic)
		candidate.PrimaryEntity = nullStringPointer(entity)
		candidate.MetadataJSON = metadata
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

// insertNewsEvent creates one NewsEvent row. updatedAt has no database default
// in the Prisma migration, so it is always supplied.
func (s *clusteringStore) insertNewsEvent(ctx context.Context, event newsEventInsert) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO NewsEvent (id, orgId, status, language, primaryTopic, primaryEntity, title, summary,"+
			" startAt, lastAt, representativeProcessedArticleId, representativeProcessedItemId, metadata, createdAt, updatedAt)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		event.ID, event.OrgID, newsEventStatusActive, event.Language, event.PrimaryTopic, event.PrimaryEntity,
		event.Title, event.Summary, event.StartAt, event.LastAt, event.RepresentativeProcessedArticleID,
		event.RepresentativeProcessedItemID, event.MetadataJSON, event.CreatedAt, event.UpdatedAt)
	return err
}

// insertNewsEventItem creates one NewsEventItem row.
func (s *clusteringStore) insertNewsEventItem(ctx context.Context, item newsEventItemInsert) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO NewsEventItem (id, orgId, eventId, processedArticleId, processedItemId, similarity, assignedBy, createdAt)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		item.ID, item.OrgID, item.EventID, item.ProcessedArticleID, item.ProcessedItemID,
		item.Similarity, item.AssignedBy, item.CreatedAt)
	return err
}

// loadEventWindow reads the current startAt/lastAt of an event.
func (s *clusteringStore) loadEventWindow(ctx context.Context, eventID string) (time.Time, time.Time, error) {
	var startAt, lastAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT startAt, lastAt FROM NewsEvent WHERE id = ? LIMIT 1", eventID).Scan(&startAt, &lastAt)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, time.Time{}, errNoNewsEvent
	}
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	return startAt, lastAt, nil
}

// updateEventWindow widens an event's time window.
func (s *clusteringStore) updateEventWindow(ctx context.Context, eventID string, startAt, lastAt, updatedAt time.Time) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE NewsEvent SET startAt = ?, lastAt = ?, updatedAt = ? WHERE id = ?",
		startAt, lastAt, updatedAt, eventID)
	return err
}

// loadProcessedItemSignals reads the sentiment and source hints of a set of
// ProcessedItem ids. Missing or malformed ids are skipped, matching the
// Mongoose CastError path of the NestJS original.
func (s *clusteringStore) loadProcessedItemSignals(ctx context.Context, processedItemIDs []string) (map[string]processedItemSignal, error) {
	out := make(map[string]processedItemSignal, len(processedItemIDs))
	if len(processedItemIDs) == 0 || s.mongo == nil {
		return out, nil
	}
	objectIDs := make([]bson.ObjectID, 0, len(processedItemIDs))
	for _, raw := range processedItemIDs {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		id, err := bson.ObjectIDFromHex(trimmed)
		if err != nil {
			continue
		}
		objectIDs = append(objectIDs, id)
	}
	if len(objectIDs) == 0 {
		return out, nil
	}

	cursor, err := s.mongo.Collection(processedItemsCollection).Find(ctx,
		bson.D{
			{Key: "_id", Value: bson.D{{Key: "$in", Value: objectIDs}}},
			{Key: "status", Value: "completed"},
		},
		options.Find().SetProjection(bson.D{
			{Key: "sourceId", Value: 1},
			{Key: "result.sentiment_label", Value: 1},
		}),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()

	for cursor.Next(ctx) {
		var row struct {
			ID       bson.ObjectID `bson:"_id"`
			SourceID *string       `bson:"sourceId"`
			Result   *struct {
				SentimentLabel *string `bson:"sentiment_label"`
			} `bson:"result"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if row.ID.IsZero() {
			continue
		}
		signal := processedItemSignal{}
		if row.SourceID != nil {
			trimmed := strings.TrimSpace(*row.SourceID)
			if trimmed != "" {
				signal.SourceID = &trimmed
			}
		}
		if row.Result != nil {
			signal.Sentiment = normalizeSentimentLabel(row.Result.SentimentLabel)
		}
		out[row.ID.Hex()] = signal
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// insertTaskLog writes one TaskLog document best effort. It mirrors
// writeTaskLogBestEffort: jobId is coerced to a string and a write failure is
// swallowed.
func (s *clusteringStore) insertTaskLog(ctx context.Context, entry taskLogEntry) {
	if s.mongo == nil {
		return
	}
	document := taskLogDocument{
		Queue:     entry.Queue,
		JobID:     entry.JobID,
		OrgID:     entry.OrgID,
		Stage:     entry.Stage,
		Status:    entry.Status,
		Message:   entry.Message,
		Data:      entry.Data,
		CreatedAt: entry.Now,
		UpdatedAt: entry.Now,
	}
	_, _ = s.mongo.Collection(taskLogsCollection).InsertOne(ctx, document)
}

// taskLogDocument is one tasklogs document.
type taskLogDocument struct {
	Queue     string                    `bson:"queue"`
	JobID     string                    `bson:"jobId"`
	OrgID     string                    `bson:"orgId"`
	Stage     string                    `bson:"stage"`
	Status    string                    `bson:"status"`
	Message   string                    `bson:"message,omitempty"`
	Data      taskLogVectorBackfillData `bson:"data,omitempty"`
	CreatedAt time.Time                 `bson:"createdAt"`
	UpdatedAt time.Time                 `bson:"updatedAt"`
}

// taskLogVectorBackfillData is the typed `data` payload of a vector-backfill
// task log.
type taskLogVectorBackfillData struct {
	ItemCount        int      `bson:"itemCount"`
	AssignedCount    int      `bson:"assignedCount"`
	SkippedCount     int      `bson:"skippedCount"`
	ResolvedEventIDs []string `bson:"resolvedEventIds"`
}

// taskLogEntry is the input of insertTaskLog.
type taskLogEntry struct {
	Queue   string
	JobID   string
	OrgID   string
	Stage   string
	Status  string
	Message string
	Data    taskLogVectorBackfillData
	Now     time.Time
}

// newsEventInsert is one NewsEvent row to insert.
type newsEventInsert struct {
	ID                               string
	OrgID                            string
	Language                         *string
	PrimaryTopic                     *string
	PrimaryEntity                    *string
	Title                            *string
	Summary                          *string
	StartAt                          time.Time
	LastAt                           time.Time
	RepresentativeProcessedArticleID string
	RepresentativeProcessedItemID    *string
	MetadataJSON                     []byte
	CreatedAt                        time.Time
	UpdatedAt                        time.Time
}

// newsEventItemInsert is one NewsEventItem row to insert.
type newsEventItemInsert struct {
	ID                 string
	OrgID              string
	EventID            string
	ProcessedArticleID string
	ProcessedItemID    *string
	Similarity         *float64
	AssignedBy         string
	CreatedAt          time.Time
}

// errNoNewsEvent reports a vanished NewsEvent row.
var errNoNewsEvent = errors.New("newsnowclusteringops: news event not found")

// normalizeSentimentLabel mirrors the NestJS normalizeSentimentLabel helper.
func normalizeSentimentLabel(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.ToLower(strings.TrimSpace(*value))
	switch normalized {
	case "positive", "neutral", "negative":
		return &normalized
	default:
		return nil
	}
}

// nullStringPointer converts a nullable text column to a trimmed pointer.
func nullStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	trimmed := strings.TrimSpace(value.String)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// newPrismaID generates an identifier with the same shape as a Prisma cuid:
// the letter "c" followed by 24 hexadecimal characters.
func newPrismaID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// clampIntRaw applies the NestJS clampInt helper to a JSON value that may be a
// number or a numeric string.
func clampIntRaw(raw json.RawMessage, min, max, fallback int) int {
	value, ok := rawNumber(raw)
	if !ok {
		return fallback
	}
	rounded := int(math.Round(value))
	if rounded < min {
		return min
	}
	if rounded > max {
		return max
	}
	return rounded
}

// clampFloatRaw applies the NestJS clampFloat helper (clamp without rounding).
func clampFloatRaw(raw json.RawMessage, min, max, fallback float64) float64 {
	value, ok := rawNumber(raw)
	if !ok {
		return fallback
	}
	if math.IsNaN(value) {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// boolRaw reads a stored boolean, falling back when the value is not a boolean.
func boolRaw(raw json.RawMessage, fallback bool) bool {
	if len(raw) == 0 {
		return fallback
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	return value
}

// rawNumber accepts a finite JSON number or a non-empty numeric string, exactly
// like the NestJS toNumber helper.
func rawNumber(raw json.RawMessage) (float64, bool) {
	trimmedNull := strings.TrimSpace(string(raw))
	if len(raw) == 0 {
		return 0, false
	}
	// JavaScript's toNumber rejects null; Go's json.Unmarshal would treat it as
	// a no-op and hand back 0, which would override the caller's fallback.
	if trimmedNull == "null" {
		return 0, false
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		if math.IsInf(number, 0) || math.IsNaN(number) {
			return 0, false
		}
		return number, true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) {
		return 0, false
	}
	return parsed, true
}

// sortStrings sorts a string slice ascending in place.
func sortStrings(values []string) {
	sort.Strings(values)
}
