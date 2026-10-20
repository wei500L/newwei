package newseventstimeline

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Timeline write/read limits. The bucket batch size keeps one statement well
// below MySQL's placeholder ceiling and bounds the packet size.
const (
	timelineWriteChunkSize    = 200
	classificationLookupChunk = 500
	processedItemsCollection  = "processeditems"
)

var errNoDatabase = errors.New("newseventstimeline: mysql is not configured")

// storeOptions are the storage handles one rebuild needs.
type storeOptions struct {
	DB    *sql.DB
	Mongo *mongo.Database
	Now   func() time.Time
}

// store reads NewsEvent/NewsEventItem/ProcessedArticle/Article and the Mongo
// classification context, and writes the timeline rows plus metadata.timeline.
type store struct {
	db    *sql.DB
	mongo *mongo.Database
	now   func() time.Time
}

func newStore(options storeOptions) *store {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &store{db: options.DB, mongo: options.Mongo, now: now}
}

func (s *store) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

// selectEvents mirrors the rebuildOrg findMany.
//
// O2: only the id and the metadata.timeline.entries leaf are read. The rest of
// the metadata column (briefV1 and any other generator's leaf) is never loaded,
// which keeps a 50-event run from materializing every brief body, and makes it
// impossible for this package to write back a stale copy of them.
func (s *store) selectEvents(ctx context.Context, orgID string, since time.Time, limit int) ([]eventRow, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx, "SELECT `id`, JSON_EXTRACT(`metadata`, '$.timeline.entries'), "+
		"JSON_TYPE(`metadata`) FROM `NewsEvent` "+
		"WHERE `orgId` = ? AND `status` = 'active' AND `lastAt` >= ? "+
		"ORDER BY `lastAt` DESC, `startAt` DESC LIMIT ?",
		orgID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]eventRow, 0, limit)
	for rows.Next() {
		var row eventRow
		var entries []byte
		var metadataType sql.NullString
		if err := rows.Scan(&row.ID, &entries, &metadataType); err != nil {
			return nil, err
		}
		row.MetadataEntries = json.RawMessage(entries)
		row.MetadataIsObject = metadataType.Valid && metadataType.String == "OBJECT"
		events = append(events, row)
	}
	return events, rows.Err()
}

// itemRow is one joined NewsEventItem row before normalization.
type itemRow struct {
	ProcessedItemID    sql.NullString
	ProcessedArticleID string
	ArticleID          string
	Category           sql.NullString
	Title              sql.NullString
	Summary            sql.NullString
	KeyPoints          []byte
	QualityScore       sql.NullFloat64
	PublishedAt        sql.NullTime
	ProcessedAt        time.Time
	CrawlAt            sql.NullTime
}

