package newseventsingest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Collection names are the Mongoose defaults: ProcessedItem -> processeditems,
// TaskLog -> tasklogs, NewsEventClusteringFailure -> newseventclusteringfailures.
const (
	processedItemsCollection     = "processeditems"
	clusteringFailuresCollection = "newseventclusteringfailures"
	taskLogsCollection           = "tasklogs"
)

// Fixed limits mirrored from the NestJS constants.
const (
	// newsEventStatusActive is the only NewsEvent.status the assignment reads.
	newsEventStatusActive = "active"
	// processedArticleStatusCompleted is the only ProcessedArticle.status the
	// ingestion batch reads.
	processedArticleStatusCompleted = "completed"
	// candidateEventsLimit is DEFAULT_CANDIDATE_EVENTS_LIMIT.
	candidateEventsLimit = 30
	// vectorSearchLimit is DEFAULT_VECTOR_SEARCH_LIMIT.
	vectorSearchLimit = 50
	// mysqlDuplicateEntry is MySQL's unique-constraint error code; Prisma
	// reports the same condition as P2002.
	mysqlDuplicateEntry = 1062
)

// errNoNewsEvent reports a vanished NewsEvent row.
var errNoNewsEvent = errors.New("newseventsingest: news event not found")

// store owns every MySQL and Mongo access of the ingestion chain.
type store struct {
	db    *sql.DB
	mongo *mongo.Database
}

// ingestionState is the NewsEventIngestionState row of one organization.
type ingestionState struct {
	LastProcessedAt        *time.Time
	LastProcessedArticleID *string
}

// processedItemLeaf is the ProcessedItem projection the batch prefetch reads:
// the classification/diagnostics result plus the summary vector (O1).
type processedItemLeaf struct {
	Result                jsonLeaf
	SummaryEmbedding      jsonLeaf
	SummaryEmbeddingModel jsonLeaf
}

// summaryVector is a usable summary embedding: every element numeric and a
// non-blank model name.
type summaryVector struct {
	Embedding []float64
	Model     string
}

// eventRecord is one NewsEvent row the assignment reads.
type eventRecord struct {
	ID            string
	Language      *string
	PrimaryTopic  *string
	PrimaryEntity *string
	MetadataJSON  []byte
	StartAt       time.Time
	LastAt        time.Time
}

// membership is one (processedItemId -> eventId) projection of NewsEventItem.
type membership struct {
	EventID         string
	ProcessedItemID *string
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

// newPrismaID generates an identifier with the same shape as a Prisma cuid: the
// letter "c" followed by 24 hexadecimal characters.
func newPrismaID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// loadOrCreateIngestionState reads the cursor row, creating it when absent.
// createdAt/updatedAt have no database default in the Prisma migration, so both
// are always supplied.
func (s *store) loadOrCreateIngestionState(ctx context.Context, orgID string, now time.Time) (ingestionState, error) {
	state, found, err := s.loadIngestionState(ctx, orgID)
	if err != nil || found {
		return state, err
	}
	id, err := newPrismaID()
	if err != nil {
		return ingestionState{}, err
	}
	_, err = s.db.ExecContext(ctx,
		"INSERT INTO `NewsEventIngestionState` (`id`, `orgId`, `lastProcessedAt`, `lastProcessedArticleId`, `createdAt`, `updatedAt`)"+
			" VALUES (?, ?, NULL, NULL, ?, ?)",
		id, orgID, now, now)
	return ingestionState{}, err
}

// loadIngestionState reads the cursor row of one organization.
func (s *store) loadIngestionState(ctx context.Context, orgID string) (ingestionState, bool, error) {
	var lastProcessedAt sql.NullTime
	var lastProcessedArticleID sql.NullString
	err := s.db.QueryRowContext(ctx,
		"SELECT `lastProcessedAt`, `lastProcessedArticleId` FROM `NewsEventIngestionState` WHERE `orgId` = ? LIMIT 1",
		orgID).Scan(&lastProcessedAt, &lastProcessedArticleID)
	if errors.Is(err, sql.ErrNoRows) {
		return ingestionState{}, false, nil
	}
	if err != nil {
		return ingestionState{}, false, err
	}
	state := ingestionState{}
	if lastProcessedAt.Valid {
		value := truncateMillis(lastProcessedAt.Time)
		state.LastProcessedAt = &value
	}
	if lastProcessedArticleID.Valid {
		value := lastProcessedArticleID.String
		state.LastProcessedArticleID = &value
	}
	return state, true, nil
}

// updateIngestionState advances the cursor. Prisma's @updatedAt is reproduced by
// writing updatedAt explicitly.
func (s *store) updateIngestionState(ctx context.Context, orgID string, processedAt time.Time, articleID string, now time.Time) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE `NewsEventIngestionState` SET `lastProcessedAt` = ?, `lastProcessedArticleId` = ?, `updatedAt` = ?"+
			" WHERE `orgId` = ?",
		truncateMillis(processedAt), articleID, now, orgID)
	return err
}

