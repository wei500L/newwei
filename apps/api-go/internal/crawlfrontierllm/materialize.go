package crawlfrontierllm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// materialize.go ports applyCandidateDiscoveryMetadata,
// materializeSeedCandidates and materializeDiscoveredCandidates (with their
// candidate-decision trace writes and persistFrontierNode dedupe). The
// selection/dedupe/budget order is the source order; O2 candidate batching is
// intentionally not applied because the per-candidate queue enqueue and trace
// writes interleave with the insert, so batching would change observable order.

type seedOutcome struct {
	Created       int
	Diagnostics   *Object
	PageTypeCount *Object
}

// SeedMaterializeOptions is the seed materialization input.
type SeedMaterializeOptions struct {
	WorkflowRunID      string
	Node               *NodeRecord
	Run                SeedRun
	TaskID             string
	Profile            *ProfileRecord
	Candidates         []Candidate
	SitemapDiagnostics *Object
	QualityThresholds  qualityThresholds
	DiscoveredCount    int
	LlmDiagnostics     *Object
}

// SeedRun is the run projection materializeSeedCandidates reads.
type SeedRun struct {
	ID       string
	SeedURL  string
	MaxDepth int
	MaxPages int
}

var digitSegmentPattern = regexp.MustCompile(`^\d{1,4}$`)

// applyCandidateDiscoveryMetadata mirrors the private helper of the same name.
func (s *Service) applyCandidateDiscoveryMetadata(node *NodeRecord, config *Object, candidates []Candidate) ([]Candidate, bool) {
	synthetic := shouldUseSyntheticList(node.PageType, candidates)
	out := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		base := mergeObjects(candidate.metadataObject(), NewObjectFromPairs(
			"sourceTier", configStringOr(config, "sourceTier", "tier2"),
			"freshnessBucket", ResolveFreshnessBucket(candidate.FreshnessScore),
		))
		if synthetic && candidate.PageType == "article" && (node.PageType == "home" || node.PageType == "category") {
			linkText, _ := candidate.metadataObject().String("linkText")
			metadata := mergeObjects(base, NewObjectFromPairs(
				"syntheticList", true,
				"syntheticListLabel", deriveSyntheticListLabel(candidate.URL, linkText),
				"discoveryPath", []string{node.PageType, "synthetic_list", "article"},
				"frontierPath", []string{node.PageType, "synthetic_list", "article"},
			))
			candidate.Metadata = mustJSON(metadata)
			out = append(out, candidate)
			continue
		}
		metadata := mergeObjects(base, NewObjectFromPairs(
			"syntheticList", nil,
			"discoveryPath", []string{node.PageType, candidate.PageType},
			"frontierPath", []string{node.PageType, candidate.PageType},
		))
		candidate.Metadata = mustJSON(metadata)
		out = append(out, candidate)
	}
	return out, synthetic
}

func shouldUseSyntheticList(parentPageType string, candidates []Candidate) bool {
	if parentPageType != "home" && parentPageType != "category" {
		return false
	}
	articles, lists := 0, 0
	for _, candidate := range candidates {
		switch candidate.PageType {
		case "article":
			articles++
		case "list":
			lists++
		}
	}
	return articles > 0 && lists == 0
}

func deriveSyntheticListLabel(rawURL, linkText string) string {
	if parsed, err := url.Parse(rawURL); err == nil {
		segments := strings.Split(parsed.Path, "/")
		for _, segment := range segments {
			if segment == "" {
				continue
			}
			decoded, err := url.PathUnescape(segment)
			if err != nil {
				decoded = segment
			}
			normalized := strings.ToLower(jsTrim(decoded))
			if normalized == "" || digitSegmentPattern.MatchString(normalized) {
				continue
			}
			switch normalized {
			case "article", "articles", "story", "stories", "content", "liveblog":
				continue
			}
			return strings.ReplaceAll(strings.ReplaceAll(decoded, "-", " "), "_", " ")
		}
	}
	normalizedText := jsTrim(linkText)
	if normalizedText != "" {
		words := strings.FieldsFunc(normalizedText, isWhitespaceRune)
		if len(words) > 6 {
			words = words[:6]
		}
		return strings.Join(words, " ")
	}
	return "direct discovery"
}

