package newsnowclusteringops

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Mongoose derives collection names from the model name, so RawItem,
// ProcessedItem, TaskLog and NewsEventClusteringFailure live in these
// collections.
const (
	rawItemsCollection           = "rawitems"
	processedItemsCollection     = "processeditems"
	clusteringFailuresCollection = "newseventclusteringfailures"
	taskLogsCollection           = "tasklogs"
)

// rawItemDoc is the projected rawitems document used by the URL resolver. The
// bson tags mirror the NestJS projection { itemMetaId, payload.url, createdAt }.
type rawItemDoc struct {
	ItemMetaID string `bson:"itemMetaId"`
	Payload    struct {
		URL string `bson:"url"`
	} `bson:"payload"`
	CreatedAt time.Time `bson:"createdAt"`
}

// mongoResolveStore implements resolveStore against the Mongo rawitems
// collection plus the shared MySQL pool.
type mongoResolveStore struct {
	mongo *mongo.Database
	db    *sql.DB
}

// newMongoResolveStore builds the resolve store.
func newMongoResolveStore(database *mongo.Database, db *sql.DB) *mongoResolveStore {
	return &mongoResolveStore{mongo: database, db: db}
}

// rawItemProjection selects exactly the fields the resolver reads.
func rawItemProjection() bson.D {
	return bson.D{
		{Key: "itemMetaId", Value: 1},
		{Key: "payload.url", Value: 1},
		{Key: "createdAt", Value: 1},
	}
}