// ingestionBatchQuery renders the batch predicate. It is a function of its inputs
// so the settle window and the cursor predicate are unit-testable without a
// database.
type ingestionBatchQuery struct {
	SQL  string
	Args []any
}

// buildIngestionBatchQuery mirrors the Prisma where clause of
// ingestOrg, plus the settle window:
//
//	cursor:   (processedAt > cursor OR (processedAt = cursor AND articleId > cursorId))
//	no cursor: processedAt >= now - backfillDays
//	always:   processedAt <= now - settleMs
//
// The upper bound is the B1 fix: processedAt is assigned when the pipeline's
// interactive transaction upserts the ProcessedArticle, and that transaction
// commits later. Without the bound, a late commit whose processedAt is older
// than an already processed row would never be read again.
func buildIngestionBatchQuery(orgID string, state ingestionState, baselineStartAt time.Time, settleCutoff time.Time, limit int) ingestionBatchQuery {
	var builder strings.Builder
	builder.WriteString("SELECT pa.`id`, pa.`articleId`, pa.`processedAt`, pa.`publishedAt`, pa.`language`,")
	builder.WriteString(" pa.`title`, pa.`summary`, pa.`category`, pa.`topics`, pa.`entities`,")
	builder.WriteString(" pa.`qualityScore`, pa.`cleanedMarkdownRef`, a.`crawlAt`")
	builder.WriteString(" FROM `ProcessedArticle` pa LEFT JOIN `Article` a ON a.`id` = pa.`articleId`")
	builder.WriteString(" WHERE pa.`orgId` = ? AND pa.`status` = ? AND pa.`processedAt` <= ?")
	args := []any{orgID, processedArticleStatusCompleted, truncateMillis(settleCutoff)}
	if state.LastProcessedAt != nil {
		builder.WriteString(" AND (pa.`processedAt` > ? OR (pa.`processedAt` = ? AND pa.`articleId` > ?))")
		cursorID := ""
		if state.LastProcessedArticleID != nil {
			cursorID = *state.LastProcessedArticleID
		}
		cursor := truncateMillis(*state.LastProcessedAt)
		args = append(args, cursor, cursor, cursorID)
	} else {
		builder.WriteString(" AND pa.`processedAt` >= ?")
		args = append(args, truncateMillis(baselineStartAt))
	}
	builder.WriteString(" ORDER BY pa.`processedAt` ASC, pa.`articleId` ASC LIMIT ?")
	args = append(args, limit)
	return ingestionBatchQuery{SQL: builder.String(), Args: args}
}

