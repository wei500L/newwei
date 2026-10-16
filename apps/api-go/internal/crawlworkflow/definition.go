package crawlworkflow

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// WorkflowNodePosition 对齐 CrawlStrategyWorkflowNodePosition。
type WorkflowNodePosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// WorkflowNode 对齐 CrawlStrategyWorkflowNodeDefinition。uiState 在
// NestJS 里是 `undefined` 时被 JSON.stringify 省略——Go 侧用 omitempty。
type WorkflowNode struct {
	ID       string               `json:"id"`
	Type     string               `json:"type"`
	Label    string               `json:"label"`
	Position WorkflowNodePosition `json:"position"`
	Config   json.RawMessage      `json:"config"`
	UIState  json.RawMessage      `json:"uiState,omitempty"`
}

// WorkflowEdge 对齐 CrawlStrategyWorkflowEdgeDefinition。sourceHandle/
// targetHandle/condition/priority 在 NestJS 里是 `undefined` 时省略。
type WorkflowEdge struct {
	ID           string   `json:"id"`
	Source       string   `json:"source"`
	Target       string   `json:"target"`
	SourceHandle *string  `json:"sourceHandle,omitempty"`
	TargetHandle *string  `json:"targetHandle,omitempty"`
	Condition    *string  `json:"condition,omitempty"`
	Priority     *float64 `json:"priority,omitempty"`
}

// WorkflowSettings 对齐 CrawlStrategyWorkflowSettings（键序与 NestJS
// 对象字面量一致）。
type WorkflowSettings struct {
	ExecutionMode string  `json:"executionMode"`
	MaxDepth      float64 `json:"maxDepth"`
	MaxPages      float64 `json:"maxPages"`
	TimeoutMs     float64 `json:"timeoutMs"`
	Concurrency   float64 `json:"concurrency"`
	RobotsPolicy  string  `json:"robotsPolicy"`
	DomainScope   string  `json:"domainScope"`
}

// WorkflowMetadata 对齐 CrawlStrategyWorkflowDefinition['metadata']。
type WorkflowMetadata struct {
	Description string   `json:"description"`
	Template    string   `json:"template"`
	Tags        []string `json:"tags"`
}

// WorkflowDefinition 对齐 CrawlStrategyWorkflowDefinition。
type WorkflowDefinition struct {
	Version  int              `json:"version"`
	Metadata WorkflowMetadata `json:"metadata"`
	Settings WorkflowSettings `json:"settings"`
	Nodes    []WorkflowNode   `json:"nodes"`
	Edges    []WorkflowEdge   `json:"edges"`
}