// findNewestRawItem runs one newest-first lookup and maps ErrNoDocuments to a
// nil row.
func (s *mongoResolveStore) findNewestRawItem(ctx context.Context, filter bson.D) (*resolveRawRow, error) {
	var doc rawItemDoc
	err := s.mongo.Collection(rawItemsCollection).FindOne(ctx, filter, options.FindOne().
		SetProjection(rawItemProjection()).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &resolveRawRow{
		ItemMetaID: strings.TrimSpace(doc.ItemMetaID),
		PayloadURL: doc.Payload.URL,
		CreatedAt:  doc.CreatedAt,
	}, nil
}

// FindRawItemByFullHashAndFull implements match level 1: the comparable full
// URL together with its hash.
func (s *mongoResolveStore) FindRawItemByFullHashAndFull(ctx context.Context, fullHash, full string) (*resolveRawRow, error) {
	return s.findNewestRawItem(ctx, bson.D{
		{Key: "urlComparableFullHash", Value: fullHash},
		{Key: "urlComparableFull", Value: full},
	})
}

// FindRawItemByFull implements match level 2, for rows written before the
// comparable hash column was backfilled.
func (s *mongoResolveStore) FindRawItemByFull(ctx context.Context, full string) (*resolveRawRow, error) {
	return s.findNewestRawItem(ctx, bson.D{{Key: "urlComparableFull", Value: full}})
}

// FindRawItemByPayloadURL implements match level 3.
func (s *mongoResolveStore) FindRawItemByPayloadURL(ctx context.Context, candidates []string) (*resolveRawRow, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	var filter bson.D
	if len(candidates) == 1 {
		filter = bson.D{{Key: "payload.url", Value: candidates[0]}}
	} else {
		filter = bson.D{{Key: "payload.url", Value: bson.D{{Key: "$in", Value: candidates}}}}
	}
	return s.findNewestRawItem(ctx, filter)
}

// FindRawItemByBase implements match level 4: the comparable base URL with the
// query string dropped.
func (s *mongoResolveStore) FindRawItemByBase(ctx context.Context, base string) (*resolveRawRow, error) {
	return s.findNewestRawItem(ctx, bson.D{{Key: "urlComparableBase", Value: base}})
}

// FindRawItemByPayloadURLPattern implements match level 5, the case-insensitive
// prefix regex over payload.url.
func (s *mongoResolveStore) FindRawItemByPayloadURLPattern(ctx context.Context, pattern string) (*resolveRawRow, error) {
	return s.findNewestRawItem(ctx, bson.D{{Key: "payload.url", Value: bson.D{
		{Key: "$regex", Value: pattern},
		{Key: "$options", Value: "i"},
	}}})
}

// FindItemMetaOrgID reads the owning organization of an ItemMeta row. This is
// the tenant binding that fixes the cross-tenant leak of the NestJS original:
// a deleted ItemMeta yields "not found" and every downstream lookup is scoped
// to the returned organization.
func (s *mongoResolveStore) FindItemMetaOrgID(ctx context.Context, itemMetaID string) (string, bool, error) {
	var orgID string
	err := s.db.QueryRowContext(ctx,
		"SELECT orgId FROM ItemMeta WHERE id = ? LIMIT 1", itemMetaID).Scan(&orgID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(orgID), true, nil
}

// FindCompletedProcessedItemIDs returns the newest completed ProcessedItem ids
// of one organization that reference itemMetaID, mirroring the NestJS query
// { itemMetaId, status: "completed" } plus orgId scoping.
func (s *mongoResolveStore) FindCompletedProcessedItemIDs(ctx context.Context, orgID, itemMetaID string) ([]string, error) {
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: itemMetaID},
		{Key: "status", Value: "completed"},
	}
	cursor, err := s.mongo.Collection(processedItemsCollection).Find(ctx, filter, options.Find().
		SetProjection(bson.D{{Key: "_id", Value: 1}}).
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetLimit(resolveProcessedItemLimit),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()

	ids := make([]string, 0, resolveProcessedItemLimit)
	for cursor.Next(ctx) {
		var row struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if row.ID.IsZero() {
			continue
		}
		ids = append(ids, row.ID.Hex())
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// FindLatestEventID returns the newest NewsEventItem.eventId of one
// organization linked to any of processedItemIDs.
//
// NestJS issues a single `processedItemId IN (...)` query ordered by createdAt
// descending. This implementation performs one indexed lookup per id instead,
// because database/sql only exposes a variadic argument list and this package
// deliberately avoids untyped slices. The arity is bounded by
// resolveProcessedItemLimit (20) and each lookup uses the
// (orgId, processedItemId) index, so the cost stays bounded.
func (s *mongoResolveStore) FindLatestEventID(ctx context.Context, orgID string, processedItemIDs []string) (string, error) {
	bestEventID := ""
	var bestCreatedAt time.Time
	for _, processedItemID := range processedItemIDs {
		var eventID string
		var createdAt time.Time
		err := s.db.QueryRowContext(ctx,
			"SELECT eventId, createdAt FROM NewsEventItem WHERE orgId = ? AND processedItemId = ? ORDER BY createdAt DESC LIMIT 1",
			orgID, processedItemID).Scan(&eventID, &createdAt)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return "", err
		}
		trimmed := strings.TrimSpace(eventID)
		if trimmed == "" {
			continue
		}
		if bestEventID == "" || createdAt.After(bestCreatedAt) {
			bestEventID = trimmed
			bestCreatedAt = createdAt
		}
	}
	return bestEventID, nil
}

// redisResolveCache adapts *redis.Client to the resolveCache interface.
type redisResolveCache struct {
	client *redis.Client
}

// newRedisResolveCache builds the cache adapter. A nil client yields a no-op
// cache so the resolver stays usable in tests and in degraded deployments.
func newRedisResolveCache(client *redis.Client) *redisResolveCache {
	return &redisResolveCache{client: client}
}

// Get reads one cache entry. A missing key is reported as a miss, not an error.
func (c *redisResolveCache) Get(ctx context.Context, key string) ([]byte, bool, error) {
	if c == nil || c.client == nil {
		return nil, false, nil
	}
	value, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

// Set writes one cache entry with a second-granularity TTL.
func (c *redisResolveCache) Set(ctx context.Context, key string, value []byte, ttlSeconds int) error {
	if c == nil || c.client == nil {
		return nil
	}
	if ttlSeconds <= 0 {
		ttlSeconds = 1
	}
	return c.client.Set(ctx, key, value, time.Duration(ttlSeconds)*time.Second).Err()
}