// listProcessedArticles runs the batch query.
func (s *store) listProcessedArticles(ctx context.Context, query ingestionBatchQuery) ([]ProcessedArticleRecord, error) {
	rows, err := s.db.QueryContext(ctx, query.SQL, query.Args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	records := make([]ProcessedArticleRecord, 0, 16)
	for rows.Next() {
		var record ProcessedArticleRecord
		var processedAt time.Time
		var publishedAt, crawlAt sql.NullTime
		var language, title, summary, category, cleanedMarkdownRef sql.NullString
		var topics, entities []byte
		var qualityScore sql.NullFloat64
		if err := rows.Scan(
			&record.ID, &record.ArticleID, &processedAt, &publishedAt, &language,
			&title, &summary, &category, &topics, &entities,
			&qualityScore, &cleanedMarkdownRef, &crawlAt,
		); err != nil {
			return nil, err
		}
		value := truncateMillis(processedAt)
		record.ProcessedAt = &value
		if publishedAt.Valid {
			published := truncateMillis(publishedAt.Time)
			record.PublishedAt = &published
		}
		if crawlAt.Valid {
			crawled := truncateMillis(crawlAt.Time)
			record.ArticleCrawlAt = &crawled
		}
		record.Language = nullStringPointer(language)
		record.Title = nullStringPointer(title)
		record.Summary = nullStringPointer(summary)
		record.Category = nullStringPointer(category)
		record.CleanedMarkdownRef = nullStringPointer(cleanedMarkdownRef)
		record.TopicsJSON = topics
		record.EntitiesJSON = entities
		if qualityScore.Valid {
			score := qualityScore.Float64
			record.QualityScore = &score
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

// batchProcessedItemIDs mirrors the NestJS de-duplication: the JS-trimmed
// cleanedMarkdownRef of every batch entry, blank entries dropped, first
// occurrence kept.
func batchProcessedItemIDs(batch []ProcessedArticleRecord) []string {
	ids := make([]string, 0, len(batch))
	seen := make(map[string]struct{}, len(batch))
	for _, record := range batch {
		normalized := jsNormalizeOptionalString(record.CleanedMarkdownRef)
		if normalized == nil {
			continue
		}
		if _, duplicate := seen[*normalized]; duplicate {
			continue
		}
		seen[*normalized] = struct{}{}
		ids = append(ids, *normalized)
	}
	return ids
}

// loadProcessedItemLeaves reads {_id, result, summaryEmbedding,
// summaryEmbeddingModel} for the batch in one $in query (O1).
//
// A non-ObjectId id fails the whole read, exactly like the Mongoose cast error
// the NestJS find() raises; callers treat the failure with the semantics of the
// mode they are in.
func (s *store) loadProcessedItemLeaves(ctx context.Context, ids []string) (map[string]processedItemLeaf, error) {
	leaves := make(map[string]processedItemLeaf, len(ids))
	if len(ids) == 0 {
		return leaves, nil
	}
	if s.mongo == nil {
		return leaves, nil
	}
	objectIDs := make([]bson.ObjectID, 0, len(ids))
	for _, raw := range ids {
		trimmed := strings.TrimSpace(raw)
		objectID, err := bson.ObjectIDFromHex(trimmed)
		if err != nil {
			// Mongoose fails the whole query on an uncastable _id; returning an
			// error here keeps that behaviour instead of silently dropping one
			// document.
			return nil, err
		}
		objectIDs = append(objectIDs, objectID)
	}

	projection := options.Find().SetProjection(bson.D{
		{Key: "_id", Value: 1},
		{Key: "result", Value: 1},
		{Key: "summaryEmbedding", Value: 1},
		{Key: "summaryEmbeddingModel", Value: 1},
	})
	cursor, err := s.mongo.Collection(processedItemsCollection).Find(ctx,
		bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: objectIDs}}}}, projection)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()

	for cursor.Next(ctx) {
		var row struct {
			ID                    bson.ObjectID `bson:"_id"`
			Result                jsonLeaf      `bson:"result"`
			SummaryEmbedding      jsonLeaf      `bson:"summaryEmbedding"`
			SummaryEmbeddingModel jsonLeaf      `bson:"summaryEmbeddingModel"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if row.ID.IsZero() {
			continue
		}
		leaves[row.ID.Hex()] = processedItemLeaf{
			Result:                row.Result,
			SummaryEmbedding:      row.SummaryEmbedding,
			SummaryEmbeddingModel: row.SummaryEmbeddingModel,
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return leaves, nil
}

// summaryVector resolves the cached summary embedding of one leaf the way
// tryResolveSummaryEmbedding does: the array must be non-empty, every element
// must be a number and the model name must be a non-blank string.
func (leaf processedItemLeaf) summaryVector() *summaryVector {
	elements, ok := jsonArrayElements(leaf.SummaryEmbedding)
	if !ok || len(elements) == 0 {
		return nil
	}
	embedding := make([]float64, 0, len(elements))
	for _, element := range elements {
		value, _, isNumber := jsonNumber(element)
		if !isNumber {
			return nil
		}
		embedding = append(embedding, value)
	}
	model, ok := jsonString(leaf.SummaryEmbeddingModel)
	if !ok {
		return nil
	}
	normalizedModel := jsTrim(model)
	if normalizedModel == "" {
		return nil
	}
	return &summaryVector{Embedding: embedding, Model: normalizedModel}
}

// findNewsEventItem looks up the event a processed article already belongs to.
func (s *store) findNewsEventItem(ctx context.Context, orgID, processedArticleID string) (string, bool, error) {
	var eventID string
	err := s.db.QueryRowContext(ctx,
		"SELECT `eventId` FROM `NewsEventItem` WHERE `orgId` = ? AND `processedArticleId` = ? LIMIT 1",
		orgID, processedArticleID).Scan(&eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(eventID), true, nil
}

// findNewsEventItemTx is the transaction-scoped idempotency lookup.
func findNewsEventItemTx(ctx context.Context, tx *sql.Tx, orgID, processedArticleID string) (string, bool, error) {
	var eventID string
	err := tx.QueryRowContext(ctx,
		"SELECT `eventId` FROM `NewsEventItem` WHERE `orgId` = ? AND `processedArticleId` = ? LIMIT 1",
		orgID, processedArticleID).Scan(&eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(eventID), true, nil
}

// listMemberships reads the (processedItemId -> eventId) projection for the
// matched vector ids. There is deliberately no ORDER BY: the NestJS findMany has
// none either, and the last row for a duplicated processedItemId wins in the
// Map the caller builds.
func (s *store) listMemberships(ctx context.Context, orgID string, processedItemIDs []string) ([]membership, error) {
	if len(processedItemIDs) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(processedItemIDs)), ",")
	query := "SELECT `eventId`, `processedItemId` FROM `NewsEventItem`" +
		" WHERE `orgId` = ? AND `processedItemId` IN (" + placeholders + ")"
	args := make([]any, 0, len(processedItemIDs)+1)
	args = append(args, orgID)
	for _, id := range processedItemIDs {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	memberships := make([]membership, 0, len(processedItemIDs))
	for rows.Next() {
		var row membership
		var processedItemID sql.NullString
		if err := rows.Scan(&row.EventID, &processedItemID); err != nil {
			return nil, err
		}
		row.ProcessedItemID = nullStringPointer(processedItemID)
		memberships = append(memberships, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return memberships, nil
}

// listActiveEventsByIDs reads the active events of one organization by id. No
// order is needed: the caller looks each id up in a map.
func (s *store) listActiveEventsByIDs(ctx context.Context, orgID string, eventIDs []string) (map[string]eventRecord, error) {
	events := make(map[string]eventRecord, len(eventIDs))
	if len(eventIDs) == 0 {
		return events, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(eventIDs)), ",")
	query := "SELECT `id`, `language`, `primaryTopic`, `primaryEntity`, `metadata`, `startAt`, `lastAt`" +
		" FROM `NewsEvent` WHERE `orgId` = ? AND `id` IN (" + placeholders + ") AND `status` = ?"
	args := make([]any, 0, len(eventIDs)+2)
	args = append(args, orgID)
	for _, id := range eventIDs {
		args = append(args, id)
	}
	args = append(args, newsEventStatusActive)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var event eventRecord
		var language, topic, entity sql.NullString
		var metadata []byte
		if err := rows.Scan(&event.ID, &language, &topic, &entity, &metadata, &event.StartAt, &event.LastAt); err != nil {
			return nil, err
		}
		event.Language = nullStringPointer(language)
		event.PrimaryTopic = nullStringPointer(topic)
		event.PrimaryEntity = nullStringPointer(entity)
		event.MetadataJSON = metadata
		events[event.ID] = event
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

// findActiveEvent reads one active event of the organization, which is the
// target-event check assignNewsSignalToSpecificEventWithSettings performs.
func (s *store) findActiveEvent(ctx context.Context, orgID, eventID string) (eventRecord, bool, error) {
	var event eventRecord
	var language, topic, entity sql.NullString
	var metadata []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT `id`, `language`, `primaryTopic`, `primaryEntity`, `metadata`, `startAt`, `lastAt`"+
			" FROM `NewsEvent` WHERE `orgId` = ? AND `id` = ? AND `status` = ? LIMIT 1",
		orgID, eventID, newsEventStatusActive).Scan(
		&event.ID, &language, &topic, &entity, &metadata, &event.StartAt, &event.LastAt)
	if errors.Is(err, sql.ErrNoRows) {
		return eventRecord{}, false, nil
	}
	if err != nil {
		return eventRecord{}, false, err
	}
	event.Language = nullStringPointer(language)
	event.PrimaryTopic = nullStringPointer(topic)
	event.PrimaryEntity = nullStringPointer(entity)
	event.MetadataJSON = metadata
	return event, true, nil
}

// listOverlapCandidates reads the active events whose primaryTopic or
// primaryEntity equals the derived signal, inside the lookback window, newest
// first.
//
// The SQL equality uses the MySQL column collation (case-insensitive), while the
// caller re-checks the match with a case-sensitive comparison. That asymmetry is
// intentional: it reproduces the NestJS behaviour exactly.
func (s *store) listOverlapCandidates(ctx context.Context, orgID string, since time.Time, primaryTopic, primaryEntity string) ([]eventRecord, error) {
	if primaryTopic == "" && primaryEntity == "" {
		return nil, nil
	}
	query := "SELECT `id`, `language`, `primaryTopic`, `primaryEntity`, `metadata`, `startAt`, `lastAt`" +
		" FROM `NewsEvent` WHERE `orgId` = ? AND `status` = ? AND `lastAt` >= ?" +
		" AND ((? <> '' AND `primaryTopic` = ?) OR (? <> '' AND `primaryEntity` = ?))" +
		" ORDER BY `lastAt` DESC, `startAt` DESC LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query,
		orgID, newsEventStatusActive, truncateMillis(since),
		primaryTopic, primaryTopic, primaryEntity, primaryEntity, candidateEventsLimit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	candidates := make([]eventRecord, 0, candidateEventsLimit)
	for rows.Next() {
		var candidate eventRecord
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

// insertNewsEventTx inserts one NewsEvent row inside a transaction.
func insertNewsEventTx(ctx context.Context, tx *sql.Tx, event newsEventInsert) error {
	_, err := tx.ExecContext(ctx,
		"INSERT INTO `NewsEvent` (`id`, `orgId`, `status`, `language`, `primaryTopic`, `primaryEntity`, `title`, `summary`,"+
			" `startAt`, `lastAt`, `representativeProcessedArticleId`, `representativeProcessedItemId`, `metadata`, `createdAt`, `updatedAt`)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		event.ID, event.OrgID, newsEventStatusActive, event.Language, event.PrimaryTopic, event.PrimaryEntity,
		event.Title, event.Summary, event.StartAt, event.LastAt, event.RepresentativeProcessedArticleID,
		event.RepresentativeProcessedItemID, event.MetadataJSON, event.CreatedAt, event.UpdatedAt)
	return err
}

// insertNewsEventItemTx inserts one NewsEventItem row inside a transaction.
func insertNewsEventItemTx(ctx context.Context, tx *sql.Tx, item newsEventItemInsert) error {
	_, err := tx.ExecContext(ctx,
		"INSERT INTO `NewsEventItem` (`id`, `orgId`, `eventId`, `processedArticleId`, `processedItemId`, `similarity`, `assignedBy`, `createdAt`)"+
			" VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		item.ID, item.OrgID, item.EventID, item.ProcessedArticleID, item.ProcessedItemID,
		item.Similarity, item.AssignedBy, item.CreatedAt)
	return err
}

// loadEventWindowTx reads an event window inside a transaction.
func loadEventWindowTx(ctx context.Context, tx *sql.Tx, eventID string) (time.Time, time.Time, error) {
	var startAt, lastAt time.Time
	err := tx.QueryRowContext(ctx,
		"SELECT `startAt`, `lastAt` FROM `NewsEvent` WHERE `id` = ? LIMIT 1", eventID).Scan(&startAt, &lastAt)
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
		"UPDATE `NewsEvent` SET `startAt` = ?, `lastAt` = ?, `updatedAt` = ? WHERE `id` = ?",
		startAt, lastAt, updatedAt, eventID)
	return err
}

// insertTaskLogs writes one batch of TaskLog documents with ordered:false, like
// TaskLogModel.insertMany([...logs], { ordered: false }). The caller treats a
// failure as a warning.
func (s *store) insertTaskLogs(ctx context.Context, documents []taskLogDocument) error {
	if len(documents) == 0 {
		return nil
	}
	if s.mongo == nil {
		return errNoMongo
	}
	payload := make([]any, 0, len(documents))
	for _, document := range documents {
		value := document
		payload = append(payload, value)
	}
	_, err := s.mongo.Collection(taskLogsCollection).InsertMany(ctx, payload, options.InsertMany().SetOrdered(false))
	return err
}

// insertTaskLog writes one TaskLog document.
func (s *store) insertTaskLog(ctx context.Context, document taskLogDocument) error {
	if s.mongo == nil {
		return errNoMongo
	}
	_, err := s.mongo.Collection(taskLogsCollection).InsertOne(ctx, document)
	return err
}

// errNoMongo reports a missing Mongo connection on a Mongo-only write.
var errNoMongo = errors.New("newseventsingest: mongo is not configured")

// nullStringPointer maps a scanned NULL string to nil and an empty string to
// nil, like the Prisma client returning null.
func nullStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

// stringPointerOrNil returns a pointer to a non-empty string, else nil.
func stringPointerOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// isoMillis renders a timestamp the way Date.prototype.toISOString does.
func isoMillis(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// truncateMillis truncates a timestamp to millisecond precision, which is what
// every DateTime(3) column stores.
func truncateMillis(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

// isDuplicateEntry reports a MySQL unique constraint violation (Prisma P2002).
func isDuplicateEntry(err error) bool {
	var mysqlError *mysqlDriver.MySQLError
	if errors.As(err, &mysqlError) {
		return mysqlError.Number == mysqlDuplicateEntry
	}
	return false
}