// createEmptyWorkflowDefinition 逐字段镜像 crawl-strategy.types.ts 的
// createEmptyWorkflowDefinition（含 7 节点、6 边与全部默认 config）。
func createEmptyWorkflowDefinition(seedURL string) WorkflowDefinition {
	quotedSeed, _ := json.Marshal(seedURL)
	return WorkflowDefinition{
		Version: 1,
		Metadata: WorkflowMetadata{
			Description: "Unified crawl strategy workflow",
			Template:    "blank",
			Tags:        []string{},
		},
		Settings: WorkflowSettings{
			ExecutionMode: "hybrid",
			MaxDepth:      3,
			MaxPages:      60,
			TimeoutMs:     15000,
			Concurrency:   2,
			RobotsPolicy:  "respect",
			DomainScope:   "registrable_domain",
		},
		Nodes: []WorkflowNode{
			{
				ID:       "seed-discovery",
				Type:     "seed-discovery",
				Label:    "Seed Discovery",
				Position: WorkflowNodePosition{X: 80, Y: 120},
				Config:   json.RawMessage(`{"mode":"sitemap","seedUrl":` + string(quotedSeed) + `,"maxUrls":40}`),
			},
			{
				ID:       "url-filter",
				Type:     "url-filter",
				Label:    "URL Filter",
				Position: WorkflowNodePosition{X: 360, Y: 120},
				Config:   json.RawMessage(`{"includePatterns":[],"excludePatterns":[],"blockedDomains":[],"allowedHosts":[],"denyKeywords":[]}`),
			},
			{
				ID:       "page-type-classifier",
				Type:     "page-type-classifier",
				Label:    "Page Type",
				Position: WorkflowNodePosition{X: 640, Y: 120},
				Config:   json.RawMessage(`{}`),
			},
			{
				ID:       "url-scorer",
				Type:     "url-scorer",
				Label:    "URL Score",
				Position: WorkflowNodePosition{X: 920, Y: 120},
				Config:   json.RawMessage(`{"keywordBoosts":[]}`),
			},
			{
				ID:       "freshness-scorer",
				Type:     "freshness-scorer",
				Label:    "Freshness",
				Position: WorkflowNodePosition{X: 1200, Y: 120},
				Config:   json.RawMessage(`{"recentHours":24,"weekHours":168,"monthHours":720}`),
			},
			{
				ID:       "budget-control",
				Type:     "budget-control",
				Label:    "Budget Control",
				Position: WorkflowNodePosition{X: 1480, Y: 120},
				Config:   json.RawMessage(`{"keepTopK":20,"maxPages":60,"maxDepth":3,"minScore":0}`),
			},
			{
				ID:       "persist-result",
				Type:     "persist-result",
				Label:    "Persist Result",
				Position: WorkflowNodePosition{X: 1760, Y: 120},
				Config:   json.RawMessage(`{"selectTopK":20}`),
			},
		},
		Edges: []WorkflowEdge{
			{ID: "seed-discovery->url-filter", Source: "seed-discovery", Target: "url-filter"},
			{ID: "url-filter->page-type-classifier", Source: "url-filter", Target: "page-type-classifier"},
			{ID: "page-type-classifier->url-scorer", Source: "page-type-classifier", Target: "url-scorer"},
			{ID: "url-scorer->freshness-scorer", Source: "url-scorer", Target: "freshness-scorer"},
			{ID: "freshness-scorer->budget-control", Source: "freshness-scorer", Target: "budget-control"},
			{ID: "budget-control->persist-result", Source: "budget-control", Target: "persist-result"},
		},
	}
}

// normalizeDefinition 镜像 CrawlStrategyWorkflowService.normalizeWorkflowDefinition
// （apps/api/src/modules/crawl/crawl-strategy-workflow.service.ts:675-768）。
// raw 来自请求体字段或 MySQL JSON 列；空/非对象一律回到空定义。
func normalizeDefinition(raw []byte) WorkflowDefinition {
	base := createEmptyWorkflowDefinition("")
	fields, ok := decodeRawObject(raw)
	if !ok {
		return base
	}

	settings, _ := decodeRawObject(fields["settings"])

	nodes := base.Nodes
	if items, ok := decodeRawArray(fields["nodes"]); ok {
		filtered := make([]json.RawMessage, 0, len(items))
		for _, item := range items {
			if jsonIsObjectRaw(item) {
				filtered = append(filtered, item)
			}
		}
		nodes = make([]WorkflowNode, 0, len(filtered))
		for index, item := range filtered {
			entry, _ := decodeRawObject(item)
			nodes = append(nodes, normalizeNode(entry, index, base))
		}
	}

	edges := base.Edges
	if items, ok := decodeRawArray(fields["edges"]); ok {
		filtered := make([]json.RawMessage, 0, len(items))
		for _, item := range items {
			if jsonIsObjectRaw(item) {
				filtered = append(filtered, item)
			}
		}
		mapped := make([]WorkflowEdge, 0, len(filtered))
		for index, item := range filtered {
			entry, _ := decodeRawObject(item)
			mapped = append(mapped, normalizeEdge(entry, index))
		}
		edges = make([]WorkflowEdge, 0, len(mapped))
		for _, edge := range mapped {
			if edge.Source != "" && edge.Target != "" {
				edges = append(edges, edge)
			}
		}
	}

	metadata := base.Metadata
	if md, ok := decodeRawObject(fields["metadata"]); ok {
		metadata = WorkflowMetadata{
			Description: stringOr(md["description"], base.Metadata.Description),
			Template:    stringOr(md["template"], base.Metadata.Template),
			Tags:        jsStringArray(md["tags"]),
		}
	}

	return WorkflowDefinition{
		Version:  1,
		Metadata: metadata,
		Settings: normalizeSettings(settings, base.Settings),
		Nodes:    nodes,
		Edges:    edges,
	}
}