// materializeSeedCandidates ports layeredExecutor.materializeSeedCandidates.
func (s *Service) materializeSeedCandidates(ctx context.Context, options SeedMaterializeOptions) (seedOutcome, error) {
	diagnostics := options.SitemapDiagnostics
	seedMethod := ""
	if diagnostics != nil {
		seedMethod, _ = diagnostics.String("seedMethod")
	}
	normalized := make([]Candidate, 0, len(options.Candidates))
	for _, candidate := range options.Candidates {
		metadata := candidate.metadataObject()
		synthetic := false
		if value, ok := metadata.Bool("syntheticList"); ok && value && candidate.PageType == "article" {
			synthetic = true
		}
		var discoveryPath []string
		if synthetic {
			discoveryPath = []string{"seed", "synthetic_list", "article"}
		} else {
			discoveryPath = []string{"seed", candidate.PageType}
		}
		merged := mergeObjects(metadata, NewObjectFromPairs(
			"seedCandidate", true,
			"seedOrigin", "sitemap",
			"seedMethod", nullableValue(stringPointer(seedMethod)),
			"discoveryPath", discoveryPath,
			"frontierPath", discoveryPath,
		))
		candidate.Metadata = mustJSON(merged)
		normalized = append(normalized, candidate)
	}

	selectedPageTypeCounts := newPageTypeCountObject()
	for _, candidate := range normalized {
		bumpObjectCount(selectedPageTypeCounts, candidate.PageType)
	}
	articleCount := pageTypeCount(selectedPageTypeCounts, "article")
	freshCount := 0
	for _, candidate := range normalized {
		if candidate.FreshnessScore >= 0.75 {
			freshCount++
		}
	}
	candidateCount := options.DiscoveredCount
	if candidateCount < len(normalized) {
		candidateCount = len(normalized)
	}
	selectedCount := len(normalized)
	articleRatio := 0.0
	if selectedCount > 0 {
		articleRatio = roundToFixed(float64(articleCount)/float64(selectedCount), 4)
	}
	noiseRatio := 1.0
	if candidateCount > 0 {
		noise := float64(candidateCount-selectedCount) / float64(candidateCount)
		if noise < 0 {
			noise = 0
		}
		noiseRatio = roundToFixed(noise, 4)
	}
	freshRatio := 0.0
	if selectedCount > 0 {
		freshRatio = roundToFixed(float64(freshCount)/float64(selectedCount), 4)
	}
	thresholds := options.QualityThresholds
	qualityPassed := float64(selectedCount) >= thresholds.MinCandidates &&
		articleRatio >= thresholds.MinArticleRatio &&
		noiseRatio <= thresholds.MaxNoiseRatio &&
		freshRatio >= thresholds.MinFreshRatio

	rejectionCounts := NewObject()
	if !qualityPassed && selectedCount > 0 {
		bumpObjectCount(rejectionCounts, "seed_low_quality")
		if options.WorkflowRunID != "" {
			details := NewObject()
			details.SetNumber("articleRatio", articleRatio)
			details.SetNumber("noiseRatio", noiseRatio)
			details.SetNumber("freshRatio", freshRatio)
			details.SetRaw("qualityThresholds", mustJSON(qualityThresholdsObject(thresholds)))
			if err := s.AppendEvent(ctx, options.WorkflowRunID, WorkflowEvent{
				Level: "warn", EventType: "seed_quality_gate_failed", NodeID: &options.Node.ID,
				NodeType: stringPointer("branch"), Message: "Seed candidate set failed the quality gate",
				TriggerReason: stringPointer("seed_low_quality"), BeforeCount: intPointer(selectedCount),
				AfterCount: intPointer(0), RescuedCount: intPointer(0), Details: details,
				Timestamp: s.nowISO(),
			}); err != nil {
				return seedOutcome{}, err
			}
		}
	}

	existing, err := s.listExistingNodes(ctx, options.Run.ID)
	if err != nil {
		return seedOutcome{}, err
	}
	seen := map[string]struct{}{}
	for _, node := range existing {
		key := ""
		if node.URLFingerprint != nil {
			key = *node.URLFingerprint
		} else if node.CanonicalURL != nil {
			key = *node.CanonicalURL
		}
		if key != "" {
			seen[key] = struct{}{}
		}
	}
	countsByPageType := newPageTypeCountObject()
	for _, node := range existing {
		bumpObjectCount(countsByPageType, node.PageType)
	}
	budgets := ComputeFrontierPageTypeBudgets(options.Run.MaxDepth, options.Run.MaxPages)
	remainingBudget := options.Run.MaxPages - len(existing)
	if remainingBudget < 0 {
		remainingBudget = 0
	}
	paginationKeepCount := clampInt(configLayeredNumber(options.Profile.Config, "paginationKeepCount"), 1, 10, 3)
	listPagesCreated, created := 0, 0

	if qualityPassed {
		prioritized := PrioritizeCandidates("home", normalized)
		for index, candidate := range prioritized {
			branchSnapshot := buildCandidateSnapshot(CandidateSnapshot{
				URL: candidate.URL, PageType: candidate.PageType, Status: "active",
			})
			freshnessSnapshot := buildCandidateSnapshot(CandidateSnapshot{
				URL: candidate.URL, PageType: candidate.PageType, FreshnessScore: &candidate.FreshnessScore, Status: "active",
			})
			activeSnapshot := buildCandidateSnapshot(CandidateSnapshot{
				URL: candidate.URL, PageType: candidate.PageType, Score: &candidate.Score,
				FreshnessScore: &candidate.FreshnessScore, Status: "active",
			})
			base := candidateDecision{WorkflowRunID: options.WorkflowRunID, SourceNodeID: options.Node.ID,
				Candidate: candidate, NodeID: options.Node.ID}
			// Seed candidate entered the root seed branch.
			step := base
			step.NodeType, step.Action, step.Message = "branch", "branched", "Seed candidate entered the root seed branch"
			step.Status, step.Accepted = "active", boolPointer(true)
			step.RuleHits = []string{"seed_branch_selected"}
			step.BeforeSnapshot, step.AfterSnapshot = branchSnapshot, branchSnapshot
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
			// Freshness scored.
			step = base
			step.NodeType, step.Action, step.Message = "freshness-scorer", "scored", "Seed candidate freshness scored from sitemap signals"
			step.Status, step.Accepted = "active", boolPointer(true)
			step.FreshnessDelta = &candidate.FreshnessScore
			step.RuleHits = []string{"freshness_scored"}
			step.BeforeSnapshot, step.AfterSnapshot = branchSnapshot, freshnessSnapshot
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
			// URL scored.
			step = base
			step.NodeType, step.Action, step.Message = "url-scorer", "scored", "Seed candidate scored for frontier persistence"
			step.Status, step.Accepted = "active", boolPointer(true)
			step.ScoreDelta = &candidate.Score
			step.RuleHits = []string{"url_scored", "seed_scored"}
			step.BeforeSnapshot, step.AfterSnapshot = freshnessSnapshot, activeSnapshot
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
			if created >= remainingBudget {
				bumpObjectCount(rejectionCounts, "run_budget_exhausted")
				step = base
				step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected seed candidate because run budget was exhausted"
				step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("run_budget_exhausted")
				step.RuleHits = []string{"run_budget_exhausted"}
				step.BeforeSnapshot = activeSnapshot
				step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
					Status: "rejected", RejectedReason: stringPointer("run_budget_exhausted")})
				if err := s.recordCandidateDecision(ctx, step); err != nil {
					return seedOutcome{}, err
				}
				break
			}
			if pageTypeCount(countsByPageType, candidate.PageType) >= budgets.Get(candidate.PageType) {
				bumpObjectCount(rejectionCounts, "page_type_budget")
				step = base
				step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected seed candidate because page type budget was exhausted"
				step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("page_type_budget")
				step.RuleHits = []string{"page_type_budget"}
				step.BeforeSnapshot = activeSnapshot
				step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
					Status: "rejected", RejectedReason: stringPointer("page_type_budget")})
				if err := s.recordCandidateDecision(ctx, step); err != nil {
					return seedOutcome{}, err
				}
				continue
			}
			canonical := BuildCanonicalURLFingerprint(candidate.URL, configStringListOrNil(options.Profile.Config, "urlQueryParamAllowlist"))
			dedupeKey := candidate.URL
			if canonical != nil {
				dedupeKey = canonical.Fingerprint
			}
			if _, exists := seen[dedupeKey]; exists {
				bumpObjectCount(rejectionCounts, "duplicate")
				duplicate := candidate
				duplicate.Metadata = mustJSON(mergeObjects(candidate.metadataObject(), NewObjectFromPairs(
					"canonicalUrl", nullableValue(canonicalString(canonical, false)),
					"urlFingerprint", nullableValue(canonicalString(canonical, true)),
				)))
				step = base
				step.Candidate = duplicate
				step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected duplicate seed candidate"
				step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("duplicate")
				step.RuleHits = []string{"duplicate"}
				step.BeforeSnapshot = activeSnapshot
				step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
					Status: "rejected", RejectedReason: stringPointer("duplicate")})
				if err := s.recordCandidateDecision(ctx, step); err != nil {
					return seedOutcome{}, err
				}
				continue
			}
			if candidate.PageType == "list" && listPagesCreated >= paginationKeepCount {
				bumpObjectCount(rejectionCounts, "pagination_limit")
				step = base
				step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected seed candidate because pagination keep limit was exhausted"
				step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("pagination_limit")
				step.RuleHits = []string{"pagination_limit"}
				step.BeforeSnapshot = activeSnapshot
				step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
					Status: "rejected", RejectedReason: stringPointer("pagination_limit")})
				if err := s.recordCandidateDecision(ctx, step); err != nil {
					return seedOutcome{}, err
				}
				continue
			}
			queueClass := ResolveNodeQueueClass(candidate.PageType)
			step = base
			step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Kept seed candidate within materialization budget"
			step.Status, step.Accepted = "active", boolPointer(true)
			step.RuleHits = []string{"kept_by_budget"}
			step.BeforeSnapshot, step.AfterSnapshot = activeSnapshot, activeSnapshot
			step.Details = NewObjectFromPairs("queueClass", queueClass, "rank", index+1)
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}

			depth := 1
			if candidate.PageType == "article" {
				depth = options.Run.MaxDepth
				if depth > 3 {
					depth = 3
				}
			}
			nodeMetadata := mergeObjects(candidate.metadataObject(), NewObjectFromPairs(
				"sourceTier", configStringOr(options.Profile.Config, "sourceTier", "tier2"),
			))
			nodeID, nodeStatus, createdNode, persistErr := s.persistFrontierNode(ctx, persistNodeInput{
				RunID: options.Run.ID, ParentNodeID: options.Node.ID, OrgID: options.Node.OrgID,
				URL: candidate.URL, CanonicalURL: canonicalString(canonical, false),
				URLFingerprint: canonicalString(canonical, true), PageType: candidate.PageType,
				Depth: depth, QueueClass: queueClass, Status: "queued", Score: &candidate.Score,
				FreshnessScore: &candidate.FreshnessScore, QueuedAt: s.nowISO(), Metadata: nodeMetadata,
			})
			if persistErr != nil {
				return seedOutcome{}, persistErr
			}
			seen[dedupeKey] = struct{}{}
			if createdNode {
				bumpObjectCount(countsByPageType, candidate.PageType)
				created++
				if candidate.PageType == "list" {
					listPagesCreated++
				}
			}
			if createdNode || nodeStatus == "pending" {
				if err := s.enqueueNode(ctx, options.Node.OrgID, options.TaskID, options.Run.ID, nodeID, queueClass); err != nil {
					return seedOutcome{}, err
				}
			}
			persisted := candidate
			persisted.Metadata = mustJSON(mergeObjects(candidate.metadataObject(), NewObjectFromPairs(
				"canonicalUrl", nullableValue(canonicalString(canonical, false)),
				"urlFingerprint", nullableValue(canonicalString(canonical, true)),
				"queuedNodeId", nodeID, "queueClass", queueClass,
			)))
			step = base
			step.Candidate = persisted
			step.NodeType, step.Action, step.Message = "persist-result", "persisted", "Seed candidate materialized into queued frontier node"
			step.Status, step.Accepted = "selected", boolPointer(true)
			step.RuleHits = []string{"selected_for_persistence", "queued_frontier_node"}
			step.BeforeSnapshot = activeSnapshot
			step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType, Status: "selected"})
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
		}
	} else if options.WorkflowRunID != "" {
		for _, candidate := range normalized {
			branchSnapshot := buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType, Status: "active"})
			freshnessSnapshot := buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
				FreshnessScore: &candidate.FreshnessScore, Status: "active"})
			activeSnapshot := buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
				Score: &candidate.Score, FreshnessScore: &candidate.FreshnessScore, Status: "active"})
			base := candidateDecision{WorkflowRunID: options.WorkflowRunID, SourceNodeID: options.Node.ID,
				Candidate: candidate, NodeID: options.Node.ID}
			step := base
			step.NodeType, step.Action, step.Message = "branch", "branched", "Seed candidate entered the root seed branch"
			step.Status, step.Accepted = "active", boolPointer(true)
			step.RuleHits = []string{"seed_branch_selected"}
			step.BeforeSnapshot, step.AfterSnapshot = branchSnapshot, branchSnapshot
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
			step = base
			step.NodeType, step.Action, step.Message = "freshness-scorer", "scored", "Seed candidate freshness scored from sitemap signals"
			step.Status, step.Accepted = "active", boolPointer(true)
			step.FreshnessDelta = &candidate.FreshnessScore
			step.RuleHits = []string{"freshness_scored"}
			step.BeforeSnapshot, step.AfterSnapshot = branchSnapshot, freshnessSnapshot
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
			step = base
			step.NodeType, step.Action, step.Message = "url-scorer", "scored", "Seed candidate scored for frontier persistence"
			step.Status, step.Accepted = "active", boolPointer(true)
			step.ScoreDelta = &candidate.Score
			step.RuleHits = []string{"url_scored", "seed_scored"}
			step.BeforeSnapshot, step.AfterSnapshot = freshnessSnapshot, activeSnapshot
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
			step = base
			step.NodeType, step.Action, step.Message = "content-filter", "filtered", "Seed candidate dropped by the seed quality gate"
			step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("seed_low_quality")
			step.RuleHits = []string{"seed_low_quality"}
			step.BeforeSnapshot = activeSnapshot
			step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
				Status: "rejected", RejectedReason: stringPointer("seed_low_quality")})
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return seedOutcome{}, err
			}
		}
	}

	if options.WorkflowRunID != "" && (!qualityPassed || created == 0) {
		triggerReason := "seed_no_nodes_created"
		if !qualityPassed {
			triggerReason = "seed_low_quality"
		}
		details := NewObject()
		details.SetBool("qualityPassed", qualityPassed)
		details.SetNumber("articleRatio", articleRatio)
		details.SetNumber("noiseRatio", noiseRatio)
		details.SetNumber("freshRatio", freshRatio)
		details.SetRaw("qualityThresholds", mustJSON(qualityThresholdsObject(thresholds)))
		if err := s.AppendEvent(ctx, options.WorkflowRunID, WorkflowEvent{
			Level: "warn", EventType: "seed_to_frontier_fallback", NodeID: &options.Node.ID,
			NodeType:      stringPointer("fallback-strategy"),
			Message:       "Seed discovery did not produce durable nodes; frontier path remains active",
			TriggerReason: stringPointer(triggerReason), BeforeCount: intPointer(selectedCount),
			AfterCount: intPointer(created), RescuedCount: intPointer(created), Details: details,
			Timestamp: s.nowISO(),
		}); err != nil {
			return seedOutcome{}, err
		}
	}

	if options.WorkflowRunID != "" {
		metrics := NewObject()
		metrics.SetBool("qualityPassed", qualityPassed)
		metrics.SetNumber("articleRatio", articleRatio)
		metrics.SetNumber("noiseRatio", noiseRatio)
		metrics.SetNumber("freshRatio", freshRatio)
		metrics.SetRaw("selectedPageTypeCounts", mustJSON(selectedPageTypeCounts))
		metrics.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
		metrics.SetRaw("qualityThresholds", mustJSON(qualityThresholdsObject(thresholds)))
		step := WorkflowStep{
			StepKey: fmt.Sprintf("frontier:%s:materialize-seed", options.Node.ID),
			NodeID:  fmt.Sprintf("legacy::seed:%s", options.Node.ID), NodeType: "seed-discovery",
			Label: "Materialize sitemap seed candidates", Status: "completed",
			InputCount: len(normalized), OutputCount: created,
			RejectedCount: totalCount(rejectionCounts), SampleURLs: firstURLs(normalized, 5), Metrics: metrics,
		}
		if !qualityPassed {
			step.Status = "failed"
			step.Error = stringPointer("seed_low_quality")
		}
		if err := s.UpsertStep(ctx, options.WorkflowRunID, step); err != nil {
			return seedOutcome{}, err
		}
	}

	seedYield := NewObject()
	seedYield.SetNumber("discovered", float64(candidateCount))
	seedYield.SetNumber("selected", float64(selectedCount))
	seedYield.SetNumber("created", float64(created))
	seedYield.SetNumber("fresh", float64(freshCount))
	seedQuality := NewObject()
	seedQuality.SetBool("passed", qualityPassed)
	seedQuality.SetNumber("articleRatio", articleRatio)
	seedQuality.SetNumber("noiseRatio", noiseRatio)
	seedQuality.SetNumber("freshRatio", freshRatio)
	seedQuality.SetRaw("thresholds", mustJSON(qualityThresholdsObject(thresholds)))
	warningFlags := uniqueStringList(
		nil,
		conditionalFlag(!qualityPassed, "seed_low_quality"),
		conditionalFlag(created == 0, "seed_no_nodes_created"),
		llmDiagnosticFlags(options.LlmDiagnostics),
	)
	diagnosticsOut := NewObject()
	diagnosticsOut.SetString("seedOrigin", "sitemap")
	seedMethodValue := ""
	if options.SitemapDiagnostics != nil {
		seedMethodValue, _ = options.SitemapDiagnostics.String("seedMethod")
	}
	seedDiscoveryMode := ""
	if options.SitemapDiagnostics != nil {
		seedDiscoveryMode, _ = options.SitemapDiagnostics.String("discoveryMode")
	}
	diagnosticsOut.SetRaw("seedMethod", nullableRawString(stringPointer(seedMethodValue)))
	diagnosticsOut.SetRaw("seedDiscoveryMode", nullableRawString(stringPointer(seedDiscoveryMode)))
	diagnosticsOut.SetRaw("seedDiagnostics", mustJSON(objectOrEmpty(options.SitemapDiagnostics)))
	diagnosticsOut.SetRaw("seedYield", mustJSON(seedYield))
	diagnosticsOut.SetRaw("seedQuality", mustJSON(seedQuality))
	diagnosticsOut.SetRaw("seedSelectedPageTypeCounts", mustJSON(selectedPageTypeCounts))
	diagnosticsOut.SetRaw("seedRejectionCounts", mustJSON(rejectionCounts))
	fallbackStage := "frontier"
	if qualityPassed && created > 0 {
		fallbackStage = "seed"
	}
	diagnosticsOut.SetString("fallbackStage", fallbackStage)
	diagnosticsOut.Set("warningFlags", warningFlags)
	candidateStats := NewObject()
	candidateStats.SetNumber("scanned", float64(candidateCount))
	candidateStats.SetNumber("unique", float64(candidateCount))
	candidateStats.SetNumber("accepted", float64(selectedCount))
	candidateStats.SetNumber("selected", float64(created))
	candidateStats.SetNumber("rejected", float64(totalCount(rejectionCounts)))
	trimmed := selectedCount - created
	if trimmed < 0 {
		trimmed = 0
	}
	candidateStats.SetNumber("trimmed", float64(trimmed))
	diagnosticsOut.SetRaw("candidateStats", mustJSON(candidateStats))
	diagnosticsOut.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
	merged := mergeObjects(diagnosticsOut, options.LlmDiagnostics)
	if merged == nil {
		merged = diagnosticsOut
	}
	return seedOutcome{Created: created, Diagnostics: merged, PageTypeCount: selectedPageTypeCounts}, nil
}

