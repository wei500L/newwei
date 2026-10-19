package crawlworkflow

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// This file ports the three workflow→runtime bridges of
// apps/api/src/modules/crawl/crawl-strategy-workflow.service.ts that the crawl
// discovery entries need:
//
//   - resolveBoundWorkflowVersion (:380-427)
//   - compileProfileOverlay (:429-576)
//   - compileNewsSourceOverlay (:578-671)
//
// applyProfileOverlay/mergeProfileConfigPatch stay in package crawlprofile, which
// owns the profile configuration normalization the merge must run through.
//
// Resolution order and error text are the source's: an explicit
// workflowVersionId wins and a missing/foreign version is 404 "Workflow version
// not found"; otherwise the workflow's published version is used, a missing
// workflow is 404 "Workflow not found" and a workflow without a published
// version is 400 "Workflow has no published version". The path workflowId is not
// compared with version.workflowId, like the source.

// ParameterSource is CrawlStrategyParameterSource.
type ParameterSource struct {
	Key    string          `json:"key"`
	Value  json.RawMessage `json:"value"`
	Source string          `json:"source"`
}

// WorkflowSummary is the workflowSummary object of both overlays.
type WorkflowSummary struct {
	WorkflowID        string `json:"workflowId"`
	WorkflowVersionID string `json:"workflowVersionId"`
	WorkflowName      string `json:"workflowName"`
	Version           int    `json:"version"`
}

// ResolvedWorkflow is the resolveBoundWorkflowVersion result.
type ResolvedWorkflow struct {
	WorkflowID   string
	WorkflowName string
	VersionID    string
	Version      int
	// VersionName is the version document's own name (resolved.version.name).
	VersionName string
	Definition  WorkflowDefinition
}

// CompiledProfileOverlay is CrawlStrategyCompiledProfileOverlay.
type CompiledProfileOverlay struct {
	ExecutionMode    string
	ConfigPatch      json.RawMessage
	ParameterSources []ParameterSource
	WorkflowSummary  WorkflowSummary
}

// CompiledNewsSourceOverlay is CrawlStrategyCompiledNewsSourceOverlay.
type CompiledNewsSourceOverlay struct {
	CrawlOptions     json.RawMessage
	Seed             json.RawMessage
	Keywords         []string
	ParameterSources []ParameterSource
	WorkflowSummary  WorkflowSummary
}

// ResolveBoundWorkflowVersion ports resolveBoundWorkflowVersion.
func (s *Service) ResolveBoundWorkflowVersion(ctx context.Context, orgID, workflowID, workflowVersionID string) (*ResolvedWorkflow, error) {
	if versionID := strings.TrimSpace(workflowVersionID); versionID != "" {
		version, err := loadVersionByID(ctx, s.db, versionID)
		if err != nil {
			return nil, err
		}
		if version.OrgID != orgID {
			return nil, errVersionMissing
		}
		workflow, err := s.loadWorkflow(ctx, s.db, version.WorkflowID)
		if err != nil {
			if errors.Is(err, errWorkflowMissing) {
				// Prisma's `include: { workflow: true }` yields null for a
				// dangling relation; the runtime would then fail on
				// workflow.name. Reporting the workflow as missing is the same
				// 404 the caller sees for an absent workflow.
				return nil, errWorkflowMissing
			}
			return nil, err
		}
		return &ResolvedWorkflow{
			WorkflowID:   workflow.ID,
			WorkflowName: workflow.Name,
			VersionID:    version.ID,
			Version:      version.Version,
			VersionName:  version.Name,
			Definition:   normalizeDefinition(version.Definition),
		}, nil
	}

	workflowID = strings.TrimSpace(workflowID)
	if workflowID == "" {
		return nil, nil
	}
	workflow, err := s.loadWorkflow(ctx, s.db, workflowID)
	if err != nil {
		return nil, err
	}
	if workflow.OrgID != orgID {
		return nil, errWorkflowMissing
	}
	if !workflow.PublishedVersionID.Valid {
		return nil, newStatus(400, "Workflow has no published version")
	}
	version, err := loadVersionByID(ctx, s.db, workflow.PublishedVersionID.String)
	if err != nil {
		return nil, err
	}
	return &ResolvedWorkflow{
		WorkflowID:   workflow.ID,
		WorkflowName: workflow.Name,
		VersionID:    version.ID,
		Version:      version.Version,
		VersionName:  version.Name,
		Definition:   normalizeDefinition(version.Definition),
	}, nil
}

