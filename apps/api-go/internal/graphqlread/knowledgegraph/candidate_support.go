package knowledgegraph

import (
	"context"
	"database/sql"
	"errors"
)

// This file is the narrow port the knowledge-graph ingestion writer opens onto
// the read package. It exposes candidate resolution with exactly the rules the
// GraphQL read side uses (alias expansion, company suffix stripping, A-share
// ticker expansion, alias-source and entity-type preference) so the ingestion
// writer can never link an entity to a different candidate order than the UI
// displays.
//
// Only candidates are exported. The settings reader, the graph walks and the
// mutation surface stay private.

// EntityCandidate is one entity resolved by name inside an organization.
type EntityCandidate struct {
	ID   string
	Name string
	Type string
}

// ListEntityCandidates reproduces KnowledgeGraphService.listEntityCandidatesByName:
// it expands the name into search keys, reads up to twenty aliases scoped to
// the organization, filters by the already normalized entity type and orders
// the survivors by the ticker/alias-source/entity-type preference.
func ListEntityCandidates(
	ctx context.Context,
	db *sql.DB,
	orgID string,
	name string,
	entityType string,
) ([]EntityCandidate, error) {
	if db == nil {
		return nil, errors.New("knowledge graph database is not configured")
	}
	reader := &service{db: db}
	rows, err := reader.listEntityCandidates(ctx, orgID, name, &entityType)
	if err != nil {
		return nil, err
	}
	candidates := make([]EntityCandidate, 0, len(rows))
	for _, row := range rows {
		candidates = append(candidates, EntityCandidate{
			ID:   row.ID,
			Name: row.CanonicalName,
			Type: row.Type,
		})
	}
	return candidates, nil
}

// NormalizeSearchKeys exposes the alias lookup keys for a name: the trimmed
// normalized key plus the company-suffix and ticker variants, capped at twenty.
// The ingestion linker uses it to reproduce the alias query for entities it
// created earlier in the same article.
func NormalizeSearchKeys(value string) []string {
	return normalizeSearchKeys(value)
}