func normalizeNode(entry map[string]json.RawMessage, index int, base WorkflowDefinition) WorkflowNode {
	var schema nodeSchemaInfo
	hasSchema := false
	if typeName, ok := jsString(entry["type"]); ok {
		schema, hasSchema = getNodeSchema(typeName)
	}
	var baseNode *WorkflowNode
	if index < len(base.Nodes) {
		baseNode = &base.Nodes[index]
	}

	nodeType := "seed-discovery"
	if hasSchema {
		nodeType = schema.Type
	} else if baseNode != nil {
		nodeType = baseNode.Type
	}

	idPrefix := "node"
	if hasSchema {
		idPrefix = schema.Type
	} else if baseNode != nil {
		idPrefix = baseNode.Type
	}
	id := ""
	if trimmed := jsTrimmed(entry["id"]); trimmed != nil {
		id = *trimmed
	} else {
		id = idPrefix + "-" + strconv.Itoa(index+1)
	}

	label := ""
	if trimmed := jsTrimmed(entry["label"]); trimmed != nil {
		label = *trimmed
	} else if hasSchema {
		label = schema.DefaultLabel
	} else {
		label = "Node " + strconv.Itoa(index+1)
	}

	position := WorkflowNodePosition{X: float64(index * 240), Y: 120}
	if pos, ok := decodeRawObject(entry["position"]); ok {
		position = WorkflowNodePosition{
			X: jsNumberOr(pos["x"], 0),
			Y: jsNumberOr(pos["y"], 0),
		}
	}

	config := json.RawMessage(`{}`)
	if jsonIsObjectRaw(entry["config"]) {
		config = cloneRaw(entry["config"])
	}
	var uiState json.RawMessage
	if jsonIsObjectRaw(entry["uiState"]) {
		uiState = cloneRaw(entry["uiState"])
	}

	return WorkflowNode{
		ID:       id,
		Type:     nodeType,
		Label:    label,
		Position: position,
		Config:   config,
		UIState:  uiState,
	}
}

func normalizeEdge(entry map[string]json.RawMessage, index int) WorkflowEdge {
	id := ""
	if trimmed := jsTrimmed(entry["id"]); trimmed != nil {
		id = *trimmed
	} else {
		id = "edge-" + strconv.Itoa(index+1)
	}
	source := ""
	if trimmed := jsTrimmed(entry["source"]); trimmed != nil {
		source = *trimmed
	}
	target := ""
	if trimmed := jsTrimmed(entry["target"]); trimmed != nil {
		target = *trimmed
	}
	edge := WorkflowEdge{
		ID:           id,
		Source:       source,
		Target:       target,
		SourceHandle: jsTrimmed(entry["sourceHandle"]),
		TargetHandle: jsTrimmed(entry["targetHandle"]),
		Condition:    jsTrimmed(entry["condition"]),
	}
	if priority, ok := jsNumber(entry["priority"]); ok {
		edge.Priority = &priority
	}
	return edge
}

