package crawlworkflow

import (
	"context"
	"encoding/json"
	"strings"
)

// This file ports the bound-workflow resolution and the profile/news-source
// overlay compilation of apps/api/src/modules/crawl/crawl-strategy-workflow.service.ts
// that the crawl discovery entries need:
//
//   - resolveBoundWorkflowVersion (:380-427)
//   - compileProfileOverlay (:429-576)
//   - compileNewsSourceOverlay (:578-671)
//   - applyProfileOverlay (:673-691) with the crawl-strategy-legacy-bridge
//     mergeProfileConfigPatch / resolveExecutionMode helpers.
//
// The workflow CRUD paths keep their existing implementation; this file only
// adds the read/compile entry points used by the trial-run, replay and
// news-source preview runtimes.

// ParameterSource is CrawlStrategyParameterSource. Value stays a raw JSON leaf
// because NestJS stores whatever the node config carried.
type ParameterSource struct {
	Key    string          `json:"key"`
	Value  json.RawMessage `json:"value"`
	Source string          `json:"source"`
}

// WorkflowSummary is the workflowSummary object of the compiled overlays.
type WorkflowSummary struct {
	WorkflowID        string  `json:"workflowId"`
	WorkflowVersionID string  `json:"workflowVersionId"`
	WorkflowName      string  `json:"workflowName"`
	Version           float64 `json:"version"`
}

// BoundWorkflowVersion is the resolveBoundWorkflowVersion result.
type BoundWorkflowVersion struct {
	WorkflowID          string
	WorkflowName        string
	WorkflowDescription *string
	VersionID           string
	Version             float64
	VersionName         string
	Definition          WorkflowDefinition
}

// ResolveBoundWorkflowVersion ports resolveBoundWorkflowVersion. When
// workflowVersionID is present the version is loaded directly (404
// "Workflow version not found" on a miss); otherwise the workflow's published
// version is used (404 "Workflow not found" / 400 "Workflow has no published
// version"). A missing workflowID returns nil, nil.
func (s *Service) ResolveBoundWorkflowVersion(ctx context.Context, orgID, workflowID, workflowVersionID string) (*BoundWorkflowVersion, error) {
	orgID = strings.TrimSpace(orgID)
	workflowVersionID = strings.TrimSpace(workflowVersionID)
	workflowID = strings.TrimSpace(workflowID)

	if workflowVersionID != "" {
		version, err := loadVersionByID(ctx, s.db, workflowVersionID)
		if err != nil {
			if isMissing(err) {
				return nil, newStatus(404, "Workflow version not found")
			}
			return nil, err
		}
		if version.OrgID != orgID {
			return nil, newStatus(404, "Workflow version not found")
		}
		workflow, err := loadWorkflow(ctx, s.db, version.WorkflowID)
		if err != nil {
			return nil, err
		}
		return boundFromRows(workflow, version), nil
	}

	if workflowID == "" {
		return nil, nil
	}
	workflow, err := loadWorkflow(ctx, s.db, workflowID)
	if err != nil {
		if isMissing(err) {
			return nil, newStatus(404, "Workflow not found")
		}
		return nil, err
	}
	if workflow.OrgID != orgID {
		return nil, newStatus(404, "Workflow not found")
	}
	if !workflow.PublishedVersionID.Valid || workflow.PublishedVersionID.String == "" {
		return nil, newStatus(400, "Workflow has no published version")
	}
	version, err := loadVersionByID(ctx, s.db, workflow.PublishedVersionID.String)
	if err != nil {
		return nil, err
	}
	return boundFromRows(workflow, version), nil
}

func boundFromRows(workflow workflowRow, version versionRow) *BoundWorkflowVersion {
	var description *string
	if workflow.Description.Valid {
		value := workflow.Description.String
		description = &value
	}
	return &BoundWorkflowVersion{
		WorkflowID:          workflow.ID,
		WorkflowName:        workflow.Name,
		WorkflowDescription: description,
		VersionID:           version.ID,
		Version:             float64(version.Version),
		VersionName:         version.Name,
		Definition:          normalizeDefinition(version.Definition),
	}
}

func isMissing(err error) bool {
	if err == nil {
		return false
	}
	if typed, ok := err.(*statusError); ok {
		return typed.status == 404
	}
	return false
}

// CompiledProfileOverlay is CrawlStrategyCompiledProfileOverlay.
type CompiledProfileOverlay struct {
	ExecutionMode    string
	ConfigPatch      json.RawMessage
	ParameterSources []ParameterSource
	WorkflowSummary  WorkflowSummary
}