// DiscoverMaterializeOptions is the discovery materialization input.
type DiscoverMaterializeOptions struct {
	WorkflowRunID         string
	Node                  *NodeRecord
	RunID                 string
	TaskID                string
	MaxDepth              int
	MaxPages              int
	Profile               *ProfileRecord
	Candidates            []Candidate
	ExtractionDiagnostics *Object
	LlmDiagnostics        *Object
	MaxDepthOverride      *int
	MaxNewNodes           *int
	MetadataPatch         *Object
}

// materializeDiscoveredCandidates ports layeredExecutor.materializeDiscoveredCandidates.
func (s *Service) materializeDiscoveredCandidates(ctx context.Context, options DiscoverMaterializeOptions) (*Object, error) {
	effectiveMaxDepth := options.MaxDepth
	if options.MaxDepthOverride != nil && *options.MaxDepthOverride < effectiveMaxDepth {
		effectiveMaxDepth = *options.MaxDepthOverride
	}
	childDepth := options.Node.Depth + 1
	extraction := objectOrEmpty(options.ExtractionDiagnostics)
	if childDepth > effectiveMaxDepth {
		for _, candidate := range options.Candidates {
			step := candidateDecision{
				WorkflowRunID: options.WorkflowRunID, SourceNodeID: options.Node.ID,
				Candidate: candidate, NodeID: options.Node.ID,
				NodeType: "branch", Action: "branched",
				Message: "Rejected candidate because the discovery branch exceeded the effective depth limit",
				Status:  "rejected", Accepted: boolPointer(false), RejectedReason: stringPointer("depth_exhausted"),
				RuleHits:       []string{"depth_exhausted"},
				BeforeSnapshot: buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType, Status: "active"}),
				AfterSnapshot: buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
					Status: "rejected", RejectedReason: stringPointer("depth_exhausted")}),
				Details: NewObjectFromPairs("childDepth", childDepth, "effectiveMaxDepth", effectiveMaxDepth),
			}
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return nil, err
			}
		}
		if options.WorkflowRunID != "" {
			details := NewObjectFromPairs("childDepth", childDepth, "effectiveMaxDepth", effectiveMaxDepth)
			if err := s.AppendEvent(ctx, options.WorkflowRunID, WorkflowEvent{
				Level: "warn", EventType: "branch_depth_exhausted", NodeID: &options.Node.ID,
				NodeType:      stringPointer("branch"),
				Message:       "Discovery branch stopped because effective max depth was reached",
				TriggerReason: stringPointer("depth_exhausted"), BeforeCount: intPointer(len(options.Candidates)),
				AfterCount: intPointer(0), RescuedCount: intPointer(0), Details: details, Timestamp: s.nowISO(),
			}); err != nil {
				return nil, err
			}
		}
		merged := mergeObjects(extraction, options.LlmDiagnostics)
		if merged == nil {
			merged = NewObject()
		}
		merged.Set("warningFlags", uniqueStringList(
			objectStrings(extraction, "warningFlags"),
			objectStrings(options.LlmDiagnostics, "warningFlags"),
			[]string{"depth_exhausted"},
		))
		return merged, nil
	}
	if len(options.Candidates) == 0 {
		if options.WorkflowRunID != "" {
			details := NewObject()
			details.SetRaw("llmDiagnostics", nullableObject(options.LlmDiagnostics))
			if err := s.AppendEvent(ctx, options.WorkflowRunID, WorkflowEvent{
				Level: "warn", EventType: "branch_empty_candidate_set", NodeID: &options.Node.ID,
				NodeType:      stringPointer("branch"),
				Message:       "Discovery branch produced no materializable candidates",
				TriggerReason: stringPointer("llm_dropped_all_candidates"), BeforeCount: intPointer(0),
				AfterCount: intPointer(0), RescuedCount: intPointer(0), Details: details, Timestamp: s.nowISO(),
			}); err != nil {
				return nil, err
			}
		}
		merged := mergeObjects(extraction, options.LlmDiagnostics)
		if merged == nil {
			merged = NewObject()
		}
		merged.Set("warningFlags", uniqueStringList(
			objectStrings(extraction, "warningFlags"),
			objectStrings(options.LlmDiagnostics, "warningFlags"),
			[]string{"llm_dropped_all_candidates"},
		))
		return merged, nil
	}

	budgets := ComputeFrontierPageTypeBudgets(effectiveMaxDepth, options.MaxPages)
	existing, err := s.listExistingNodes(ctx, options.RunID)
	if err != nil {
		return nil, err
	}
	existingCount := len(existing)
	remainingBudget := options.MaxPages - existingCount
	if remainingBudget < 0 {
		remainingBudget = 0
	}
	creationBudget := remainingBudget
	if options.MaxNewNodes != nil {
		requested := roundToFixed(float64(*options.MaxNewNodes), 0)
		if requested < 0 {
			requested = 0
		}
		if requested < float64(remainingBudget) {
			creationBudget = int(requested)
		}
	}
	rejectionCounts := NewObject()
	if counts, ok := options.ExtractionDiagnostics.Object("rejectionCounts"); ok {
		for _, key := range counts.Keys() {
			raw, _ := counts.Raw(key)
			if value, ok := toFiniteNumber(raw); ok {
				rejectionCounts.SetNumber(key, value)
			}
		}
	}
	baseCandidateStats := toNumericObject(func() *Object {
		if stats, ok := options.ExtractionDiagnostics.Object("candidateStats"); ok {
			return stats
		}
		return nil
	}())
	if baseCandidateStats == nil {
		baseCandidateStats = NewObjectFromPairs(
			"scanned", 0, "unique", 0, "accepted", len(options.Candidates),
			"selected", len(options.Candidates), "rejected", 0, "trimmed", 0,
		)
	}
	if creationBudget == 0 {
		bumpObjectCount(rejectionCounts, "run_budget_exhausted")
		for _, candidate := range options.Candidates {
			step := candidateDecision{
				WorkflowRunID: options.WorkflowRunID, SourceNodeID: options.Node.ID,
				Candidate: candidate, NodeID: options.Node.ID,
				NodeType: "budget-control", Action: "budgeted",
				Message: "Rejected candidate because the run budget was already exhausted",
				Status:  "rejected", Accepted: boolPointer(false), RejectedReason: stringPointer("run_budget_exhausted"),
				RuleHits:       []string{"run_budget_exhausted"},
				BeforeSnapshot: buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType, Status: "active"}),
				AfterSnapshot: buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
					Status: "rejected", RejectedReason: stringPointer("run_budget_exhausted")}),
				Details: NewObjectFromPairs("existingCount", existingCount, "maxPages", options.MaxPages),
			}
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return nil, err
			}
		}
		if options.WorkflowRunID != "" {
			details := NewObjectFromPairs("existingCount", existingCount, "maxPages", options.MaxPages)
			if err := s.AppendEvent(ctx, options.WorkflowRunID, WorkflowEvent{
				Level: "warn", EventType: "budget_exhausted", NodeID: &options.Node.ID,
				NodeType:      stringPointer("budget-control"),
				Message:       "Discovery branch had no remaining run budget",
				TriggerReason: stringPointer("run_budget_exhausted"), BeforeCount: intPointer(len(options.Candidates)),
				AfterCount: intPointer(0), RescuedCount: intPointer(0), Details: details, Timestamp: s.nowISO(),
			}); err != nil {
				return nil, err
			}
		}
		merged := mergeObjects(extraction, options.LlmDiagnostics, rejectionCounts)
		if merged == nil {
			merged = NewObject()
		}
		merged.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
		stats := baseCandidateStats.Clone()
		stats.SetNumber("selected", 0)
		stats.SetNumber("rejected", float64(totalCount(rejectionCounts)))
		merged.SetRaw("candidateStats", mustJSON(stats))
		return merged, nil
	}

	seen := map[string]struct{}{}
	for _, node := range existing {
		key := ""
		if node.URLFingerprint != nil {
			key = *node.URLFingerprint
		} else if node.CanonicalURL != nil {
			key = *node.CanonicalURL
		}
		if key != "" {
			seen[key] = struct{}{}
		}
	}
	countsByPageType := newPageTypeCountObject()
	for _, node := range existing {
		bumpObjectCount(countsByPageType, node.PageType)
	}
	paginationKeepCount := clampInt(configLayeredNumber(options.Profile.Config, "paginationKeepCount"), 1, 10, 3)
	created, listPagesCreated := 0, 0
	selectedPageTypeCounts := newPageTypeCountObject()
	prioritized := PrioritizeCandidates(options.Node.PageType, options.Candidates)
	for _, candidate := range prioritized {
		activeSnapshot := buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
			Score: &candidate.Score, FreshnessScore: &candidate.FreshnessScore, Status: "active"})
		base := candidateDecision{WorkflowRunID: options.WorkflowRunID, SourceNodeID: options.Node.ID,
			Candidate: candidate, NodeID: options.Node.ID}
		if created >= creationBudget {
			bumpObjectCount(rejectionCounts, "run_budget_exhausted")
			step := base
			step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected candidate because run budget was exhausted"
			step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("run_budget_exhausted")
			step.RuleHits = []string{"run_budget_exhausted"}
			step.BeforeSnapshot = activeSnapshot
			step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
				Status: "rejected", RejectedReason: stringPointer("run_budget_exhausted")})
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return nil, err
			}
			break
		}
		if pageTypeCount(countsByPageType, candidate.PageType) >= budgets.Get(candidate.PageType) {
			bumpObjectCount(rejectionCounts, "page_type_budget")
			step := base
			step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected candidate because page type budget was exhausted"
			step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("page_type_budget")
			step.RuleHits = []string{"page_type_budget"}
			step.BeforeSnapshot = activeSnapshot
			step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
				Status: "rejected", RejectedReason: stringPointer("page_type_budget")})
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return nil, err
			}
			continue
		}
		canonical := BuildCanonicalURLFingerprint(candidate.URL, configStringListOrNil(options.Profile.Config, "urlQueryParamAllowlist"))
		dedupeKey := candidate.URL
		if canonical != nil {
			dedupeKey = canonical.Fingerprint
		}
		if _, exists := seen[dedupeKey]; exists {
			bumpObjectCount(rejectionCounts, "duplicate")
			duplicate := candidate
			duplicate.Metadata = mustJSON(mergeObjects(candidate.metadataObject(), NewObjectFromPairs(
				"canonicalUrl", nullableValue(canonicalString(canonical, false)),
				"urlFingerprint", nullableValue(canonicalString(canonical, true)),
			)))
			step := base
			step.Candidate = duplicate
			step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected duplicate candidate"
			step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("duplicate")
			step.RuleHits = []string{"duplicate"}
			step.BeforeSnapshot = activeSnapshot
			step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
				Status: "rejected", RejectedReason: stringPointer("duplicate")})
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return nil, err
			}
			continue
		}
		if candidate.PageType == "list" && listPagesCreated >= paginationKeepCount {
			bumpObjectCount(rejectionCounts, "pagination_limit")
			step := base
			step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Rejected candidate because pagination keep limit was exhausted"
			step.Status, step.Accepted, step.RejectedReason = "rejected", boolPointer(false), stringPointer("pagination_limit")
			step.RuleHits = []string{"pagination_limit"}
			step.BeforeSnapshot = activeSnapshot
			step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType,
				Status: "rejected", RejectedReason: stringPointer("pagination_limit")})
			if err := s.recordCandidateDecision(ctx, step); err != nil {
				return nil, err
			}
			continue
		}
		queueClass := ResolveNodeQueueClass(candidate.PageType)
		step := base
		step.NodeType, step.Action, step.Message = "budget-control", "budgeted", "Kept candidate within layered materialization budget"
		step.Status, step.Accepted = "active", boolPointer(true)
		step.RuleHits = []string{"kept_by_budget"}
		step.BeforeSnapshot, step.AfterSnapshot = activeSnapshot, activeSnapshot
		step.Details = NewObjectFromPairs("queueClass", queueClass)
		if err := s.recordCandidateDecision(ctx, step); err != nil {
			return nil, err
		}

		nodeMetadata := mergeObjects(candidate.metadataObject(), NewObjectFromPairs(
			"sourceTier", configStringOr(options.Profile.Config, "sourceTier", "tier2"),
		), options.MetadataPatch)
		nodeID, nodeStatus, createdNode, persistErr := s.persistFrontierNode(ctx, persistNodeInput{
			RunID: options.RunID, ParentNodeID: options.Node.ID, OrgID: options.Node.OrgID,
			URL: candidate.URL, CanonicalURL: canonicalString(canonical, false),
			URLFingerprint: canonicalString(canonical, true), PageType: candidate.PageType,
			Depth: childDepth, QueueClass: queueClass, Status: "queued", Score: &candidate.Score,
			FreshnessScore: &candidate.FreshnessScore, QueuedAt: s.nowISO(), Metadata: nodeMetadata,
		})
		if persistErr != nil {
			return nil, persistErr
		}
		seen[dedupeKey] = struct{}{}
		if createdNode {
			bumpObjectCount(countsByPageType, candidate.PageType)
			bumpObjectCount(selectedPageTypeCounts, candidate.PageType)
			created++
			if candidate.PageType == "list" {
				listPagesCreated++
			}
		}
		if createdNode || nodeStatus == "pending" {
			if err := s.enqueueNode(ctx, options.Node.OrgID, options.TaskID, options.RunID, nodeID, queueClass); err != nil {
				return nil, err
			}
		}
		persisted := candidate
		persisted.Metadata = mustJSON(mergeObjects(candidate.metadataObject(), NewObjectFromPairs(
			"canonicalUrl", nullableValue(canonicalString(canonical, false)),
			"urlFingerprint", nullableValue(canonicalString(canonical, true)),
			"queuedNodeId", nodeID, "queueClass", queueClass,
		)))
		step = base
		step.Candidate = persisted
		step.NodeType, step.Action, step.Message = "persist-result", "persisted", "Candidate materialized into queued frontier node"
		step.Status, step.Accepted = "selected", boolPointer(true)
		step.RuleHits = []string{"selected_for_persistence", "queued_frontier_node"}
		step.BeforeSnapshot = activeSnapshot
		step.AfterSnapshot = buildCandidateSnapshot(CandidateSnapshot{URL: candidate.URL, PageType: candidate.PageType, Status: "selected"})
		if err := s.recordCandidateDecision(ctx, step); err != nil {
			return nil, err
		}
	}

	if options.WorkflowRunID != "" {
		metrics := NewObject()
		metrics.SetNumber("creationBudget", float64(creationBudget))
		metrics.SetRaw("selectedPageTypeCounts", mustJSON(selectedPageTypeCounts))
		metrics.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
		if err := s.UpsertStep(ctx, options.WorkflowRunID, WorkflowStep{
			StepKey: fmt.Sprintf("frontier:%s:materialize-discovery", options.Node.ID),
			NodeID:  fmt.Sprintf("legacy::discovery:%s", options.Node.ID), NodeType: "list-discovery",
			Label: "Materialize discovered candidates", Status: "completed",
			InputCount: len(prioritized), OutputCount: created,
			RejectedCount: totalCount(rejectionCounts), SampleURLs: firstURLs(prioritized, 5), Metrics: metrics,
		}); err != nil {
			return nil, err
		}
	}

	merged := mergeObjects(extraction, options.LlmDiagnostics)
	if merged == nil {
		merged = NewObject()
	}
	merged.SetRaw("rejectionCounts", mustJSON(rejectionCounts))
	merged.SetRaw("selectedPageTypeCounts", mustJSON(selectedPageTypeCounts))
	stats := baseCandidateStats.Clone()
	if dropped, ok := options.LlmDiagnostics.Number("llmJudgeDropped"); ok {
		stats.SetNumber("llmJudgeDropped", dropped)
	}
	stats.SetNumber("budgeted", float64(creationBudget))
	stats.SetNumber("selected", float64(created))
	stats.SetNumber("rejected", float64(totalCount(rejectionCounts)))
	merged.SetRaw("candidateStats", mustJSON(stats))
	merged.Set("warningFlags", uniqueStringList(
		objectStrings(extraction, "warningFlags"),
		objectStrings(options.LlmDiagnostics, "warningFlags"),
		conditionalFlag(created == 0, "no_child_nodes_created"),
	))
	return merged, nil
}

