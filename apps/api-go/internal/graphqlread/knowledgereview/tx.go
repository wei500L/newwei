package knowledgereview

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
)

// reviewResult is the committed outcome of one review. EvidenceID is nil when
// the review deleted the evidence (the original edge lost its last active
// evidence and is not durable).
type reviewResult struct {
	EvidenceID     *string
	EdgeIDs        []string
	DeletedEdgeIDs []string
}

// evidenceRecord is one KnowledgeEdgeEvidence row read inside the transaction.
type evidenceRecord struct {
	ID         string
	EdgeID     string
	ArticleID  string
	Confidence sql.NullFloat64
	Evidence   []byte
}

// applyReview runs the whole graph update in one transaction and commits only
// after every touched edge has been recomputed.
func (s *service) applyReview(
	ctx context.Context,
	orgID string,
	input reviewInput,
	reviewDocument json.RawMessage,
	now time.Time,
) (reviewResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return reviewResult{}, err
	}
	defer tx.Rollback()

	result, err := applyReviewTx(ctx, tx, orgID, input, reviewDocument, now)
	if err != nil {
		return reviewResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return reviewResult{}, err
	}
	return result, nil
}

// applyReviewTx is applyReviewToEvidence. It reads the evidence inside the
// organization first, so an id from another tenant behaves exactly like a
// missing id.
func applyReviewTx(
	ctx context.Context,
	tx *sql.Tx,
	orgID string,
	input reviewInput,
	reviewDocument json.RawMessage,
	now time.Time,
) (reviewResult, error) {
	existing, found, err := findEvidenceRecord(ctx, tx, orgID, input.EvidenceID)
	if err != nil {
		return reviewResult{}, err
	}
	if !found {
		return reviewResult{}, evidenceNotFoundError()
	}

	nextEvidence := withReview(existing.Evidence, reviewDocument)
	touched := []string{existing.EdgeID}
	returned := existing.ID

	if input.Status == reviewStatusCorrected {
		relation, ok := parseReviewedRelation(input.CorrectedRelation)
		if !ok {
			return reviewResult{}, invalidRelationError()
		}

		targetEdgeID, err := upsertReviewedEdge(ctx, tx, orgID, relation, existing.Confidence, now)
		if err != nil {
			return reviewResult{}, err
		}
		touched = appendUnique(touched, targetEdgeID)

		if targetEdgeID == existing.EdgeID {
			if err := updateEvidenceDocument(ctx, tx, orgID, existing.ID, nextEvidence); err != nil {
				return reviewResult{}, err
			}
		} else {
			duplicate, duplicateFound, err := findEvidenceByEdgeArticle(ctx, tx, orgID, targetEdgeID, existing.ArticleID)
			if err != nil {
				return reviewResult{}, err
			}
			if duplicateFound {
				// The target edge already carries an evidence for this article:
				// keep the duplicate row's identity, merge the documents in the
				// documented order and delete the original row.
				merged := mergeDuplicateEvidence(existing.Evidence, duplicate.Evidence, reviewDocument)
				confidence := mergeEvidenceConfidence(duplicate.Confidence, existing.Confidence)
				if err := updateEvidenceMerged(ctx, tx, orgID, duplicate.ID, confidence, merged); err != nil {
					return reviewResult{}, err
				}
				if err := deleteEvidence(ctx, tx, orgID, existing.ID); err != nil {
					return reviewResult{}, err
				}
				returned = duplicate.ID
			} else if err := moveEvidence(ctx, tx, orgID, existing.ID, targetEdgeID, nextEvidence); err != nil {
				return reviewResult{}, err
			}
		}
	} else if err := updateEvidenceDocument(ctx, tx, orgID, existing.ID, nextEvidence); err != nil {
		return reviewResult{}, err
	}

	deleted := []string{}
	for _, edgeID := range touched {
		wasDeleted, err := recomputeEdgeAggregate(ctx, tx, orgID, edgeID, now)
		if err != nil {
			return reviewResult{}, err
		}
		if !wasDeleted {
			continue
		}
		deleted = append(deleted, edgeID)
		if edgeID == existing.EdgeID && input.Status != reviewStatusCorrected {
			returned = ""
		}
	}

	result := reviewResult{EdgeIDs: touched, DeletedEdgeIDs: deleted}
	if returned != "" {
		id := returned
		result.EvidenceID = &id
	}
	return result, nil
}

