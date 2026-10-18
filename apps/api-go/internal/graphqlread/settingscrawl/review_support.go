package settingscrawl

import (
	"context"
	"database/sql"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
)

// This file is the narrow port the review mutation uses. It keeps the manual
// evidence review out of register.go and policy.go (which other in-flight
// batches own) while letting the writer reuse the queue's projection SQL
// instead of copying a second model set.

// reviewPort exposes the shared Redis -> MySQL knowledge-graph settings port
// for the evidence review chain. The queue and the review mutation both go
// through it, so they cannot disagree about `enabled` or `minEdgeConfidence`.
// It is derived from the reader's own store so register.go keeps constructing
// the reader exactly as before.
func (s *settingsReader) reviewPort() *knowledgegraph.ReviewSettingsReader {
	if s == nil || s.s == nil {
		return nil
	}
	return knowledgegraph.NewReviewSettingsReader(s.s.db, s.s.redis)
}

// RegisterReviewModelTypes records the four knowledge-graph evidence review
// object types if they are not registered yet. The review mutation can run
// while the settings/crawl read roots are legacy, so it must be able to
// register its own return models without taking over any read root. Every type
// is checked individually because RegisterType overwrites, not merges.
func RegisterReviewModelTypes(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: settingscrawl.RegisterReviewModelTypes requires a registry")
	}
	registerReviewModelType(reg, "KnowledgeGraphNodeModel", KnowledgeGraphNodeModel{})
	registerReviewModelType(reg, "KnowledgeGraphReviewArticleModel", KnowledgeGraphReviewArticleModel{})
	registerReviewModelType(reg, "KnowledgeGraphReviewEdgeModel", KnowledgeGraphReviewEdgeModel{})
	registerReviewModelType(reg, "KnowledgeGraphEvidenceReviewItemModel", KnowledgeGraphEvidenceReviewItemModel{})
}

func registerReviewModelType(reg *contract.Registry, name string, sample any) {
	if reg.HasType(name) {
		return
	}
	reg.RegisterType(name, sample)
}

// EvidenceReviewReader loads one review item with the queue's projection. The
// writer uses it to reload the response after the graph transaction committed.
type EvidenceReviewReader struct {
	review *reviewReader
}

// NewEvidenceReviewReader builds the reader on the shared MySQL pool. The
// settings port is only needed by the queue path; it is still wired here so the
// embedded reader is never in a half-built state.
func NewEvidenceReviewReader(db *sql.DB, redisClient *redis.Client) *EvidenceReviewReader {
	st := &store{db: db, redis: redisClient}
	return &EvidenceReviewReader{
		review: &reviewReader{s: st, settings: &settingsReader{s: st}},
	}
}

// LoadReviewItem returns the review item projection for one evidence id inside
// the organization, or nil when the row no longer exists (for example after a
// rejected review deleted an empty non-durable edge).
func (r *EvidenceReviewReader) LoadReviewItem(
	ctx context.Context,
	orgID string,
	evidenceID string,
) (*KnowledgeGraphEvidenceReviewItemModel, error) {
	if r == nil || r.review == nil {
		return nil, nil
	}
	return r.review.loadReviewItem(ctx, orgID, evidenceID)
}