// recordCandidateDecision ports layeredExecutor.recordCandidateDecision.
func (s *Service) recordCandidateDecision(ctx context.Context, decision candidateDecision) error {
	if decision.WorkflowRunID == "" {
		return nil
	}
	candidate := s.toWorkflowCandidate(decision.SourceNodeID, decision.Candidate, decision.Status, decision.RejectedReason, decision.NodeID)
	after := decision.AfterSnapshot
	if after == nil {
		after = buildCandidateSnapshotFromCandidate(candidate)
	}
	return s.RecordCandidateTrace(ctx, decision.WorkflowRunID, candidate, TraceEntry{
		NodeID: decision.NodeID, NodeType: decision.NodeType, Action: decision.Action,
		Message: decision.Message, Accepted: decision.Accepted,
		ScoreDelta: decision.ScoreDelta, FreshnessDelta: decision.FreshnessDelta,
		RuleHits: decision.RuleHits, RejectedReason: decision.RejectedReason,
		BeforeSnapshot: decision.BeforeSnapshot, AfterSnapshot: after,
		Details: decision.Details, Timestamp: s.nowISO(),
	})
}

// candidateDecision is the recordCandidateDecision argument set.
type candidateDecision struct {
	WorkflowRunID  string
	SourceNodeID   string
	Candidate      Candidate
	NodeID         string
	NodeType       string
	Action         string
	Message        string
	Status         string
	Accepted       *bool
	RejectedReason *string
	RuleHits       []string
	BeforeSnapshot *Object
	AfterSnapshot  *Object
	ScoreDelta     *float64
	FreshnessDelta *float64
	Details        *Object
}