// findEvidenceRecord reads one evidence inside the organization.
func findEvidenceRecord(ctx context.Context, tx *sql.Tx, orgID, evidenceID string) (evidenceRecord, bool, error) {
	var row evidenceRecord
	err := tx.QueryRowContext(ctx,
		"SELECT `id`, `edgeId`, `articleId`, `confidence`, `evidence` FROM `KnowledgeEdgeEvidence` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
		evidenceID, orgID,
	).Scan(&row.ID, &row.EdgeID, &row.ArticleID, &row.Confidence, &row.Evidence)
	if errors.Is(err, sql.ErrNoRows) {
		return evidenceRecord{}, false, nil
	}
	if err != nil {
		return evidenceRecord{}, false, err
	}
	return row, true, nil
}

// findEvidenceByEdgeArticle reads the (edgeId, articleId) unique row inside the
// organization. The schema unique key is global, but the read stays
// organization-scoped so a historical dirty cross-tenant row can never be
// folded into this organization's merge.
func findEvidenceByEdgeArticle(ctx context.Context, tx *sql.Tx, orgID, edgeID, articleID string) (evidenceRecord, bool, error) {
	var row evidenceRecord
	err := tx.QueryRowContext(ctx,
		"SELECT `id`, `edgeId`, `articleId`, `confidence`, `evidence` FROM `KnowledgeEdgeEvidence` "+
			"WHERE `edgeId` = ? AND `articleId` = ? AND `orgId` = ? LIMIT 1",
		edgeID, articleID, orgID,
	).Scan(&row.ID, &row.EdgeID, &row.ArticleID, &row.Confidence, &row.Evidence)
	if errors.Is(err, sql.ErrNoRows) {
		return evidenceRecord{}, false, nil
	}
	if err != nil {
		return evidenceRecord{}, false, err
	}
	return row, true, nil
}

// mergeEvidenceConfidence is `duplicate.confidence ?? original.confidence`. A
// missing value on both sides stays NULL: 0 is a real confidence and must not
// be substituted.
func mergeEvidenceConfidence(duplicate, original sql.NullFloat64) any {
	if duplicate.Valid {
		return duplicate.Float64
	}
	if original.Valid {
		return original.Float64
	}
	return nil
}

func updateEvidenceDocument(ctx context.Context, tx *sql.Tx, orgID, evidenceID string, evidence json.RawMessage) error {
	_, err := tx.ExecContext(ctx,
		"UPDATE `KnowledgeEdgeEvidence` SET `evidence` = ? WHERE `id` = ? AND `orgId` = ?",
		evidence, evidenceID, orgID)
	return err
}

func updateEvidenceMerged(ctx context.Context, tx *sql.Tx, orgID, evidenceID string, confidence any, evidence json.RawMessage) error {
	_, err := tx.ExecContext(ctx,
		"UPDATE `KnowledgeEdgeEvidence` SET `confidence` = ?, `evidence` = ? WHERE `id` = ? AND `orgId` = ?",
		confidence, evidence, evidenceID, orgID)
	return err
}

func moveEvidence(ctx context.Context, tx *sql.Tx, orgID, evidenceID, targetEdgeID string, evidence json.RawMessage) error {
	_, err := tx.ExecContext(ctx,
		"UPDATE `KnowledgeEdgeEvidence` SET `edgeId` = ?, `evidence` = ? WHERE `id` = ? AND `orgId` = ?",
		targetEdgeID, evidence, evidenceID, orgID)
	return err
}

func deleteEvidence(ctx context.Context, tx *sql.Tx, orgID, evidenceID string) error {
	_, err := tx.ExecContext(ctx, "DELETE FROM `KnowledgeEdgeEvidence` WHERE `id` = ? AND `orgId` = ?", evidenceID, orgID)
	return err
}

