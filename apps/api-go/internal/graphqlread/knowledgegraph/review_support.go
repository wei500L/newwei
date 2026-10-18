package knowledgegraph

import (
	"context"
	"database/sql"
	"strings"

	"github.com/redis/go-redis/v9"
)

// This file is the narrow port the manual evidence review path opens onto this
// read package. It exposes exactly two things:
//
//  1. the shared settings document (Redis -> MySQL, the same 60s cache and the
//     same bootstrap/fallback rules the knowledgeGraphSettings root and the
//     ingestion path use), so the review queue and the review mutation can
//     never disagree about `enabled` or `minEdgeConfidence`;
//  2. the name normalization primitives the write path must reproduce
//     byte-for-byte (JavaScript whitespace set, company-suffix stripping and
//     A-share ticker expansion).
//
// The strict read-side enum checks in normalize.go stay private on purpose:
// the write path needs the fuzzy NestJS entity-type recognition and relation
// synonyms, which are different rules.

// ReviewSettingsView is the subset of the knowledge graph settings document the
// manual evidence review path reads. `Enabled` gates the feature; it is not
// `ingestionEnabled`, because a deployment that stopped ingestion must still
// allow reviewers to clean up existing evidence.
type ReviewSettingsView struct {
	Enabled           bool
	IngestionEnabled  bool
	MinEdgeConfidence float64
}

// ReviewSettingsReader reads the shared knowledge graph settings document.
type ReviewSettingsReader struct {
	service *service
}

// NewReviewSettingsReader builds the review settings port on the shared MySQL
// pool and Redis client. A nil client simply skips the cache; a nil database
// degrades to the disabled fallback, exactly like the read root.
func NewReviewSettingsReader(db *sql.DB, redisClient *redis.Client) *ReviewSettingsReader {
	return &ReviewSettingsReader{service: &service{db: db, redis: redisClient}}
}

// Read returns the current settings view for one organization.
func (r *ReviewSettingsReader) Read(ctx context.Context, orgID string) ReviewSettingsView {
	if r == nil || r.service == nil {
		return ReviewSettingsView{MinEdgeConfidence: fallbackSettings().MinEdgeConfidence}
	}
	loaded := r.service.getSettings(ctx, orgID)
	return ReviewSettingsView{
		Enabled:           loaded.Enabled,
		IngestionEnabled:  loaded.IngestionEnabled,
		MinEdgeConfidence: loaded.MinEdgeConfidence,
	}
}

// CollapseEntityName applies the write-side canonicalName rule: trim the
// JavaScript whitespace set and collapse every whitespace run to one ASCII
// space.
func CollapseEntityName(value string) string {
	return collapseSpaces(trimSpace(value))
}

// TrimSpace applies the JavaScript String.prototype.trim whitespace set. The
// write path uses it for the values it stores verbatim (entity aliases and the
// type hint) while canonicalName goes through CollapseEntityName.
func TrimSpace(value string) string {
	return trimSpace(value)
}

// NormalizeEntityKey is the normalizedKey rule: canonicalName lowercased. It is
// the second half of the (orgId,type,normalizedKey) unique key.
func NormalizeEntityKey(value string) string {
	return normalizeEntityKey(value)
}

// CompanyAliasCandidates returns the canonical name plus its bracket-stripped
// and company-suffix-stripped variants.
func CompanyAliasCandidates(value string) []string {
	return buildCompanyAliasCandidates(value)
}

// TickerAliases returns every stored shape of a recognized ticker
// (code, code.EX and EXcode). A value that is not a ticker yields no aliases.
func TickerAliases(value string) []string {
	return buildTickerAliases(value)
}

// ReviewRelationToken reproduces `value.trim().toLowerCase().replace(/[\s-]+/g, "_")`:
// the JavaScript whitespace set is trimmed from both ends first, so a leading
// or trailing hyphen survives as an underscore exactly like the NestJS regex,
// and every remaining whitespace/hyphen run collapses to one underscore. The
// caller maps the token to the Prisma relation enum; a token that matches
// nothing is invalid.
func ReviewRelationToken(value string) string {
	trimmed := trimSpace(value)
	var builder strings.Builder
	builder.Grow(len(trimmed))
	pendingUnderscore := false
	for _, r := range trimmed {
		if isJSSpace(r) || r == '-' {
			pendingUnderscore = true
			continue
		}
		if pendingUnderscore {
			builder.WriteByte('_')
		}
		pendingUnderscore = false
		builder.WriteRune(r)
	}
	if pendingUnderscore {
		builder.WriteByte('_')
	}
	return strings.ToLower(builder.String())
}