// CompileProfileOverlay ports compileProfileOverlay. baseConfig is the
// normalized profile config JSON; it only contributes the layeredOptions and
// nativeOptions spreads.
func (s *Service) CompileProfileOverlay(
	ctx context.Context,
	orgID string,
	baseExecutionMode string,
	baseConfig json.RawMessage,
	workflowID string,
	workflowVersionID string,
) (*CompiledProfileOverlay, error) {
	resolved, err := s.ResolveBoundWorkflowVersion(ctx, orgID, workflowID, workflowVersionID)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, nil
	}
	definition := resolved.Definition
	base, _ := decodeRawObject(baseConfig)
	patch := map[string]json.RawMessage{}
	sources := []ParameterSource{}

	patch["hostScope"] = rawOf("registrable_domain")
	if definition.Settings.DomainScope == "strict_hosts" {
		patch["hostScope"] = rawOf("strict_hosts")
	}
	sources = append(sources, newParameterSource("settings.domainScope", rawOf(definition.Settings.DomainScope)))

	robotsRespected := definition.Settings.RobotsPolicy == "respect"
	patch["crawlOptions"] = rawOf(map[string]any{"check_robots_txt": robotsRespected})
	sources = append(sources, newParameterSource("settings.robotsPolicy", rawOf(definition.Settings.RobotsPolicy)))

	layeredOptions := map[string]any{}
	if fields, ok := decodeRawObject(base["layeredOptions"]); ok {
		layeredOptions = rawFieldsToAny(fields)
	}
	layeredOptions["maxDepth"] = definition.Settings.MaxDepth
	layeredOptions["maxPages"] = definition.Settings.MaxPages
	patch["layeredOptions"] = rawOf(layeredOptions)

	for _, node := range definition.Nodes {
		config, _ := decodeRawObject(node.Config)
		switch node.Type {
		case "url-filter":
			patch["blockedDomains"] = rawOf(jsToStringList(config["blockedDomains"], 0))
			patch["allowedHosts"] = rawOf(jsToStringList(config["allowedHosts"], 0))
			patch["denyKeywords"] = rawOf(jsToStringList(config["denyKeywords"], 0))
			urlPatterns := map[string]any{}
			if fields, ok := decodeRawObject(patch["urlPatterns"]); ok {
				urlPatterns = rawFieldsToAny(fields)
			}
			urlPatterns["exclude"] = jsToStringList(config["excludePatterns"], 0)
			urlPatterns["article"] = jsToStringList(config["includePatterns"], 0)
			patch["urlPatterns"] = rawOf(urlPatterns)
			sources = append(sources, newParameterSource("nodes."+node.ID, cloneRaw(node.Config)))
		case "page-type-classifier":
			if jsonIsObjectRaw(config["urlPatterns"]) {
				urlPatterns := map[string]any{}
				if fields, ok := decodeRawObject(patch["urlPatterns"]); ok {
					urlPatterns = rawFieldsToAny(fields)
				}
				if fields, ok := decodeRawObject(config["urlPatterns"]); ok {
					for key, value := range fields {
						urlPatterns[key] = cloneRaw(value)
					}
				}
				patch["urlPatterns"] = rawOf(urlPatterns)
			}
			if jsonIsObjectRaw(config["pageTypeSignals"]) {
				signals := map[string]any{}
				if fields, ok := decodeRawObject(patch["pageTypeSignals"]); ok {
					signals = rawFieldsToAny(fields)
				}
				if fields, ok := decodeRawObject(config["pageTypeSignals"]); ok {
					for key, value := range fields {
						signals[key] = cloneRaw(value)
					}
				}
				patch["pageTypeSignals"] = rawOf(signals)
			}
		case "url-scorer":
			keywords := jsToStringList(config["keywordBoosts"], 0)
			patch["keywords"] = rawOf(keywords)
			patch["priorityKeywords"] = rawOf(keywords)
			sources = append(sources, newParameterSource("nodes."+node.ID+".keywordBoosts", rawOf(keywords)))
		case "freshness-scorer":
			rules := map[string]any{
				"recentHours": rawNumberOr(config["recentHours"], 24),
				"weekHours":   rawNumberOr(config["weekHours"], 24*7),
				"monthHours":  rawNumberOr(config["monthHours"], 24*30),
			}
			patch["freshnessRules"] = rawOf(rules)
			sources = append(sources, newParameterSource("nodes."+node.ID, rawOf(rules)))
		case "budget-control":
			layered := map[string]any{}
			if fields, ok := decodeRawObject(patch["layeredOptions"]); ok {
				layered = rawFieldsToAny(fields)
			}
			layered["scoreThreshold"] = rawNumberOr(config["minScore"], 0)
			layered["maxPages"] = rawNumberOr(config["maxPages"], definition.Settings.MaxPages)
			layered["maxDepth"] = rawNumberOr(config["maxDepth"], definition.Settings.MaxDepth)
			patch["layeredOptions"] = rawOf(layered)
			sources = append(sources, newParameterSource("nodes."+node.ID, cloneRaw(node.Config)))
		case "deep-discovery":
			seed := map[string]any{}
			if fields, ok := decodeRawObject(patch["seedDiscovery"]); ok {
				seed = rawFieldsToAny(fields)
			}
			seed["maxSeedUrls"] = rawNumberOr(config["maxUrls"], 60)
			patch["seedDiscovery"] = rawOf(seed)
			native := map[string]any{}
			if fields, ok := decodeRawObject(base["nativeOptions"]); ok {
				native = rawFieldsToAny(fields)
			}
			native["fallbackToLayered"] = true
			patch["nativeOptions"] = rawOf(native)
		}
	}

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
	seed := map[string]any{"enabled": true}
	crawlOptions := map[string]any{
		"check_robots_txt": definition.Settings.RobotsPolicy == "respect",
	}
	sources := []ParameterSource{
		newParameterSource("settings.robotsPolicy", rawOf(definition.Settings.RobotsPolicy)),
	}
	keywords := []string{}

	for _, node := range definition.Nodes {
		config, _ := decodeRawObject(node.Config)
		switch node.Type {
		case "seed-discovery":
			mode := "sitemap"
			if value, ok := jsString(config["mode"]); ok && value == "rss" {
				mode = "rss"
			}
			seed["mode"] = mode
			seed["domain"] = optionalString(config["domain"])
			seed["pattern"] = optionalString(config["pattern"])
			seed["feedUrl"] = optionalString(config["feedUrl"])
			seed["maxUrls"] = rawNumberOr(config["maxUrls"], 40)
		case "list-discovery":
			seed["mode"] = "list"
			seed["domain"] = optionalString(config["domain"])
			seed["pattern"] = optionalString(config["pattern"])
			seed["maxUrls"] = rawNumberOr(config["maxUrls"], 60)
			seed["listMaxPages"] = rawNumberOr(config["listMaxPages"], 6)
			seed["listPageConcurrency"] = rawNumberOr(config["listPageConcurrency"], 2)
			seed["followPagination"] = !isStrictFalse(config["followPagination"])
		case "deep-discovery":
			seed["mode"] = "deep"
			seed["domain"] = optionalString(config["domain"])
			seed["pattern"] = optionalString(config["pattern"])
			seed["query"] = optionalString(config["query"])
			seed["maxUrls"] = rawNumberOr(config["maxUrls"], 60)
			if jsonIsObjectRaw(config["deep"]) {
				seed["deep"] = cloneRaw(config["deep"])
			} else {
				seed["deep"] = map[string]any{}
			}
		case "url-scorer":
			keywords = jsToStringList(config["keywordBoosts"], 0)
		case "budget-control":
			seed["maxNewUrlsPerRun"] = rawNumberOr(config["keepTopK"], 20)
			seed["scoreThreshold"] = rawNumberOr(config["minScore"], 0)
		}
	}

	nodeList := make([]map[string]any, 0, len(definition.Nodes))
	for _, node := range definition.Nodes {
		nodeList = append(nodeList, map[string]any{"id": node.ID, "type": node.Type})
	}
	sources = append(sources, newParameterSource("nodes", rawOf(nodeList)))

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