// upsertReviewedEdge reproduces upsertReviewedRelationEdge: upsert both
// entities, reuse an existing (orgId, type, from, to) edge untouched, otherwise
// create a weight-0 edge whose properties always carry recordSource=user.
func upsertReviewedEdge(
	ctx context.Context,
	tx *sql.Tx,
	orgID string,
	relation reviewedRelation,
	evidenceConfidence sql.NullFloat64,
	now time.Time,
) (string, error) {
	fromEntityID, err := upsertEntity(ctx, tx, orgID, relation.Subject, now)
	if err != nil {
		return "", err
	}
	toEntityID, err := upsertEntity(ctx, tx, orgID, relation.Object, now)
	if err != nil {
		return "", err
	}

	const selectEdge = "SELECT `id` FROM `KnowledgeEdge` WHERE `orgId` = ? AND `type` = ? AND `fromEntityId` = ? AND `toEntityId` = ? LIMIT 1"

	var existingID string
	err = tx.QueryRowContext(ctx, selectEdge, orgID, relation.Predicate, fromEntityID, toEntityID).Scan(&existingID)
	if err == nil {
		return existingID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}

	id, err := newRowID()
	if err != nil {
		return "", err
	}
	confidence := confidenceOrDefault(evidenceConfidence.Float64, evidenceConfidence.Valid)
	properties := edgePropertiesWithRecordSource(relation.Properties)
	_, err = tx.ExecContext(ctx,
		"INSERT INTO `KnowledgeEdge` (`id`, `orgId`, `type`, `fromEntityId`, `toEntityId`, `weight`, `confidence`, `properties`, `firstSeenAt`, `lastSeenAt`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
		id, orgID, relation.Predicate, fromEntityID, toEntityID, confidence, properties, now, now, now, now)
	if err != nil {
		// The ingestion cron can create the same unique edge between the read
		// above and this insert; adopt the winner's row instead of failing the
		// review transaction, exactly like the NestJS P2002 branch.
		if isDuplicateKeyError(err) {
			if err := tx.QueryRowContext(ctx, selectEdge, orgID, relation.Predicate, fromEntityID, toEntityID).Scan(&existingID); err == nil {
				return existingID, nil
			}
		}
		return "", err
	}
	return id, nil
}

// upsertEntity reproduces upsertEntity: canonicalName identifies the entity,
// existing rows only get a refreshed canonicalName, and the alias set is
// canonical name plus company/ticker variants plus the explicit aliases.
func upsertEntity(ctx context.Context, tx *sql.Tx, orgID string, ref reviewedEntityRef, now time.Time) (string, error) {
	entityType := normalizeEntityType(ref.Type)
	canonicalName := knowledgegraph.CollapseEntityName(ref.Name)
	normalizedKey := knowledgegraph.NormalizeEntityKey(canonicalName)

	id, err := newRowID()
	if err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx,
		"INSERT INTO `KnowledgeEntity` (`id`, `orgId`, `type`, `canonicalName`, `normalizedKey`, `properties`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, NULL, ?, ?) AS new_row "+
			"ON DUPLICATE KEY UPDATE `canonicalName` = new_row.`canonicalName`, `updatedAt` = new_row.`updatedAt`",
		id, orgID, entityType, canonicalName, normalizedKey, now, now)
	if err != nil {
		return "", err
	}

	var entityID string
	if err := tx.QueryRowContext(ctx,
		"SELECT `id` FROM `KnowledgeEntity` WHERE `orgId` = ? AND `type` = ? AND `normalizedKey` = ? LIMIT 1",
		orgID, entityType, normalizedKey,
	).Scan(&entityID); err != nil {
		return "", err
	}

	if err := upsertEntityAliases(ctx, tx, orgID, entityID, entityType, canonicalName, ref.Aliases, now); err != nil {
		return "", err
	}
	return entityID, nil
}