// CandidateSnapshot is buildCandidateSnapshot's input.
type CandidateSnapshot struct {
	URL            string
	PageType       string
	Score          *float64
	FreshnessScore *float64
	RelevanceScore *float64
	Status         string
	RejectedReason *string
}

// buildCandidateSnapshot ports buildCandidateSnapshot.
func buildCandidateSnapshot(input CandidateSnapshot) *Object {
	out := NewObject()
	out.SetString("url", input.URL)
	out.SetRaw("pageType", nullableRawString(stringPointer(input.PageType)))
	out.SetRaw("score", nullableNumber(input.Score))
	out.SetRaw("freshnessScore", nullableNumber(input.FreshnessScore))
	out.SetRaw("relevanceScore", nullableNumber(input.RelevanceScore))
	out.SetRaw("status", nullableRawString(stringPointer(input.Status)))
	out.SetRaw("rejectedReason", nullableRawString(input.RejectedReason))
	return out
}

func buildCandidateSnapshotFromCandidate(candidate TraceCandidate) *Object {
	status := candidate.Status
	rejected := candidate.RejectedReason
	return buildCandidateSnapshot(CandidateSnapshot{
		URL: candidate.URL, PageType: derefString(candidate.PageType), Score: candidate.Score,
		FreshnessScore: candidate.FreshnessScore, RelevanceScore: candidate.RelevanceScore,
		Status: status, RejectedReason: rejected,
	})
}

