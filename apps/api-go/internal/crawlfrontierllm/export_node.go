package crawlfrontierllm

// export_node.go exports the Frontier node execution chain
// (internal/crawlfrontiernode) surface that is still private in this package.
// Nothing here changes an existing function: every entry point is either a thin
// wrapper over a private helper or a type alias, so the judge/learn chains keep
// their behaviour.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// Type aliases so the node chain can build the same values the private helpers
// accept without re-declaring the shapes.
type (
	// CandidateDecision is one candidate trace decision.
	CandidateDecision = candidateDecision
	// SeedOutcome is materializeSeedCandidates' result.
	SeedOutcome = seedOutcome
	// SeedQualityThresholds is the resolved seedDiscovery.qualityThresholds.
	SeedQualityThresholds = qualityThresholds
	// PersistNodeInput is persistFrontierNode's argument set.
	PersistNodeInput = persistNodeInput
)

// NowISO is new Date().toISOString() with the service clock.
func (s *Service) NowISO() string { return s.nowISO() }

// Now is the service clock.
func (s *Service) Now() time.Time { return s.now() }

// NestISOString formats value like Date.prototype.toISOString.
func NestISOString(value time.Time) string { return nestISOString(value) }

// TruncateMillis truncates a timestamp to the DATETIME(3) precision the MySQL
// columns store, mirroring the Prisma write.
func TruncateMillis(value time.Time) time.Time { return truncateMillis(value) }

// MergeObjects is mergeMetadataRecords: a shallow merge that keeps the first
// record's key order, replaces same-key values in place (including `null`,
// which is a value and not a delete) and returns nil when the result is empty.
func MergeObjects(base, override *Object) *Object { return mergeObjects(base, override) }

// MergeObjectsAll folds mergeMetadataRecords over the arguments in order.
func MergeObjectsAll(objects ...*Object) *Object { return mergeObjects(objects...) }

// UniqueStringList is uniqueStringList: trim, drop empties, keep first order.
func UniqueStringList(lists ...[]string) []string { return uniqueStringList(lists...) }

// ObjectStrings reads a string array leaf.
func ObjectStrings(object *Object, key string) []string { return objectStrings(object, key) }

// ClampInt is the private clampInt (round, then clamp).
func ClampInt(value any, min, max, fallback int) int {
	return clampInt(value, min, max, fallback)
}

// MustJSONRaw marshals object to JSON bytes.
func MustJSONRaw(object *Object) (json.RawMessage, error) {
	if object == nil {
		return json.RawMessage("null"), nil
	}
	return object.MarshalJSON()
}

// ResolveEffectiveProfileForURL is resolveEffectiveProfileForUrl: the run's own
// profile when it matches the org, otherwise the host-matching profile.
func (s *Service) ResolveEffectiveProfileForURL(ctx context.Context, orgID string, profileID *string, seedURL string) (*ProfileRecord, error) {
	return s.resolveEffectiveProfile(ctx, orgID, profileID, seedURL)
}

// ApplyLlmCandidateAssistance is applyLlmCandidateAssistance: the synchronous
// judge call and its diagnostics object.
func (s *Service) ApplyLlmCandidateAssistance(ctx context.Context, node *NodeRecord, run *RunRecord, profile *ProfileRecord, candidates []Candidate) ([]Candidate, *Object, error) {
	assisted, err := s.applyLlmCandidateAssistance(ctx, node, run, profile, candidates)
	if err != nil {
		return nil, nil, err
	}
	return assisted.candidates, assisted.diagnostics, nil
}

// ApplyCandidateDiscoveryMetadata is applyCandidateDiscoveryMetadata.
func (s *Service) ApplyCandidateDiscoveryMetadata(node *NodeRecord, config *Object, candidates []Candidate) ([]Candidate, bool) {
	return s.applyCandidateDiscoveryMetadata(node, config, candidates)
}

// RecordCandidateDecision is layeredExecutor.recordCandidateDecision.
func (s *Service) RecordCandidateDecision(ctx context.Context, decision CandidateDecision) error {
	return s.recordCandidateDecision(ctx, decision)
}

// RefreshRunStatus is refreshRunStatus (already projection-only, see O1).
func (s *Service) RefreshRunStatus(ctx context.Context, runID string) error {
	return s.refreshRunStatus(ctx, runID)
}

// MarkRunStatusResetFinishedAt is markRunStatus({status, finishedAt:null}), the
// demotion branch that deliberately clears a terminal timestamp. MarkRunStatus
// with a nil finishedAt leaves the column untouched, which is the correct shape
// for `{status:"running"}` but not for this one.
func (s *Service) MarkRunStatusResetFinishedAt(ctx context.Context, runID, status string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE CrawlStrategyWorkflowRun SET status = ?, finishedAt = NULL, updatedAt = ? WHERE id = ?",
		status, truncateMillis(s.now()), runID)
	return err
}