// selectEventItems mirrors loadEventItems' findMany: the organization and event
// predicate plus the processedAt window, ordered by NewsEventItem.createdAt
// descending and capped at 5000.
func (s *store) selectEventItems(ctx context.Context, orgID, eventID string, since time.Time) ([]itemRow, error) {
	if s == nil || s.db == nil {
		return nil, errNoDatabase
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT nei.`+"`processedItemId`"+`,
       pa.`+"`id`"+`, pa.`+"`articleId`"+`, pa.`+"`category`"+`, pa.`+"`title`"+`, pa.`+"`summary`"+`,
       pa.`+"`keyPoints`"+`, pa.`+"`qualityScore`"+`, pa.`+"`publishedAt`"+`, pa.`+"`processedAt`"+`,
       a.`+"`crawlAt`"+`
FROM `+"`NewsEventItem`"+` nei
INNER JOIN `+"`ProcessedArticle`"+` pa ON pa.`+"`id`"+` = nei.`+"`processedArticleId`"+`
LEFT JOIN `+"`Article`"+` a ON a.`+"`id`"+` = pa.`+"`articleId`"+`
WHERE nei.`+"`orgId`"+` = ? AND nei.`+"`eventId`"+` = ? AND pa.`+"`processedAt`"+` >= ?
ORDER BY nei.`+"`createdAt`"+` DESC
LIMIT ?`, orgID, eventID, since, maxItemsPerEvent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]itemRow, 0, 64)
	for rows.Next() {
		var row itemRow
		if err := rows.Scan(&row.ProcessedItemID, &row.ProcessedArticleID, &row.ArticleID,
			&row.Category, &row.Title, &row.Summary, &row.KeyPoints, &row.QualityScore,
			&row.PublishedAt, &row.ProcessedAt, &row.CrawlAt); err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	return items, rows.Err()
}

// classificationCache is the per-run classification cache (O3).
//
// NestJS keeps a process-wide 5 minute cache. A per-run cache cannot be older
// than the query that filled it, so every rebuild sees the current Mongo value
// while still collapsing the repeated ids across the events of one organization
// into one $in query per chunk.
type classificationCache struct {
	store *store
	byID  map[string]*processedItemClassification
}

func newClassificationCache(store *store) *classificationCache {
	return &classificationCache{store: store, byID: make(map[string]*processedItemClassification)}
}

// resolve returns the classification for every requested id, using the run cache
// first and one chunked Mongo read for the rest.
func (c *classificationCache) resolve(ctx context.Context, ids []string) (map[string]*processedItemClassification, error) {
	if c == nil || c.store == nil {
		out := make(map[string]*processedItemClassification, len(ids))
		return out, nil
	}
	pending := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		if _, cached := c.byID[id]; cached {
			continue
		}
		pending = append(pending, id)
	}
	if len(pending) > 0 {
		loaded, err := c.store.loadClassifications(ctx, pending)
		if err != nil {
			return nil, err
		}
		for _, id := range pending {
			value, found := loaded[id]
			if !found {
				c.byID[id] = nil
				continue
			}
			c.byID[id] = value
		}
	}
	out := make(map[string]*processedItemClassification, len(ids))
	for _, id := range ids {
		out[id] = c.byID[id]
	}
	return out, nil
}

// loadClassifications reads ProcessedItem.result for the ids that parse as an
// ObjectID, in chunks of 500.
func (s *store) loadClassifications(ctx context.Context, ids []string) (map[string]*processedItemClassification, error) {
	out := make(map[string]*processedItemClassification, len(ids))
	if s == nil || s.mongo == nil || len(ids) == 0 {
		return out, nil
	}
	objectIDs := make([]bson.ObjectID, 0, len(ids))
	byObjectID := make(map[bson.ObjectID]string, len(ids))
	for _, id := range ids {
		objectID, err := bson.ObjectIDFromHex(strings.TrimSpace(id))
		if err != nil {
			// NestJS sends the raw string list to Mongoose, where one uncastable id
			// fails the whole $in with a CastError and every classification for the
			// event degrades to null. Skipping the value keeps the valid ids usable
			// and cannot change a result that had a valid id.
			continue
		}
		if _, exists := byObjectID[objectID]; exists {
			continue
		}
		byObjectID[objectID] = id
		objectIDs = append(objectIDs, objectID)
	}
	if len(objectIDs) == 0 {
		return out, nil
	}
	collection := s.mongo.Collection(processedItemsCollection)
	for start := 0; start < len(objectIDs); start += classificationLookupChunk {
		end := start + classificationLookupChunk
		if end > len(objectIDs) {
			end = len(objectIDs)
		}
		chunk := objectIDs[start:end]
		cursor, err := collection.Find(ctx,
			bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: chunk}}}},
			options.Find().SetProjection(bson.D{
				{Key: "_id", Value: 1},
				{Key: "result", Value: 1},
			}))
		if err != nil {
			return nil, err
		}
		for cursor.Next(ctx) {
			var document struct {
				ID     bson.RawValue `bson:"_id"`
				Result bson.RawValue `bson:"result"`
			}
			if err := cursor.Decode(&document); err != nil {
				_ = cursor.Close(ctx)
				return nil, err
			}
			objectID, ok := document.ID.ObjectIDOK()
			if !ok {
				continue
			}
			sourceID, exists := byObjectID[objectID]
			if !exists {
				continue
			}
			classification := extractClassificationFromResult(document.Result)
			out[sourceID] = classification
		}
		if err := cursor.Err(); err != nil {
			_ = cursor.Close(ctx)
			return nil, err
		}
		if err := cursor.Close(ctx); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// extractClassificationFromResult mirrors extractClassificationFromResult: a
// non-object result has no classification, the snake_case leaf wins over the
// camelCase one, and only numeric confidences are accepted.
func extractClassificationFromResult(value bson.RawValue) *processedItemClassification {
	document, ok := value.DocumentOK()
	if !ok {
		return &processedItemClassification{}
	}
	classification := &processedItemClassification{}
	classification.LegacyCategory = normalizeLegacyCategory(documentString(document, "category"))
	if classification.LegacyCategory == nil {
		classification.LegacyCategory = normalizeLegacyCategory(documentString(document, "legacy_category"))
	}
	classification.CategoryPath = normalizeCategoryPath(documentString(document, "category_path"))
	if classification.CategoryPath == nil {
		classification.CategoryPath = normalizeCategoryPath(documentString(document, "categoryPath"))
	}
	rawConfidence, hasConfidence := documentNumber(document, "category_confidence")
	if !hasConfidence {
		rawConfidence, hasConfidence = documentNumber(document, "categoryConfidence")
	}
	if hasConfidence {
		classification.CategoryConfidence = normalizeConfidence(&rawConfidence)
	}
	return classification
}

// documentString returns the member only when it is a BSON string, matching a
// typeof === "string" check.
func documentString(document bson.Raw, key string) *string {
	value, err := document.LookupErr(key)
	if err != nil {
		return nil
	}
	text, ok := value.StringValueOK()
	if !ok {
		return nil
	}
	return &text
}

// documentNumber returns the member only when it is a BSON numeric value.
func documentNumber(document bson.Raw, key string) (float64, bool) {
	value, err := document.LookupErr(key)
	if err != nil {
		return 0, false
	}
	if number, ok := value.DoubleOK(); ok {
		return number, true
	}
	if number, ok := value.Int32OK(); ok {
		return float64(number), true
	}
	if number, ok := value.Int64OK(); ok {
		return float64(number), true
	}
	return 0, false
}

// upsertTimelineEntries writes one event's buckets with chunked multi-row
// INSERT ... ON DUPLICATE KEY UPDATE (O1).
//
// The final row is the row Prisma's upsert produces: a new bucket gets a fresh
// cuid plus createdAt/updatedAt = now, and a conflicting bucket keeps its id and
// createdAt while title, summary, keyPoints, referencedArticleIds and updatedAt
// are overwritten. Prisma also rewrites updatedAt when the content is unchanged,
// so the conflict branch always sets it.
func (s *store) upsertTimelineEntries(ctx context.Context, orgID string, entries []builtTimelineEntry, now time.Time) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	if len(entries) == 0 {
		return nil
	}
	for start := 0; start < len(entries); start += timelineWriteChunkSize {
		end := start + timelineWriteChunkSize
		if end > len(entries) {
			end = len(entries)
		}
		if err := s.upsertTimelineChunk(ctx, orgID, entries[start:end], now); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) upsertTimelineChunk(ctx context.Context, orgID string, entries []builtTimelineEntry, now time.Time) error {
	// ON DUPLICATE KEY UPDATE is written once for the whole statement and refers to
	// the row being inserted through the "incoming" row alias, so one conflicting
	// bucket receives its own values instead of the last row of the chunk. The
	// VALUES() function that the alias replaces is deprecated in MySQL 8.0.20+.
	var values strings.Builder
	args := make([]any, 0, len(entries)*12)
	values.Grow(len(entries) * 120)
	for index, entry := range entries {
		id, err := newRowID()
		if err != nil {
			return err
		}
		if index > 0 {
			values.WriteString(",")
		}
		values.WriteString("(?,?,?,?,?,?,")
		args = append(args, id, orgID, entry.EventID, entry.BucketStart,
			nullStringValue(entry.Title), nullStringValue(entry.Summary))
		values.WriteString(keyPointsValueSQL(entry, &args))
		values.WriteString(",")
		values.WriteString(referencedArticlesValueSQL(entry, &args))
		values.WriteString(",?,?)")
		args = append(args, now, now)
	}

	query := "INSERT INTO `NewsEventTimelineEntry` " +
		"(`id`,`orgId`,`eventId`,`bucketStart`,`title`,`summary`,`keyPoints`,`referencedArticleIds`,`createdAt`,`updatedAt`) VALUES " +
		values.String() + " AS incoming ON DUPLICATE KEY UPDATE " +
		"`title`=incoming.`title`,`summary`=incoming.`summary`," +
		"`keyPoints`=incoming.`keyPoints`,`referencedArticleIds`=incoming.`referencedArticleIds`," +
		"`updatedAt`=incoming.`updatedAt`"
	_, err := s.db.ExecContext(ctx, query, args...)
	return err
}

// keyPointsValueSQL writes Prisma.DbNull for an absent keyPoints leaf as SQL NULL,
// so a stored JSON null and a missing value stay indistinguishable.
func keyPointsValueSQL(entry builtTimelineEntry, args *[]any) string {
	if len(entry.KeyPoints) == 0 {
		return "NULL"
	}
	*args = append(*args, string(entry.KeyPoints))
	return "CAST(? AS JSON)"
}

// referencedArticlesValueSQL writes Prisma.DbNull for an empty id list.
func referencedArticlesValueSQL(entry builtTimelineEntry, args *[]any) string {
	if len(entry.ReferencedArticleIDs) == 0 {
		return "NULL"
	}
	encoded, err := json.Marshal(entry.ReferencedArticleIDs)
	if err != nil {
		// A []string always marshals, so this branch is unreachable.
		return "NULL"
	}
	*args = append(*args, string(encoded))
	return "CAST(? AS JSON)"
}

// writeEventTimeline writes only metadata.timeline (B1).
//
// The NestJS implementation rebuilds the whole metadata object from the snapshot
// it read at the start of the run and writes it back, which discards a briefV1
// leaf persisted in the meantime by the brief service, the public portal store or
// the Go brief generator. JSON_SET leaves every other metadata leaf untouched, and
// no other writer touches "$.timeline", so the merge this run performed against
// the stored entries stays correct under the organization lease.
//
// A non-object metadata column becomes a fresh object, which is the NestJS result
// for {timeline} when the stored value is an array or a scalar.
func (s *store) writeEventTimeline(ctx context.Context, orgID, eventID string, timeline timelineMetadata, now time.Time) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	payload, err := json.Marshal(timeline)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
UPDATE `+"`NewsEvent`"+`
SET `+"`metadata`"+` = JSON_SET(
      CASE WHEN JSON_TYPE(`+"`metadata`"+`) = 'OBJECT' THEN `+"`metadata`"+` ELSE JSON_OBJECT() END,
      '$.timeline', CAST(? AS JSON)),
    `+"`updatedAt`"+` = ?
WHERE `+"`id`"+` = ? AND `+"`orgId`"+` = ?`,
		string(payload), now, eventID, orgID)
	return err
}

// nullStringValue maps a nullable string column onto a driver argument.
func nullStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// newRowID writes a Prisma cuid-shaped primary key. The column has no database
// default, so a client-side id is required on every insert.
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}