// toWorkflowCandidate ports toWorkflowCandidate.
func (s *Service) toWorkflowCandidate(sourceNodeID string, candidate Candidate, status string, rejectedReason *string, rejectedByNodeID string) TraceCandidate {
	metadata := candidate.metadataObject()
	candidateKey := candidate.URL
	if fingerprint, ok := metadata.String("urlFingerprint"); ok {
		candidateKey = fingerprint
	} else if canonical, ok := metadata.String("canonicalUrl"); ok {
		candidateKey = canonical
	}
	metadata = mergeObjects(metadata, NewObjectFromPairs("candidateKey", candidateKey))
	if metadata == nil {
		metadata = NewObject()
	}
	out := TraceCandidate{
		ID:       sourceNodeID + ":" + candidate.URL,
		URL:      candidate.URL,
		PageType: stringPointer(candidate.PageType),
		Score:    &candidate.Score, FreshnessScore: &candidate.FreshnessScore,
		Status: status, RejectedByNodeID: stringPointer(rejectedByNodeID),
		RejectedReason: rejectedReason, SourceNodeID: sourceNodeID, Metadata: metadata,
		Trace: []TraceEntry{},
	}
	if publishedAt, ok := metadata.String("seedPublishedAt"); ok {
		out.PublishedAt = &publishedAt
	}
	if crawledAt, ok := metadata.String("seedCrawledAt"); ok {
		out.CrawledAt = &crawledAt
	}
	if out.PublishedAt != nil {
		out.EffectiveAt = out.PublishedAt
	} else if out.CrawledAt != nil {
		out.EffectiveAt = out.CrawledAt
	}
	return out
}

