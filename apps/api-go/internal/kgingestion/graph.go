package kgingestion

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgereview"
)

// GraphWriter owns the transactional entity/edge/evidence write of one article.
type GraphWriter struct {
	db  *sql.DB
	now func() time.Time
}

// NewGraphWriter builds the writer on the shared MySQL pool.
func NewGraphWriter(db *sql.DB, now func() time.Time) *GraphWriter {
	if now == nil {
		now = time.Now
	}
	return &GraphWriter{db: db, now: now}
}

// IngestProcessedArticle reproduces KnowledgeGraphService.ingestProcessedArticle
// with the K2 weight correction:
//
//   - Entities are upserted with source "llm".
//   - An edge is created with weight 1 on first sight.
//   - The edge weight and the weighted-average confidence only move when this
//     article had no evidence row for the edge yet. A reprocessed article (for
//     example after the K1 retry or after the news pipeline changed processedAt)
//     updates the evidence document, properties and lastSeenAt instead, so the
//     weight equals the number of articles that contributed evidence.
//
// The unique (orgId, type, from, to) edge key can be hit by a concurrent writer.
// The transaction locks the winning row and applies the increment instead of
// aborting, matching the NestJS P2002 branch.
func (w *GraphWriter) IngestProcessedArticle(
	ctx context.Context,
	orgID string,
	articleID string,
	extractorVersion *string,
	relations []Relation,
) (int, error) {
	if w == nil || w.db == nil {
		return 0, errors.New("kgingestion: mysql is not configured")
	}
	if len(relations) == 0 {
		return 0, nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := w.now().UTC().Truncate(time.Millisecond)
	written := 0
	for _, relation := range relations {
		edgeType, ok := knowledgereview.NormalizeRelationType(relation.Predicate)
		if !ok {
			continue
		}
		if err := w.ingestRelation(ctx, tx, orgID, articleID, extractorVersion, edgeType, relation, now); err != nil {
			return 0, err
		}
		written++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return written, nil
}

func (w *GraphWriter) ingestRelation(
	ctx context.Context,
	tx *sql.Tx,
	orgID, articleID string,
	extractorVersion *string,
	edgeType string,
	relation Relation,
	now time.Time,
) error {
	fromID, err := knowledgereview.UpsertEntityTx(ctx, tx, orgID,
		knowledgereview.EntityRef{Name: relation.Subject.Name, Type: relation.Subject.Type}, "llm", now)
	if err != nil {
		return err
	}
	toID, err := knowledgereview.UpsertEntityTx(ctx, tx, orgID,
		knowledgereview.EntityRef{Name: relation.Object.Name, Type: relation.Object.Type}, "llm", now)
	if err != nil {
		return err
	}

	edge, err := w.lockOrCreateEdge(ctx, tx, orgID, edgeType, fromID, toID, relation.Confidence, relation.Properties, now)
	if err != nil {
		return err
	}

	if edge.created {
		document, err := mergeEvidenceDocument(nil, relation.Evidence, relation.Validation)
		if err != nil {
			return err
		}
		return insertEvidence(ctx, tx, orgID, edge.id, articleID, extractorVersion, relation.Confidence, document)
	}

	existing, found, err := lockEvidence(ctx, tx, orgID, edge.id, articleID)
	if err != nil {
		return err
	}
	if found {
		merged, err := mergeEvidenceDocument(existing, relation.Evidence, relation.Validation)
		if err != nil {
			return err
		}
		if err := updateEvidence(ctx, tx, orgID, edge.id, articleID, extractorVersion, relation.Confidence, merged); err != nil {
			return err
		}
		return touchEdge(ctx, tx, edge.id, mergeJSONObjects(edge.properties, relation.Properties), now)
	}

	document, err := mergeEvidenceDocument(nil, relation.Evidence, relation.Validation)
	if err != nil {
		return err
	}
	if err := insertEvidence(ctx, tx, orgID, edge.id, articleID, extractorVersion, relation.Confidence, document); err != nil {
		if !isDuplicateKeyError(err) {
			return err
		}
		// A concurrent transaction inserted the evidence for this article
		// between the read and the insert. Treat it as an existing evidence:
		// never increment twice for the same article.
		existing, found, readErr := lockEvidence(ctx, tx, orgID, edge.id, articleID)
		if readErr != nil {
			return readErr
		}
		if !found {
			return err
		}
		merged, mergeErr := mergeEvidenceDocument(existing, relation.Evidence, relation.Validation)
		if mergeErr != nil {
			return mergeErr
		}
		if updateErr := updateEvidence(ctx, tx, orgID, edge.id, articleID, extractorVersion, relation.Confidence, merged); updateErr != nil {
			return updateErr
		}
		return touchEdge(ctx, tx, edge.id, mergeJSONObjects(edge.properties, relation.Properties), now)
	}

	return incrementEdge(ctx, tx, edge, relation.Confidence, relation.Properties, now)
}

// edgeRow is a locked KnowledgeEdge row.
type edgeRow struct {
	id         string
	weight     float64
	confidence float64
	properties []byte
	created    bool
}

// lockOrCreateEdge reads the unique edge row with FOR UPDATE, or creates it.
// The create races with other writers on the unique key; a duplicate error
// re-reads the winner's row and continues as an existing edge.
func (w *GraphWriter) lockOrCreateEdge(
	ctx context.Context,
	tx *sql.Tx,
	orgID, edgeType, fromID, toID string,
	confidence float64,
	properties json.RawMessage,
	now time.Time,
) (edgeRow, error) {
	edge, found, err := selectEdgeForUpdate(ctx, tx, orgID, edgeType, fromID, toID)
	if err != nil {
		return edgeRow{}, err
	}
	if found {
		return edge, nil
	}

	id, err := knowledgereview.NewRowID()
	if err != nil {
		return edgeRow{}, err
	}
	_, err = tx.ExecContext(ctx,
		"INSERT INTO `KnowledgeEdge` (`id`, `orgId`, `type`, `fromEntityId`, `toEntityId`, `weight`, `confidence`, `properties`, `firstSeenAt`, `lastSeenAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
		id, orgID, edgeType, fromID, toID, confidence, nullableJSON(properties), now, now, now, now)
	if err == nil {
		return edgeRow{id: id, weight: 1, confidence: confidence, properties: properties, created: true}, nil
	}
	if !isDuplicateKeyError(err) {
		return edgeRow{}, err
	}
	edge, found, readErr := selectEdgeForUpdate(ctx, tx, orgID, edgeType, fromID, toID)
	if readErr != nil {
		return edgeRow{}, readErr
	}
	if !found {
		return edgeRow{}, err
	}
	return edge, nil
}

func selectEdgeForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	orgID, edgeType, fromID, toID string,
) (edgeRow, bool, error) {
	var row edgeRow
	err := tx.QueryRowContext(ctx,
		"SELECT `id`, `weight`, `confidence`, `properties` FROM `KnowledgeEdge` "+
			"WHERE `orgId` = ? AND `type` = ? AND `fromEntityId` = ? AND `toEntityId` = ? LIMIT 1 FOR UPDATE",
		orgID, edgeType, fromID, toID,
	).Scan(&row.id, &row.weight, &row.confidence, &row.properties)
	if errors.Is(err, sql.ErrNoRows) {
		return edgeRow{}, false, nil
	}
	if err != nil {
		return edgeRow{}, false, err
	}
	return row, true, nil
}

// lockEvidence reads the (edgeId, articleId) evidence inside the organization
// with FOR UPDATE. The unique key is global, but the read stays
// organization-scoped so a historical dirty cross-tenant row cannot be adopted.
func lockEvidence(
	ctx context.Context,
	tx *sql.Tx,
	orgID, edgeID, articleID string,
) ([]byte, bool, error) {
	var document []byte
	err := tx.QueryRowContext(ctx,
		"SELECT `evidence` FROM `KnowledgeEdgeEvidence` WHERE `edgeId` = ? AND `articleId` = ? AND `orgId` = ? LIMIT 1 FOR UPDATE",
		edgeID, articleID, orgID,
	).Scan(&document)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return document, true, nil
}

func insertEvidence(
	ctx context.Context,
	tx *sql.Tx,
	orgID, edgeID, articleID string,
	extractorVersion *string,
	confidence float64,
	document json.RawMessage,
) error {
	id, err := knowledgereview.NewRowID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx,
		"INSERT INTO `KnowledgeEdgeEvidence` (`id`, `orgId`, `edgeId`, `articleId`, `extractorVersion`, `confidence`, `evidence`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?)",
		id, orgID, edgeID, articleID, nullableString(extractorVersion), confidence, nullableJSON(document),
	)
	return err
}