// upsertEntityAliases inserts the alias candidates. The unique key is
// (entityId, normalizedAlias), so a pre-existing alias keeps its original
// source and the insert is a no-op instead of flipping it to user.
func upsertEntityAliases(
	ctx context.Context,
	tx *sql.Tx,
	orgID, entityID, entityType, canonicalName string,
	explicit []string,
	now time.Time,
) error {
	candidates := []string{canonicalName}
	if entityType == "company" {
		candidates = append(candidates, knowledgegraph.CompanyAliasCandidates(canonicalName)...)
	}
	if entityType == "instrument" {
		candidates = append(candidates, knowledgegraph.TickerAliases(canonicalName)...)
	}
	candidates = append(candidates, explicit...)

	seen := map[string]bool{}
	for _, candidate := range candidates {
		alias := knowledgegraph.TrimSpace(candidate)
		if alias == "" {
			continue
		}
		normalizedAlias := knowledgegraph.NormalizeEntityKey(alias)
		if normalizedAlias == "" || seen[normalizedAlias] {
			continue
		}
		seen[normalizedAlias] = true

		id, err := newRowID()
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO `KnowledgeEntityAlias` (`id`, `orgId`, `entityId`, `alias`, `normalizedAlias`, `source`, `createdAt`) "+
				"VALUES (?, ?, ?, ?, ?, 'user', ?) AS new_row "+
				"ON DUPLICATE KEY UPDATE `entityId` = new_row.`entityId`",
			id, orgID, entityID, alias, normalizedAlias, now); err != nil {
			return err
		}
	}
	return nil
}

// recomputeEdgeAggregate reproduces recomputeEdgeAggregate: the active evidence
// set drives weight, mean confidence and the seen window; an empty active set
// keeps a durable seed/user/derived edge untouched and deletes any other edge
// together with its evidence.
func recomputeEdgeAggregate(ctx context.Context, tx *sql.Tx, orgID, edgeID string, now time.Time) (bool, error) {
	var properties []byte
	err := tx.QueryRowContext(ctx,
		"SELECT `properties` FROM `KnowledgeEdge` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
		edgeID, orgID,
	).Scan(&properties)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	rows, err := tx.QueryContext(ctx,
		"SELECT `confidence`, `evidence`, `createdAt` FROM `KnowledgeEdgeEvidence` "+
			"WHERE `orgId` = ? AND `edgeId` = ? ORDER BY `createdAt` ASC, `id` ASC",
		orgID, edgeID)
	if err != nil {
		return false, err
	}

	active := make([]activeEvidenceRow, 0)
	for rows.Next() {
		var (
			confidence sql.NullFloat64
			evidence   []byte
			createdAt  sql.NullTime
		)
		if err := rows.Scan(&confidence, &evidence, &createdAt); err != nil {
			rows.Close()
			return false, err
		}
		if isRejectedEvidence(evidence) {
			continue
		}
		created := now
		if createdAt.Valid {
			created = createdAt.Time
		}
		active = append(active, activeEvidenceRow{confidence: confidence, createdAt: created})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()

	if len(active) == 0 {
		if durableRecordSource(properties) {
			return false, nil
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM `KnowledgeEdgeEvidence` WHERE `orgId` = ? AND `edgeId` = ?", orgID, edgeID); err != nil {
			return false, err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM `KnowledgeEdge` WHERE `id` = ?", edgeID); err != nil {
			return false, err
		}
		return true, nil
	}

	weight, confidence, firstSeenAt, lastSeenAt := aggregateActiveEvidence(active)
	if _, err := tx.ExecContext(ctx,
		"UPDATE `KnowledgeEdge` SET `weight` = ?, `confidence` = ?, `firstSeenAt` = ?, `lastSeenAt` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?",
		weight, confidence, firstSeenAt, lastSeenAt, now, edgeID, orgID); err != nil {
		return false, err
	}
	return false, nil
}

// activeEvidenceRow is one active evidence contributing to an edge aggregate.
type activeEvidenceRow struct {
	confidence sql.NullFloat64
	createdAt  time.Time
}

// aggregateActiveEvidence computes the edge aggregate from the ordered active
// evidence rows: weight is the count, confidence is the arithmetic mean of the
// clamped values and the seen window is the first/last createdAt. The caller
// guarantees a non-empty slice.
func aggregateActiveEvidence(active []activeEvidenceRow) (weight int, confidence float64, firstSeenAt, lastSeenAt time.Time) {
	sum := 0.0
	for _, row := range active {
		sum += confidenceOrDefault(row.confidence.Float64, row.confidence.Valid)
	}
	return len(active), sum / float64(len(active)), active[0].createdAt, active[len(active)-1].createdAt
}

// isDuplicateKeyError reports a MySQL 1062 duplicate-entry error.
func isDuplicateKeyError(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}