// CompileProfileOverlay ports compileProfileOverlay.
func (s *Service) CompileProfileOverlay(ctx context.Context, orgID, workflowID, workflowVersionID string) (*CompiledProfileOverlay, error) {
	resolved, err := s.ResolveBoundWorkflowVersion(ctx, orgID, workflowID, workflowVersionID)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, nil
	}
	definition := resolved.Definition
	patch := map[string]json.RawMessage{}
	sources := []ParameterSource{}

	domainScope := "registrable_domain"
	if definition.Settings.DomainScope == "strict_hosts" {
		domainScope = "strict_hosts"
	}
	patch["hostScope"] = rawOf(domainScope)
	sources = append(sources, ParameterSource{Key: "settings.domainScope", Value: rawOf(definition.Settings.DomainScope), Source: "workflow"})

	patch["crawlOptions"] = rawOf(map[string]bool{"check_robots_txt": definition.Settings.RobotsPolicy == "respect"})
	sources = append(sources, ParameterSource{Key: "settings.robotsPolicy", Value: rawOf(definition.Settings.RobotsPolicy), Source: "workflow"})

	urlPatterns := map[string][]string{}
	pageTypeSignals := map[string]json.RawMessage{}
	layered := map[string]float64{
		"maxDepth": definition.Settings.MaxDepth,
		"maxPages": definition.Settings.MaxPages,
	}

	for _, node := range definition.Nodes {
		config := objectFields(node.Config)
		switch node.Type {
		case "url-filter":
			patch["blockedDomains"] = rawOf(jsStringArray(config["blockedDomains"]))
			patch["allowedHosts"] = rawOf(jsStringArray(config["allowedHosts"]))
			patch["denyKeywords"] = rawOf(jsStringArray(config["denyKeywords"]))
			urlPatterns["exclude"] = jsStringArray(config["excludePatterns"])
			urlPatterns["article"] = jsStringArray(config["includePatterns"])
			sources = append(sources, ParameterSource{Key: "nodes." + node.ID, Value: cloneRaw(node.Config), Source: "workflow"})
		case "page-type-classifier":
			if record, ok := decodeRawObject(config["urlPatterns"]); ok {
				for key := range record {
					urlPatterns[key] = jsStringArray(record[key])
				}
			}
			if record, ok := decodeRawObject(config["pageTypeSignals"]); ok {
				for key := range record {
					pageTypeSignals[key] = cloneRaw(record[key])
				}
			}
		case "url-scorer":
			keywords := jsStringArray(config["keywordBoosts"])
			patch["keywords"] = rawOf(keywords)
			patch["priorityKeywords"] = rawOf(keywords)
			sources = append(sources, ParameterSource{Key: "nodes." + node.ID + ".keywordBoosts", Value: rawOf(keywords), Source: "workflow"})
		case "freshness-scorer":
			freshness := map[string]float64{
				"recentHours": jsNumberOr(config["recentHours"], 24),
				"weekHours":   jsNumberOr(config["weekHours"], 24*7),
				"monthHours":  jsNumberOr(config["monthHours"], 24*30),
			}
			patch["freshnessRules"] = rawOf(freshness)
			sources = append(sources, ParameterSource{Key: "nodes." + node.ID, Value: rawOf(freshness), Source: "workflow"})
		case "budget-control":
			layered["scoreThreshold"] = jsNumberOr(config["minScore"], 0)
			layered["maxPages"] = jsNumberOr(config["maxPages"], definition.Settings.MaxPages)
			layered["maxDepth"] = jsNumberOr(config["maxDepth"], definition.Settings.MaxDepth)
			sources = append(sources, ParameterSource{Key: "nodes." + node.ID, Value: cloneRaw(node.Config), Source: "workflow"})
		case "deep-discovery":
			patch["seedDiscovery"] = rawOf(map[string]float64{"maxSeedUrls": jsNumberOr(config["maxUrls"], 60)})
			patch["nativeOptions"] = rawOf(map[string]bool{"fallbackToLayered": true})
		}
	}
	if len(urlPatterns) > 0 {
		patch["urlPatterns"] = rawOf(urlPatterns)
	}
	if len(pageTypeSignals) > 0 {
		patch["pageTypeSignals"] = rawOf(pageTypeSignals)
	}
	patch["layeredOptions"] = rawOf(layered)

	return &CompiledProfileOverlay{
		ExecutionMode:    definition.Settings.ExecutionMode,
		ConfigPatch:      rawOf(patch),
		ParameterSources: sources,
		WorkflowSummary: WorkflowSummary{
			WorkflowID:        resolved.WorkflowID,
			WorkflowVersionID: resolved.VersionID,
			WorkflowName:      resolved.WorkflowName,
			Version:           resolved.Version,
		},
	}, nil
}

// CompiledNewsSourceOverlay is CrawlStrategyCompiledNewsSourceOverlay.
type CompiledNewsSourceOverlay struct {
	CrawlOptions     json.RawMessage
	Seed             json.RawMessage
	Keywords         []string
	ParameterSources []ParameterSource
	WorkflowSummary  WorkflowSummary
}