func updateEvidence(
	ctx context.Context,
	tx *sql.Tx,
	orgID, edgeID, articleID string,
	extractorVersion *string,
	confidence float64,
	document json.RawMessage,
) error {
	_, err := tx.ExecContext(ctx,
		"UPDATE `KnowledgeEdgeEvidence` SET `extractorVersion` = ?, `confidence` = ?, `evidence` = ? "+
			"WHERE `edgeId` = ? AND `articleId` = ? AND `orgId` = ?",
		nullableString(extractorVersion), confidence, nullableJSON(document), edgeID, articleID, orgID,
	)
	return err
}

// incrementEdge applies the observe-mode increment: weight + 1 and the
// weighted-average confidence. Only new evidence reaches this function.
func incrementEdge(
	ctx context.Context,
	tx *sql.Tx,
	edge edgeRow,
	confidence float64,
	properties json.RawMessage,
	now time.Time,
) error {
	previousWeight := edge.weight
	if previousWeight <= 0 {
		previousWeight = 1
	}
	nextWeight := previousWeight + 1
	nextConfidence := (edge.confidence*previousWeight + confidence) / nextWeight
	merged := mergeJSONObjects(edge.properties, properties)
	_, err := tx.ExecContext(ctx,
		"UPDATE `KnowledgeEdge` SET `weight` = ?, `confidence` = ?, `properties` = ?, `lastSeenAt` = ?, `updatedAt` = ? WHERE `id` = ?",
		nextWeight, nextConfidence, nullableJSON(merged), now, now, edge.id,
	)
	return err
}

