package knowledgereview

import (
	"context"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// reviewKnowledgeGraphEvidenceResolver adapts the strongly typed review to the
// executor boundary. The root is nullable, so a disabled feature or a deleted
// evidence projects as GraphQL null.
func (s *service) reviewKnowledgeGraphEvidenceResolver(ctx contract.Context) (*settingscrawl.KnowledgeGraphEvidenceReviewItemModel, error) {
	item, err := s.reviewEvidence(callContext(ctx), ctx.Identity, ctx.Args)
	if err != nil {
		return nil, graphqlFailure(err)
	}
	return item, nil
}

// reviewEvidence reproduces KnowledgeGraphReviewResolver.reviewKnowledgeGraphEvidence:
// the settings gate returns null without touching the graph, the transaction
// commits the graph update, the audit runs after the commit, the cache
// invalidation is best effort and the response is reloaded by the returned
// evidence id.
func (s *service) reviewEvidence(
	ctx context.Context,
	identity contract.Identity,
	args map[string]any,
) (*settingscrawl.KnowledgeGraphEvidenceReviewItemModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}

	// Validation runs before the settings gate, matching the NestJS
	// ValidationPipe that rejects an invalid status or note before the
	// resolver body reads the settings document.
	input, err := parseReviewInput(args)
	if err != nil {
		return nil, err
	}

	settings := s.settings.Read(ctx, identity.OrgID)
	// Only `enabled` gates the mutation. ingestionEnabled staying false must
	// not stop a human from cleaning up existing evidence.
	if !settings.Enabled {
		return nil, nil
	}

	now := s.timestamp()
	reviewDocument, err := buildReviewDocument(input, identity.UserID, contract.FormatDateTime(now))
	if err != nil {
		return nil, err
	}

	result, err := s.applyReview(ctx, identity.OrgID, input, reviewDocument, now)
	if err != nil {
		return nil, err
	}

	// The graph transaction already committed. An audit failure is returned to
	// the caller, but it never rolls the committed graph update back.
	if err := s.writeReviewAudit(ctx, identity, input, result); err != nil {
		return nil, err
	}
	s.invalidateGraphCaches(ctx, identity.OrgID)

	if result.EvidenceID == nil {
		return nil, nil
	}
	return s.reviews.LoadReviewItem(ctx, identity.OrgID, *result.EvidenceID)
}
