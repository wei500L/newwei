package itemsreading

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// ResolveDuplicateItemMetaID resolves a stored ProcessedItem.duplicateOf
// reference to the target item's ItemMeta id. The lookup is organization
// scoped, so a reference that points at another organization (or at a deleted
// document) resolves to nil instead of leaking a foreign id.
func (s *mongoStore) ResolveDuplicateItemMetaID(
	ctx context.Context,
	orgID string,
	duplicateOf bson.ObjectID,
) (*string, error) {
	if duplicateOf.IsZero() {
		return nil, nil
	}
	var row struct {
		ItemMetaID string `bson:"itemMetaId"`
	}
	err := s.processedItems().FindOne(ctx, bson.D{
		{Key: "_id", Value: duplicateOf},
		{Key: "orgId", Value: orgID},
	}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(row.ItemMetaID)
	if trimmed == "" {
		return nil, nil
	}
	return &trimmed, nil
}

// EventIDForProcessedItem ports ProcessedItemEventIdLoader: the direct
// NewsEventItem.processedItemId link first (newest membership wins), then the
// ProcessedArticle.cleanedMarkdownRef -> NewsEventItem.processedArticleId
// fallback. Both chains carry orgId. NestJS relies on the database's natural
// order for the fallback joins; this port fixes a deterministic tie-break
// (createdAt DESC, id DESC) and documents it as a deliberate difference.
func (s *mySQLStore) EventIDForProcessedItem(
	ctx context.Context,
	orgID string,
	processedItemID string,
) (*string, error) {
	normalized := strings.TrimSpace(processedItemID)
	if normalized == "" || s == nil || s.db == nil {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT processedItemId, eventId
FROM NewsEventItem
WHERE orgId = ? AND processedItemId = ?
ORDER BY createdAt DESC, id DESC`, orgID, normalized)
	if err != nil {
		return nil, err
	}
	direct := ""
	for rows.Next() {
		var processedID string
		var eventID string
		if err := rows.Scan(&processedID, &eventID); err != nil {
			rows.Close()
			return nil, err
		}
		if strings.TrimSpace(processedID) == normalized && direct == "" {
			direct = strings.TrimSpace(eventID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if direct != "" {
		return &direct, nil
	}

	// Fallback: processedItemId -> ProcessedArticle.id via cleanedMarkdownRef,
	// then ProcessedArticle.id -> NewsEventItem.eventId.
	var processedArticleID string
	err = s.db.QueryRowContext(ctx, `
SELECT pa.id
FROM ProcessedArticle pa
INNER JOIN Article a ON a.id = pa.articleId
WHERE a.orgId = ? AND pa.cleanedMarkdownRef = ?
ORDER BY pa.id DESC
LIMIT 1`, orgID, normalized).Scan(&processedArticleID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var eventID string
	err = s.db.QueryRowContext(ctx, `
SELECT eventId
FROM NewsEventItem
WHERE orgId = ? AND processedArticleId = ?
ORDER BY createdAt DESC, id DESC
LIMIT 1`, orgID, processedArticleID).Scan(&eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(eventID)
	if trimmed == "" {
		return nil, nil
	}
	return &trimmed, nil
}

// ResolveDuplicateOfHex exposes the duplicateOf resolution to the GraphQL
// adapter. The argument is the stored ProcessedItem ObjectId hex string.
func (s *Service) ResolveDuplicateOfHex(ctx context.Context, orgID string, duplicateOfHex string) (*string, error) {
	trimmed := strings.TrimSpace(duplicateOfHex)
	if trimmed == "" || !isValidObjectIDHex(trimmed) {
		return nil, nil
	}
	objectID, err := bson.ObjectIDFromHex(trimmed)
	if err != nil {
		return nil, nil
	}
	return s.mongo.ResolveDuplicateItemMetaID(ctx, orgID, objectID)
}

// ResolveEventID exposes the eventId chain to the GraphQL adapter.
func (s *Service) ResolveEventID(ctx context.Context, orgID string, processedItemID string) (*string, error) {
	return s.mysql.EventIDForProcessedItem(ctx, orgID, processedItemID)
}