// UpdateRunMetadata is updateRunMetadata. Callers that can race with another
// worker on the same run must use UpdateRunMetadataLocked instead (B1).
func (s *Service) UpdateRunMetadata(ctx context.Context, runID string, patch *Object) error {
	return s.updateRunMetadata(ctx, runID, patch)
}

// UpdateNodeMetadata is updateNodeMetadata. See UpdateNodeMetadataLocked (B1).
func (s *Service) UpdateNodeMetadata(ctx context.Context, nodeID string, patch *Object) error {
	return s.updateNodeMetadata(ctx, nodeID, patch)
}

// UpdateNodeMetadataFunc is the functional form of updateNodeMetadata.
func (s *Service) UpdateNodeMetadataFunc(ctx context.Context, nodeID string, build func(existing *Object) *Object) error {
	return s.updateNodeMetadataFunc(ctx, nodeID, build)
}

// EnqueueFrontierNodeJob is enqueueFrontierNode for one node id.
func (s *Service) EnqueueFrontierNodeJob(ctx context.Context, orgID, taskID, runID, nodeID, queueClass string) error {
	return s.enqueueNode(ctx, orgID, taskID, runID, nodeID, queueClass)
}

// ResolveNodeQueueClassForPageType is enqueueFrontierNode's queue selection.
func ResolveNodeQueueClassForPageType(pageType string) string {
	return ResolveNodeQueueClass(pageType)
}

// ResolveSeedStrategyValue is resolveSeedStrategy.
func ResolveSeedStrategyValue(config *Object) string { return resolveSeedStrategy(config) }

// ParseJSONTime parses the JSON timestamps the metadata carries.
func ParseJSONTime(value string) (time.Time, bool) { return parseJSONTime(value) }

// SeedMaterialize is materializeSeedCandidates.
func (s *Service) SeedMaterialize(ctx context.Context, options SeedMaterializeOptions) (SeedOutcome, error) {
	return s.materializeSeedCandidates(ctx, options)
}

// DiscoverMaterialize is materializeDiscoveredCandidates.
func (s *Service) DiscoverMaterialize(ctx context.Context, options DiscoverMaterializeOptions) (*Object, error) {
	return s.materializeDiscoveredCandidates(ctx, options)
}

// RecordResolvedLlmCandidateDecisions is rootExecutor's resolved-decision
// recorder (already implemented for the judge chain).
func (s *Service) RecordResolvedLlmCandidateDecisions(ctx context.Context, workflowRunID string, node *NodeRecord, mode JudgeMode, input, resolved []Candidate, diagnostics *Object) error {
	return s.recordResolvedLlmCandidateDecisions(ctx, workflowRunID, node, mode, input, resolved, diagnostics)
}

// EnqueueFrontierLlmJudgeJob is enqueueFrontierLlmJudge: the payload is the
// already-encoded CrawlFrontierLlmJudgeJobPayload.
func (s *Service) EnqueueFrontierLlmJudgeJob(ctx context.Context, orgID, taskID, runID, nodeID, mode string, payload json.RawMessage) error {
	if s.enqueuer == nil {
		return errors.New("crawlfrontierllm: frontier queue producer is not configured")
	}
	return s.enqueuer.EnqueueFrontierLlmJudge(ctx, crawlqueue.EnqueueFrontierLlmJudgeOptions{
		OrgID:   orgID,
		TaskID:  taskID,
		RunID:   runID,
		NodeID:  nodeID,
		Mode:    mode,
		Payload: payload,
	})
}

// PersistFrontierNode is layeredExecutor.persistFrontierNode: the run-unique
// (runId, urlFingerprint) lookup first, then the insert with the duplicate-key
// race fallback. created reports whether this call inserted the row.
func (s *Service) PersistFrontierNode(ctx context.Context, input PersistNodeInput) (nodeID, status string, created bool, err error) {
	return s.persistFrontierNode(ctx, input)
}

// BuildCandidateSnapshot is buildCandidateSnapshot (the closed-over candidate
// snapshot the decision traces record).
func BuildCandidateSnapshot(input CandidateSnapshot) *Object { return buildCandidateSnapshot(input) }

// RoundToFixed is Number(value.toFixed(digits)).
func RoundToFixed(value float64, digits int) float64 { return roundToFixed(value, digits) }

// JsTrim is String.prototype.trim (Unicode whitespace set, not strings.TrimSpace).
func JsTrim(value string) string { return jsTrim(value) }

// HasLlmJudge reports whether a judge client is wired. shouldQueueLlmJudge in
// the node chain checks `this.frontierLlm` presence, which is this predicate.
func (s *Service) HasLlmJudge() bool { return s.llm != nil }

// LoadRunForNode is loadRun.
func (s *Service) LoadRunForNode(ctx context.Context, runID string) (*RunRecord, error) {
	return s.loadRun(ctx, runID)
}

// LoadNodeForJudge is the judge/learn node read.
func (s *Service) LoadNodeForJudge(ctx context.Context, nodeID string) (*NodeRecord, error) {
	return s.loadNode(ctx, nodeID)
}

// Stop is a compile-time guard that the errors this package returns keep the
// NestJS status enum.
var _ = notFound