// persistNodeInput is persistFrontierNode's argument set.
type persistNodeInput struct {
	RunID          string
	ParentNodeID   string
	OrgID          string
	URL            string
	CanonicalURL   *string
	URLFingerprint *string
	PageType       string
	Depth          int
	QueueClass     string
	Status         string
	Score          *float64
	FreshnessScore *float64
	QueuedAt       string
	Metadata       *Object
}

// persistFrontierNode ports persistFrontierNode: a fingerprint is looked up
// first and a duplicate-key race falls back to the existing row.
func (s *Service) persistFrontierNode(ctx context.Context, input persistNodeInput) (nodeID, status string, created bool, err error) {
	fingerprint := ""
	if input.URLFingerprint != nil {
		fingerprint = jsTrim(*input.URLFingerprint)
	}
	if fingerprint == "" || input.RunID == "" {
		nodeID, err = s.createNode(ctx, NodeRecord{
			RunID: input.RunID, ParentNodeID: stringPointer(input.ParentNodeID), OrgID: input.OrgID,
			URL: input.URL, CanonicalURL: input.CanonicalURL, URLFingerprint: input.URLFingerprint,
			PageType: input.PageType, Depth: input.Depth, QueueClass: input.QueueClass,
			Status: input.Status, Score: input.Score, FreshnessScore: input.FreshnessScore,
			QueuedAt: stringPointer(input.QueuedAt), Metadata: input.Metadata,
		})
		if err != nil {
			return "", "", false, err
		}
		return nodeID, input.Status, true, nil
	}
	if existingID, existingStatus, found, lookupErr := s.findNodeByFingerprint(ctx, input.RunID, fingerprint); lookupErr != nil {
		return "", "", false, lookupErr
	} else if found {
		return existingID, existingStatus, false, nil
	}
	nodeID, err = s.createNode(ctx, NodeRecord{
		RunID: input.RunID, ParentNodeID: stringPointer(input.ParentNodeID), OrgID: input.OrgID,
		URL: input.URL, CanonicalURL: input.CanonicalURL, URLFingerprint: &fingerprint,
		PageType: input.PageType, Depth: input.Depth, QueueClass: input.QueueClass,
		Status: input.Status, Score: input.Score, FreshnessScore: input.FreshnessScore,
		QueuedAt: stringPointer(input.QueuedAt), Metadata: input.Metadata,
	})
	if err == nil {
		return nodeID, input.Status, true, nil
	}
	if isDuplicateKeyError(err) {
		if racedID, racedStatus, found, lookupErr := s.findNodeByFingerprint(ctx, input.RunID, fingerprint); lookupErr == nil && found {
			return racedID, racedStatus, false, nil
		}
	}
	return "", "", false, err
}