// MergeNewsSourceConfig implements NewsSourceService.mergeWorkflowSourceConfig:
// the workflow overlay wins over the stored news-source config for keywords,
// crawlOptions and seed.
func MergeNewsSourceConfig(config json.RawMessage, overlay *CompiledNewsSourceOverlay) json.RawMessage {
	if overlay == nil {
		return config
	}
	base, _ := decodeRawObject(config)
	merged := map[string]any{}
	for key, value := range base {
		var decoded any
		if err := json.Unmarshal(value, &decoded); err == nil {
			merged[key] = decoded
		}
	}
	if len(overlay.Keywords) > 0 {
		merged["keywords"] = overlay.Keywords
	}
	merged["crawlOptions"] = mergeObjectField(base["crawlOptions"], overlay.CrawlOptions)
	merged["seed"] = mergeObjectField(base["seed"], overlay.Seed)
	return rawOf(merged)
}

// mergeObjectField spreads `overlay` over the base object.
func mergeObjectField(base json.RawMessage, overlay json.RawMessage) map[string]any {
	merged := map[string]any{}
	if fields, ok := decodeRawObject(base); ok {
		merged = rawFieldsToAny(fields)
	}
	if fields, ok := decodeRawObject(overlay); ok {
		for key, value := range fields {
			merged[key] = cloneRaw(value)
		}
	}
	return merged
}