// CompileNewsSourceOverlay ports compileNewsSourceOverlay.
func (s *Service) CompileNewsSourceOverlay(ctx context.Context, orgID, workflowID, workflowVersionID string) (*CompiledNewsSourceOverlay, error) {
	resolved, err := s.ResolveBoundWorkflowVersion(ctx, orgID, workflowID, workflowVersionID)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, nil
	}
	definition := resolved.Definition
	seed := map[string]json.RawMessage{"enabled": rawOf(true)}
	crawlOptions := map[string]bool{"check_robots_txt": definition.Settings.RobotsPolicy == "respect"}
	sources := []ParameterSource{{Key: "settings.robotsPolicy", Value: rawOf(definition.Settings.RobotsPolicy), Source: "workflow"}}
	keywords := []string{}

	for _, node := range definition.Nodes {
		config := objectFields(node.Config)
		switch node.Type {
		case "seed-discovery":
			mode := "sitemap"
			if stringOr(config["mode"], "") == "rss" {
				mode = "rss"
			}
			seed["mode"] = rawOf(mode)
			seed["domain"] = rawOf(stringOr(config["domain"], ""))
			seed["pattern"] = rawOf(stringOr(config["pattern"], ""))
			seed["feedUrl"] = rawOf(stringOr(config["feedUrl"], ""))
			seed["maxUrls"] = rawOf(jsNumberOr(config["maxUrls"], 40))
		case "list-discovery":
			seed["mode"] = rawOf("list")
			seed["domain"] = rawOf(stringOr(config["domain"], ""))
			seed["pattern"] = rawOf(stringOr(config["pattern"], ""))
			seed["maxUrls"] = rawOf(jsNumberOr(config["maxUrls"], 60))
			seed["listMaxPages"] = rawOf(jsNumberOr(config["listMaxPages"], 6))
			seed["listPageConcurrency"] = rawOf(jsNumberOr(config["listPageConcurrency"], 2))
			seed["followPagination"] = rawOf(!isStrictFalse(config["followPagination"]))
		case "deep-discovery":
			seed["mode"] = rawOf("deep")
			seed["domain"] = rawOf(stringOr(config["domain"], ""))
			seed["pattern"] = rawOf(stringOr(config["pattern"], ""))
			seed["query"] = rawOf(stringOr(config["query"], ""))
			seed["maxUrls"] = rawOf(jsNumberOr(config["maxUrls"], 60))
			if record, ok := decodeRawObject(config["deep"]); ok {
				seed["deep"] = rawOf(record)
			} else {
				seed["deep"] = rawOf(map[string]any{})
			}
		case "url-scorer":
			keywords = jsStringArray(config["keywordBoosts"])
		case "budget-control":
			seed["maxNewUrlsPerRun"] = rawOf(jsNumberOr(config["keepTopK"], 20))
			seed["scoreThreshold"] = rawOf(jsNumberOr(config["minScore"], 0))
		}
	}

	nodeSummaries := make([]map[string]string, 0, len(definition.Nodes))
	for _, node := range definition.Nodes {
		nodeSummaries = append(nodeSummaries, map[string]string{"id": node.ID, "type": node.Type})
	}
	sources = append(sources, ParameterSource{Key: "nodes", Value: rawOf(nodeSummaries), Source: "workflow"})

	return &CompiledNewsSourceOverlay{
		CrawlOptions:     rawOf(crawlOptions),
		Seed:             rawOf(seed),
		Keywords:         keywords,
		ParameterSources: sources,
		WorkflowSummary: WorkflowSummary{
			WorkflowID:        resolved.WorkflowID,
			WorkflowVersionID: resolved.VersionID,
			WorkflowName:      resolved.WorkflowName,
			Version:           resolved.Version,
		},
	}, nil
}

// MergeProfileConfigPatch ports mergeProfileConfigPatch: base and patch are
// JSON config objects, the five nested objects merge key by key and the result
// runs through the shared normalizer by the caller.
func MergeProfileConfigPatch(base, patch json.RawMessage) json.RawMessage {
	baseRecord, _ := decodeRawObject(base)
	patchRecord, _ := decodeRawObject(patch)
	if baseRecord == nil {
		baseRecord = map[string]json.RawMessage{}
	}
	if patchRecord == nil {
		patchRecord = map[string]json.RawMessage{}
	}
	merged := map[string]json.RawMessage{}
	for key, value := range baseRecord {
		merged[key] = value
	}
	for key, value := range patchRecord {
		merged[key] = value
	}
	for _, key := range []string{"urlPatterns", "pageTypeSignals", "freshnessRules", "layeredOptions", "crawlOptions"} {
		baseNested, _ := decodeRawObject(baseRecord[key])
		patchNested, _ := decodeRawObject(patchRecord[key])
		if baseNested == nil && patchNested == nil {
			continue
		}
		mergedNested := map[string]json.RawMessage{}
		for nestedKey, value := range baseNested {
			mergedNested[nestedKey] = value
		}
		for nestedKey, value := range patchNested {
			mergedNested[nestedKey] = value
		}
		merged[key] = rawOf(mergedNested)
	}
	return rawOf(merged)
}

// ProfileExecutionMode resolves `next ?? current`.
func ProfileExecutionMode(current, next string) string {
	if strings.TrimSpace(next) != "" {
		return next
	}
	return current
}

// objectFields decodes an object leaf; a missing or non-object value is empty.
func objectFields(raw json.RawMessage) map[string]json.RawMessage {
	record, ok := decodeRawObject(raw)
	if !ok {
		return map[string]json.RawMessage{}
	}
	return record
}