func (s *Service) enqueueNode(ctx context.Context, orgID, taskID, runID, nodeID, queueClass string) error {
	if s.enqueuer == nil {
		return nil
	}
	return s.enqueuer.EnqueueFrontierNode(ctx, crawlqueue.EnqueueFrontierNodeOptions{
		OrgID: orgID, TaskID: taskID, FrontierRunID: runID, FrontierNodeID: nodeID,
		PriorityClass: crawlqueue.PriorityClass(queueClass),
	})
}

// NewObjectFromPairs builds an ordered object from alternating key/value pairs.
func NewObjectFromPairs(pairs ...any) *Object {
	object := NewObject()
	for index := 0; index+1 < len(pairs); index += 2 {
		key, ok := pairs[index].(string)
		if !ok {
			continue
		}
		value := pairs[index+1]
		if value == nil {
			object.SetNull(key)
			continue
		}
		object.Set(key, value)
	}
	return object
}

func nullableValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func canonicalString(canonical *CanonicalURL, fingerprint bool) *string {
	if canonical == nil {
		return nil
	}
	if fingerprint {
		return &canonical.Fingerprint
	}
	return &canonical.CanonicalURL
}

func configStringOr(config *Object, key, fallback string) string {
	if config != nil {
		if value, ok := config.String(key); ok {
			return value
		}
	}
	return fallback
}

func configStringListOrNil(config *Object, key string) []string {
	if config == nil {
		return nil
	}
	values, ok := config.Strings(key)
	if !ok {
		return nil
	}
	return values
}

func configLayeredNumber(config *Object, key string) any {
	if config == nil {
		return nil
	}
	layered, ok := config.Object("layeredOptions")
	if !ok {
		return nil
	}
	raw, ok := layered.Raw(key)
	if !ok {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

func clampInt(value any, min, max, fallback int) int {
	if value == nil {
		return fallback
	}
	number, ok := toFiniteNumber(mustJSON(value))
	if !ok {
		return fallback
	}
	rounded := roundToFixed(number, 0)
	if rounded < float64(min) {
		return min
	}
	if rounded > float64(max) {
		return max
	}
	return int(rounded)
}

func newPageTypeCountObject() *Object {
	return NewObjectFromPairs("home", 0, "category", 0, "list", 0, "article", 0)
}

func pageTypeCount(counts *Object, pageType string) int {
	value, ok := counts.Number(pageType)
	if !ok {
		return 0
	}
	return int(value)
}

func totalCount(counts *Object) int {
	total := 0
	if counts == nil {
		return 0
	}
	for _, key := range counts.Keys() {
		if value, ok := counts.Number(key); ok {
			total += int(value)
		}
	}
	return total
}

func firstURLs(candidates []Candidate, limit int) []string {
	out := make([]string, 0, limit)
	for index, candidate := range candidates {
		if index >= limit {
			break
		}
		out = append(out, candidate.URL)
	}
	return out
}

func conditionalFlag(condition bool, flag string) []string {
	if !condition {
		return nil
	}
	return []string{flag}
}

func objectStrings(object *Object, key string) []string {
	if object == nil {
		return nil
	}
	values, ok := object.Strings(key)
	if !ok {
		return nil
	}
	return values
}

func llmDiagnosticFlags(diagnostics *Object) []string {
	return objectStrings(diagnostics, "warningFlags")
}

func nullableObject(object *Object) json.RawMessage {
	if object == nil {
		return json.RawMessage("null")
	}
	return mustJSON(object)
}

func qualityThresholdsObject(thresholds qualityThresholds) *Object {
	return NewObjectFromPairs(
		"minCandidates", thresholds.MinCandidates,
		"minArticleRatio", thresholds.MinArticleRatio,
		"maxNoiseRatio", thresholds.MaxNoiseRatio,
		"minFreshRatio", thresholds.MinFreshRatio,
	)
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