func normalizeSettings(settings map[string]json.RawMessage, base WorkflowSettings) WorkflowSettings {
	out := base
	if settings == nil {
		return out
	}
	out.ExecutionMode = "hybrid"
	if mode, ok := jsString(settings["executionMode"]); ok {
		switch mode {
		case "layered", "native", "hybrid":
			out.ExecutionMode = mode
		}
	}
	out.MaxDepth = jsNumberOr(settings["maxDepth"], base.MaxDepth)
	out.MaxPages = jsNumberOr(settings["maxPages"], base.MaxPages)
	out.TimeoutMs = jsNumberOr(settings["timeoutMs"], base.TimeoutMs)
	out.Concurrency = jsNumberOr(settings["concurrency"], base.Concurrency)
	out.RobotsPolicy = "respect"
	if robots := jsTrimmed(settings["robotsPolicy"]); robots != nil && *robots == "ignore" {
		out.RobotsPolicy = "ignore"
	}
	out.DomainScope = "registrable_domain"
	if scope := jsTrimmed(settings["domainScope"]); scope != nil {
		switch *scope {
		case "strict_hosts":
			out.DomainScope = "strict_hosts"
		case "inherit_profile":
			out.DomainScope = "inherit_profile"
		}
	}
	return out
}

// assertSupportedWorkflowDefinition 镜像 crawl-config-policy.ts 的
// assertSupportedWorkflowDefinition：只检查每个节点 config.crawlOptions
// 上的 proxyUrl / proxyConfig 自有键。失败消息与 BadRequestException
// 相同（路径前缀用调用方传入的 path，本批固定为 draftDefinition）。
func assertSupportedWorkflowDefinition(definition WorkflowDefinition, path string) error {
	var issues []string
	for index, node := range definition.Nodes {
		config, ok := decodeRawObject(node.Config)
		if !ok {
			continue
		}
		crawlRaw, exists := config["crawlOptions"]
		if !exists || !jsonIsObjectRaw(crawlRaw) {
			continue
		}
		options, _ := decodeRawObject(crawlRaw)
		prefixPath := path + ".nodes[" + strconv.Itoa(index) + "].config.crawlOptions."
		if _, ok := options["proxyUrl"]; ok {
			issues = append(issues, prefixPath+"proxyUrl: custom upstream proxies are not supported")
		}
		if _, ok := options["proxyConfig"]; ok {
			issues = append(issues, prefixPath+"proxyConfig: custom upstream proxies are not supported")
		}
	}
	if len(issues) > 0 {
		return &inputError{Message: "Unsupported crawl config: " + strings.Join(issues, "; ")}
	}
	return nil
}

// ---- JavaScript 值语义小工具（定义/对比/bridge 共用） ----

func decodeRawObject(raw []byte) (map[string]json.RawMessage, bool) {
	if !jsonIsObjectRaw(raw) {
		return nil, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &fields); err != nil || fields == nil {
		return nil, false
	}
	return fields, true
}

func decodeRawArray(raw []byte) ([]json.RawMessage, bool) {
	if !jsonIsArrayRaw(raw) {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &items); err != nil {
		return nil, false
	}
	return items, true
}

// jsonIsObjectRaw 判定原始 JSON 是否是对象（对应 JSON.parse 之后的
// isRecord/typeof object 检查——null/数组/标量都不是）。
func jsonIsObjectRaw(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

func jsonIsArrayRaw(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

func jsString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

func jsNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// jsTrimmed 镜像 service 的 toString：非空字符串返回 trim 后的值，否则
// undefined（Go 用 nil）。
func jsTrimmed(raw json.RawMessage) *string {
	text, ok := jsString(raw)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// jsStringArray 镜像 service 的 toStringArray：非数组返回空数组；
// 元素只保留字符串、trim 后丢弃空串；不去重。
func jsStringArray(raw json.RawMessage) []string {
	out := []string{}
	if !jsonIsArrayRaw(raw) {
		return out
	}
	var items []json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &items); err != nil {
		return out
	}
	for _, item := range items {
		text, ok := jsString(item)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}

func stringOr(raw json.RawMessage, fallback string) string {
	if trimmed := jsTrimmed(raw); trimmed != nil {
		return *trimmed
	}
	return fallback
}

func jsNumberOr(raw json.RawMessage, fallback float64) float64 {
	if value, ok := jsNumber(raw); ok {
		return value
	}
	return fallback
}

func cloneRaw(raw json.RawMessage) json.RawMessage {
	out := make([]byte, len(raw))
	copy(out, raw)
	return out
}