// ApplyProfileOverlay implements applyProfileOverlay + mergeProfileConfigPatch:
// the patch wins field by field while urlPatterns, pageTypeSignals,
// freshnessRules, layeredOptions and crawlOptions are merged per key.
func ApplyProfileOverlay(baseConfig json.RawMessage, patch json.RawMessage) json.RawMessage {
	base, _ := decodeRawObject(baseConfig)
	patchFields, _ := decodeRawObject(patch)
	merged := map[string]any{}
	for key, value := range base {
		var decoded any
		if err := json.Unmarshal(value, &decoded); err == nil {
			merged[key] = decoded
		}
	}
	for key, value := range patchFields {
		if isMergeableConfigKey(key) {
			merged[key] = mergeObjectField(base[key], value)
			continue
		}
		var decoded any
		if err := json.Unmarshal(value, &decoded); err == nil {
			merged[key] = decoded
		}
	}
	for _, key := range []string{"urlPatterns", "pageTypeSignals", "freshnessRules", "layeredOptions", "crawlOptions"} {
		if _, ok := merged[key]; !ok {
			merged[key] = map[string]any{}
		}
	}
	return rawOf(merged)
}

func isMergeableConfigKey(key string) bool {
	switch key {
	case "urlPatterns", "pageTypeSignals", "freshnessRules", "layeredOptions", "crawlOptions":
		return true
	}
	return false
}

// newParameterSource builds one parameterSources entry.
func newParameterSource(key string, value json.RawMessage) ParameterSource {
	return ParameterSource{Key: key, Value: value, Source: "workflow"}
}

// rawFieldsToAny decodes every field into a JSON value for object spreading.
func rawFieldsToAny(fields map[string]json.RawMessage) map[string]any {
	out := make(map[string]any, len(fields))
	for key, value := range fields {
		var decoded any
		if err := json.Unmarshal(value, &decoded); err == nil {
			out[key] = decoded
		}
	}
	return out
}

// rawNumberOr mirrors `toNumber(value, fallback)`: only a finite JSON number is
// accepted.
func rawNumberOr(raw json.RawMessage, fallback float64) float64 {
	if value, ok := jsNumber(raw); ok {
		return value
	}
	return fallback
}

// optionalString mirrors `toString` (trimmed non-empty string or null).
func optionalString(raw json.RawMessage) any {
	value, ok := jsString(raw)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}
