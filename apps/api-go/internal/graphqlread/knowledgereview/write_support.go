package knowledgereview

import (
	"context"
	"database/sql"
	"time"
)

// This file is the narrow port the knowledge-graph ingestion writer opens onto
// the review package. The review mutation and the cron ingestion must create
// entities with byte-identical canonical names, normalized keys and alias sets,
// so the ingestion reuses the reviewed-relation implementation instead of
// copying it.
//
// Every exported function below delegates to the existing private
// implementation. The review path keeps passing source "user"; the ingestion
// path passes "llm".

// EntityRef is one entity reference to upsert. Name is raw: the upsert applies
// the canonicalName rule itself. Aliases are only used by seed/review writes.
type EntityRef struct {
	Name    string
	Type    string
	Aliases []string
}

// UpsertEntityTx reproduces KnowledgeGraphService.upsertEntity inside the
// caller's transaction: the (orgId, type, normalizedKey) unique key identifies
// the row, an existing row only gets its canonicalName refreshed, and the alias
// set is the canonical name plus company/ticker variants plus the explicit
// aliases. source is the KnowledgeEntityAlias.source value ("llm" for the cron
// ingestion, "user" for manual reviews).
func UpsertEntityTx(
	ctx context.Context,
	tx *sql.Tx,
	orgID string,
	ref EntityRef,
	source string,
	now time.Time,
) (string, error) {
	return upsertEntityWithSource(ctx, tx, orgID, reviewedEntityRef{
		Name:    ref.Name,
		Type:    ref.Type,
		Aliases: ref.Aliases,
	}, source, now)
}

// NormalizeRelationType maps a predicate to the Prisma KnowledgeRelationType
// with the NestJS synonym table.
func NormalizeRelationType(value string) (string, bool) {
	return normalizeRelationType(value)
}

// NormalizeEntityType maps a free-form mention type to the Prisma
// KnowledgeEntityType with the NestJS contains-test order.
func NormalizeEntityType(value string) string {
	return normalizeEntityType(value)
}

// NewRowID writes a Prisma cuid column ('c' plus 24 hex characters).
func NewRowID() (string, error) {
	return newRowID()
}