// touchEdge keeps the weight and confidence untouched. It is the K2 path for an
// already-counted article: only properties and the seen window move.
func touchEdge(ctx context.Context, tx *sql.Tx, edgeID string, properties json.RawMessage, now time.Time) error {
	_, err := tx.ExecContext(ctx,
		"UPDATE `KnowledgeEdge` SET `properties` = ?, `lastSeenAt` = ?, `updatedAt` = ? WHERE `id` = ?",
		nullableJSON(properties), now, now, edgeID,
	)
	return err
}

// mergeEvidenceDocument reproduces upsertEdgeEvidence's shallow merge: the new
// quote and validation overwrite the stored leaves, every other leaf (for
// example the review decision) is preserved.
func mergeEvidenceDocument(
	existing []byte,
	quote *string,
	validation json.RawMessage,
) (json.RawMessage, error) {
	document := map[string]json.RawMessage{}
	if len(existing) > 0 {
		var stored map[string]json.RawMessage
		if err := json.Unmarshal(existing, &stored); err == nil && stored != nil {
			document = stored
		}
	}
	if quote != nil {
		encoded, err := json.Marshal(*quote)
		if err != nil {
			return nil, err
		}
		document["quote"] = encoded
	}
	if len(validation) > 0 {
		document["validation"] = validation
	}
	if len(document) == 0 {
		return nil, nil
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

// mergeJSONObjects reproduces mergeJsonObjects: a missing or empty right side
// keeps the stored object untouched, otherwise the right side wins per key.
func mergeJSONObjects(left, right json.RawMessage) json.RawMessage {
	leftRecord := decodeJSONMap(left)
	if len(bytes.TrimSpace(right)) == 0 {
		return left
	}
	rightRecord := decodeJSONMap(right)
	if len(rightRecord) == 0 {
		return left
	}
	if len(leftRecord) == 0 {
		return right
	}
	for key, value := range rightRecord {
		leftRecord[key] = value
	}
	encoded, err := json.Marshal(leftRecord)
	if err != nil {
		return left
	}
	return encoded
}

func decodeJSONMap(raw json.RawMessage) map[string]json.RawMessage {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func nullableJSON(raw json.RawMessage) any {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return []byte(raw)
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// isDuplicateKeyError reports a MySQL 1062 duplicate-entry error.
func isDuplicateKeyError(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}
