package kgimpact

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const processedItemsCollection = "processeditems"

// store holds the three read-only backends the four roots need.
type store struct {
	db    *sql.DB
	mongo *mongo.Database
	redis *redis.Client
	now   func() time.Time
}

func (s *store) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

type entityRow struct {
	id            string
	entityType    string
	canonicalName string
	properties    any
}

type edgeRow struct {
	id           string
	edgeType     string
	fromEntityID string
	toEntityID   string
	weight       float64
	confidence   float64
	properties   any
}

func (s *store) selectSystemSetting(ctx context.Context, key string) ([]byte, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, sql.ErrConnDone
	}
	var value []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&value)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

func (s *store) insertSystemSettingIfAbsent(ctx context.Context, key string, value any, description string) error {
	if s == nil || s.db == nil {
		return sql.ErrConnDone
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt) VALUES (?, ?, 0, ?, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE `key` = `key`",
		key, payload, description,
	)
	return err
}

func redisGetBytes(ctx context.Context, client *redis.Client, key string) ([]byte, bool, error) {
	if client == nil {
		return nil, false, nil
	}
	raw, err := client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 {
		return nil, false, nil
	}
	return raw, true, nil
}

func redisSetJSON(ctx context.Context, client *redis.Client, key string, value any, ttl time.Duration) error {
	if client == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return client.Set(ctx, key, raw, ttl).Err()
}

// jsonValue turns a nullable MySQL JSON column into a JSON scalar value. The
// executor re-encodes json.RawMessage, so a stored object stays an object.
func jsonValue(raw []byte) any {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	return json.RawMessage(append([]byte(nil), raw...))
}

func scanEntity(scanner interface{ Scan(...any) error }, out *entityRow) error {
	var id, entityType, canonicalName sql.NullString
	var properties []byte
	if err := scanner.Scan(&id, &entityType, &canonicalName, &properties); err != nil {
		return err
	}
	out.id = id.String
	out.entityType = entityType.String
	out.canonicalName = canonicalName.String
	out.properties = jsonValue(properties)
	return nil
}

const entityColumns = "id, type, canonicalName, properties"

// loadEntityList loads org-scoped entities in database row order. The orgId
// predicate is the cross-tenant guard added alongside the Nest fix: a dirty
// edge that points at another org's entity must not pull that entity into the
// impact chain.
func (s *store) loadEntityList(ctx context.Context, orgID string, ids []string) ([]entityRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	query := "SELECT " + entityColumns + " FROM KnowledgeEntity WHERE orgId = ? AND id IN (" + placeholders(len(ids)) + ")"
	args := make([]any, 0, len(ids)+1)
	args = append(args, orgID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]entityRow, 0)
	for rows.Next() {
		var entity entityRow
		if err := scanEntity(rows, &entity); err != nil {
			return nil, err
		}
		out = append(out, entity)
	}
	return out, rows.Err()
}

func (s *store) loadEntitiesByIDs(ctx context.Context, orgID string, ids []string) (map[string]entityRow, error) {
	out := map[string]entityRow{}
	list, err := s.loadEntityList(ctx, orgID, ids)
	if err != nil {
		return nil, err
	}
	for _, entity := range list {
		out[entity.id] = entity
	}
	return out, nil
}

func scanEdges(rows *sql.Rows) ([]edgeRow, error) {
	out := make([]edgeRow, 0)
	for rows.Next() {
		var id, edgeType, fromID, toID sql.NullString
		var weight, confidence sql.NullFloat64
		var properties []byte
		if err := rows.Scan(&id, &edgeType, &fromID, &toID, &weight, &confidence, &properties); err != nil {
			return nil, err
		}
		out = append(out, edgeRow{
			id:           id.String,
			edgeType:     edgeType.String,
			fromEntityID: fromID.String,
			toEntityID:   toID.String,
			weight:       weight.Float64,
			confidence:   confidence.Float64,
			properties:   jsonValue(properties),
		})
	}
	return out, rows.Err()
}

const edgeColumns = "id, type, fromEntityId, toEntityId, weight, confidence, properties"

// findRelatedEntities mirrors KnowledgeGraphImpactService.findRelatedEntities.
func (s *store) findRelatedEntities(ctx context.Context, orgID, seedID string, relationTypes []string, limit int) ([]edgeRow, map[string]entityRow, error) {
	query := "SELECT " + edgeColumns + " FROM KnowledgeEdge WHERE orgId = ? AND type IN (" + placeholders(len(relationTypes)) + ") AND (fromEntityId = ? OR toEntityId = ?) ORDER BY confidence DESC, weight DESC, updatedAt DESC LIMIT ?"
	args := make([]any, 0, len(relationTypes)+4)
	args = append(args, orgID)
	for _, relation := range relationTypes {
		args = append(args, relation)
	}
	args = append(args, seedID, seedID, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	edges, err := scanEdges(rows)
	if err != nil {
		return nil, nil, err
	}

	ids := map[string]struct{}{seedID: {}}
	for _, edge := range edges {
		ids[edge.fromEntityID] = struct{}{}
		ids[edge.toEntityID] = struct{}{}
	}
	idList := make([]string, 0, len(ids))
	for id := range ids {
		idList = append(idList, id)
	}
	nodes, err := s.loadEntitiesByIDs(ctx, orgID, idList)
	if err != nil {
		return nil, nil, err
	}
	return edges, nodes, nil
}

// loadIndustryMembership mirrors the knowledgeEdge.findMany that finds
// belongs_to_industry edges touching any impacted industry.
func (s *store) loadIndustryMembership(ctx context.Context, orgID string, industryIDs []string, take int) ([]edgeRow, error) {
	if len(industryIDs) == 0 {
		return nil, nil
	}
	query := "SELECT " + edgeColumns + " FROM KnowledgeEdge WHERE orgId = ? AND type = ? AND (fromEntityId IN (" + placeholders(len(industryIDs)) + ") OR toEntityId IN (" + placeholders(len(industryIDs)) + ")) ORDER BY weight DESC, confidence DESC, updatedAt DESC LIMIT ?"
	args := make([]any, 0, len(industryIDs)*2+3)
	args = append(args, orgID, "belongs_to_industry")
	for _, id := range industryIDs {
		args = append(args, id)
	}
	for _, id := range industryIDs {
		args = append(args, id)
	}
	args = append(args, take)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEdges(rows)
}

// loadHasTickerEdges mirrors resolveCompanySeed's has_ticker lookup.
func (s *store) loadHasTickerEdges(ctx context.Context, orgID, instrumentID string, take int) ([]edgeRow, error) {
	query := "SELECT " + edgeColumns + " FROM KnowledgeEdge WHERE orgId = ? AND type = ? AND (fromEntityId = ? OR toEntityId = ?) ORDER BY weight DESC, confidence DESC, updatedAt DESC LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, orgID, "has_ticker", instrumentID, instrumentID, take)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEdges(rows)
}

func nodeModel(entity entityRow) knowledgeGraphNodeModel {
	return knowledgeGraphNodeModel{
		ID:         entity.id,
		Name:       entity.canonicalName,
		Type:       entity.entityType,
		Properties: entity.properties,
	}
}

func edgeModel(edge edgeRow) knowledgeGraphEdgeModel {
	return knowledgeGraphEdgeModel{
		ID:         edge.id,
		From:       edge.fromEntityID,
		To:         edge.toEntityID,
		Type:       edge.edgeType,
		Weight:     edge.weight,
		Confidence: edge.confidence,
		Properties: edge.properties,
	}
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}
