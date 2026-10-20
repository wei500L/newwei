package newsnowhottest

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
)

// This file owns the model-labelled cluster insights. The prompt text, sampling
// parameters, response-format name and metadata are byte-identical to
// generateClusterInsights in newsnow-hottest-analysis.service.ts. The parsing
// step reproduces the zod schema: defaults fill missing members, unknown members
// are ignored, and any invalid member rejects the whole response (the caller
// then keeps the heuristic labels, never failing the request).

const (
	clusterInsightFeature  = "newsnow_hottest_cluster_analysis"
	clusterInsightTemp     = 0.15
	clusterInsightTopP     = 0.9
	clusterInsightMaxToken = 1800
)

// clusterPromptMessage is one chat message of the model call.
type clusterPromptMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type clusterPromptItem struct {
	SourceID     string         `json:"sourceId"`
	SourceName   string         `json:"sourceName"`
	Rank         int            `json:"rank"`
	Title        string         `json:"title"`
	HeatText     nullableString `json:"heatText"`
	HoverSummary nullableString `json:"hoverSummary"`
}

type clusterPromptCluster struct {
	ClusterID           string              `json:"clusterId"`
	SourceCount         int                 `json:"sourceCount"`
	RepresentativeTitle string              `json:"representativeTitle"`
	Items               []clusterPromptItem `json:"items"`
}

type clusterPromptPayload struct {
	Clusters []clusterPromptCluster `json:"clusters"`
}

// generateClusterInsights ports generateClusterInsights. It never returns an
// error: a missing composer, an upstream failure or an invalid response all
// produce an empty insight list so the heuristic labels are used.
func (s *Service) generateClusterInsights(ctx context.Context, orgID string, clusters []SignalCluster, signals []SignalSeed) []ClusterInsight {
	if len(clusters) == 0 {
		return []ClusterInsight{}
	}
	if s.completer == nil {
		s.logf("newsnowhottest: cluster insight completer is not configured; using heuristic labels")
		return []ClusterInsight{}
	}
	signalByKey := make(map[string]SignalSeed, len(signals))
	for _, signal := range signals {
		signalByKey[signal.SignalKey] = signal
	}
	payload := clusterPromptPayload{Clusters: make([]clusterPromptCluster, 0, len(clusters))}
	for _, cluster := range clusters {
		items := make([]SignalSeed, 0, len(cluster.ItemKeys))
		for _, itemKey := range cluster.ItemKeys {
			if signal, exists := signalByKey[itemKey]; exists {
				items = append(items, signal)
			}
		}
		sortSignalSeedsByRank(items)
		items = firstN(items, maxPromptItemsPerCluster)
		promptItems := make([]clusterPromptItem, 0, len(items))
		for _, item := range items {
			promptItems = append(promptItems, clusterPromptItem{
				SourceID:     item.SourceID,
				SourceName:   item.SourceName,
				Rank:         item.Rank,
				Title:        item.Title,
				HeatText:     item.HeatText,
				HoverSummary: item.HoverSummary,
			})
		}
		payload.Clusters = append(payload.Clusters, clusterPromptCluster{
			ClusterID:           cluster.ClusterID,
			SourceCount:         len(cluster.SourceIDs),
			RepresentativeTitle: cluster.RepresentativeTitle,
			Items:               promptItems,
		})
	}
	userContent, err := marshalJSON(payload)
	if err != nil {
		s.logf("newsnowhottest: cluster prompt encode failed err=%v", err)
		return []ClusterInsight{}
	}
	systemContent := joinLines(
		"You analyze cross-platform trending-topic clusters from hot-ranking boards.",
		"Return strict JSON only.",
		"For each cluster, normalize the core theme, concise candidate label, short summary, entities, and a coarse content kind.",
		"contentKind should be article, discussion, video, mixed, or unknown.",
		"bridgeEligibleSuggestion should be true only when the cluster likely points to a crawlable article/news report rather than pure discussion, meme, or short video chatter.",
		"Prefer Chinese output when the titles are Chinese.",
	)
	content, err := s.completer.CompleteClusterInsights(ctx, orgID, systemContent, string(userContent), len(payload.Clusters))
	if err != nil {
		s.logf("newsnowhottest: LLM hottest cluster analysis failed; falling back to heuristic labels orgId=%s err=%v", orgID, err)
		return []ClusterInsight{}
	}
	if jsTrim(content) == "" {
		return []ClusterInsight{}
	}
	insights, ok := parseClusterInsightResponse(content)
	if !ok {
		s.logf("newsnowhottest: failed to parse hottest cluster insights JSON orgId=%s", orgID)
		return []ClusterInsight{}
	}
	return insights
}

// joinLines joins prompt lines with a single newline.
func joinLines(lines ...string) string {
	total := 0
	for _, line := range lines {
		total += len(line) + 1
	}
	buffer := make([]byte, 0, total)
	for index, line := range lines {
		if index > 0 {
			buffer = append(buffer, '\n')
		}
		buffer = append(buffer, line...)
	}
	return string(buffer)
}

// sortSignalSeedsByRank is the stable `left.rank - right.rank` sort.
func sortSignalSeedsByRank(items []SignalSeed) {
	// Insertion sort keeps the implementation stable and allocation-free for the
	// five-item prompt slices.
	for index := 1; index < len(items); index++ {
		current := items[index]
		position := index - 1
		for position >= 0 && items[position].Rank > current.Rank {
			items[position+1] = items[position]
			position--
		}
		items[position+1] = current
	}
}

// parseClusterInsightResponse reproduces ClusterInsightResponseSchema.parse plus
// the Map construction. The second result is false when the document violates
// the schema.
func parseClusterInsightResponse(content string) ([]ClusterInsight, bool) {
	extracted, ok := extractFirstJSON(content)
	if !ok {
		return nil, false
	}
	var root struct {
		Clusters json.RawMessage `json:"clusters"`
	}
	if err := json.Unmarshal([]byte(extracted), &root); err != nil {
		return nil, false
	}
	if len(root.Clusters) == 0 {
		return []ClusterInsight{}, true
	}
	if rawIsNull(root.Clusters) {
		return nil, false
	}
	var rawClusters []json.RawMessage
	if err := json.Unmarshal(root.Clusters, &rawClusters); err != nil {
		return nil, false
	}
	if len(rawClusters) > maxLLMClusters {
		return nil, false
	}
	order := make([]string, 0, len(rawClusters))
	byID := make(map[string]ClusterInsight, len(rawClusters))
	for _, raw := range rawClusters {
		insight, ok := parseClusterInsight(raw)
		if !ok {
			return nil, false
		}
		if _, exists := byID[insight.ClusterID]; !exists {
			order = append(order, insight.ClusterID)
		}
		byID[insight.ClusterID] = insight
	}
	insights := make([]ClusterInsight, 0, len(order))
	for _, clusterID := range order {
		insights = append(insights, byID[clusterID])
	}
	return insights, true
}

// rawClusterField holds the raw members of one cluster object.
type rawClusterField struct {
	ClusterID                json.RawMessage `json:"clusterId"`
	Theme                    json.RawMessage `json:"theme"`
	Label                    json.RawMessage `json:"label"`
	Summary                  json.RawMessage `json:"summary"`
	Reason                   json.RawMessage `json:"reason"`
	Topics                   json.RawMessage `json:"topics"`
	Entities                 json.RawMessage `json:"entities"`
	ContentKind              json.RawMessage `json:"contentKind"`
	BridgeEligibleSuggestion json.RawMessage `json:"bridgeEligibleSuggestion"`
	Confidence               json.RawMessage `json:"confidence"`
}

// parseClusterInsight validates one cluster object with the zod rules.
func parseClusterInsight(raw json.RawMessage) (ClusterInsight, bool) {
	var fields rawClusterField
	if err := json.Unmarshal(raw, &fields); err != nil {
		return ClusterInsight{}, false
	}
	if !rawIsObject(raw) {
		return ClusterInsight{}, false
	}
	clusterID, ok := requiredString(fields.ClusterID, 1, 0)
	if !ok {
		return ClusterInsight{}, false
	}
	theme, ok := requiredString(fields.Theme, 1, 80)
	if !ok {
		return ClusterInsight{}, false
	}
	label, ok := requiredString(fields.Label, 1, 80)
	if !ok {
		return ClusterInsight{}, false
	}
	summary, ok := optionalNullableString(fields.Summary, 1, 280)
	if !ok {
		return ClusterInsight{}, false
	}
	reason, ok := optionalNullableString(fields.Reason, 0, 200)
	if !ok {
		return ClusterInsight{}, false
	}
	topics, ok := stringArrayField(fields.Topics, 1, 48, 8)
	if !ok {
		return ClusterInsight{}, false
	}
	entities, ok := entityArrayField(fields.Entities)
	if !ok {
		return ClusterInsight{}, false
	}
	contentKind := ContentUnknown
	if len(fields.ContentKind) > 0 {
		if rawIsNull(fields.ContentKind) {
			return ClusterInsight{}, false
		}
		var value string
		if err := json.Unmarshal(fields.ContentKind, &value); err != nil {
			return ClusterInsight{}, false
		}
		switch ContentKind(value) {
		case ContentArticle, ContentDiscussion, ContentVideo, ContentMixed, ContentUnknown:
			contentKind = ContentKind(value)
		default:
			return ClusterInsight{}, false
		}
	}
	suggestion := false
	if len(fields.BridgeEligibleSuggestion) > 0 {
		if rawIsNull(fields.BridgeEligibleSuggestion) {
			return ClusterInsight{}, false
		}
		if err := json.Unmarshal(fields.BridgeEligibleSuggestion, &suggestion); err != nil {
			return ClusterInsight{}, false
		}
	}
	confidence := 0.5
	if len(fields.Confidence) > 0 {
		if rawIsNull(fields.Confidence) {
			return ClusterInsight{}, false
		}
		if err := json.Unmarshal(fields.Confidence, &confidence); err != nil {
			return ClusterInsight{}, false
		}
		if math.IsNaN(confidence) || math.IsInf(confidence, 0) || confidence < 0 || confidence > 1 {
			return ClusterInsight{}, false
		}
	}
	return ClusterInsight{
		ClusterID:                clusterID,
		Theme:                    theme,
		Label:                    label,
		Summary:                  summary,
		Reason:                   reason,
		Topics:                   topics,
		Entities:                 entities,
		ContentKind:              contentKind,
		BridgeEligibleSuggestion: suggestion,
		Confidence:               confidence,
	}, true
}

// requiredString decodes a required string and applies min/max JS lengths. A
// maxLength of zero means the schema has no upper bound.
func requiredString(raw json.RawMessage, minLength, maxLength int) (string, bool) {
	if len(raw) == 0 || rawIsNull(raw) {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	length := jsLength(value)
	if length < minLength {
		return "", false
	}
	if maxLength > 0 && length > maxLength {
		return "", false
	}
	return value, true
}

// optionalNullableString decodes an absent/null/string member.
func optionalNullableString(raw json.RawMessage, minLength, maxLength int) (nullableString, bool) {
	if len(raw) == 0 || rawIsNull(raw) {
		return nullableString{}, true
	}
	value, ok := requiredString(raw, minLength, maxLength)
	if !ok {
		return nullableString{}, false
	}
	return stringOrNull(value), true
}

// stringArrayField decodes a string array with item bounds and a max item count.
// An absent member defaults to the empty array; an explicit null is invalid.
func stringArrayField(raw json.RawMessage, minLength, maxLength, maxItems int) ([]string, bool) {
	if len(raw) == 0 {
		return []string{}, true
	}
	if rawIsNull(raw) {
		return nil, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, false
	}
	if maxItems > 0 && len(entries) > maxItems {
		return nil, false
	}
	values := make([]string, 0, len(entries))
	for _, entry := range entries {
		value, ok := requiredString(entry, minLength, maxLength)
		if !ok {
			return nil, false
		}
		values = append(values, value)
	}
	return values, true
}

// entityArrayField decodes the entities member.
func entityArrayField(raw json.RawMessage) ([]InsightEntity, bool) {
	if len(raw) == 0 {
		return []InsightEntity{}, true
	}
	if rawIsNull(raw) {
		return nil, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, false
	}
	if len(entries) > 10 {
		return nil, false
	}
	entities := make([]InsightEntity, 0, len(entries))
	for _, entry := range entries {
		if !rawIsObject(entry) {
			return nil, false
		}
		var fields struct {
			Name json.RawMessage `json:"name"`
			Type json.RawMessage `json:"type"`
		}
		if err := json.Unmarshal(entry, &fields); err != nil {
			return nil, false
		}
		name, ok := requiredString(fields.Name, 1, 64)
		if !ok {
			return nil, false
		}
		entityType, ok := optionalNullableString(fields.Type, 0, 32)
		if !ok {
			return nil, false
		}
		entities = append(entities, InsightEntity{Name: name, Type: entityType})
	}
	return entities, true
}

// rawIsNull reports whether the raw member is the JSON null literal.
func rawIsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// rawIsObject reports whether the raw member is a JSON object.
func rawIsObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// extractFirstJSON is extractFirstJson from common/llm-json.ts: strip a markdown
// code fence, find the first { or [, then return the balanced JSON value.
func extractFirstJSON(text string) (string, bool) {
	cleaned := stripMarkdownCodeFence(text)
	start := -1
	if objectStart := indexByteString(cleaned, '{'); objectStart >= 0 {
		start = objectStart
	}
	if arrayStart := indexByteString(cleaned, '['); arrayStart >= 0 && (start < 0 || arrayStart < start) {
		start = arrayStart
	}
	if start < 0 {
		return "", false
	}
	stack := make([]byte, 0, 8)
	inString := false
	escaped := false
	for index := start; index < len(cleaned); index++ {
		char := cleaned[index]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) == 0 {
				return "", false
			}
			expected := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if expected != char {
				return "", false
			}
			if len(stack) == 0 {
				return jsTrim(cleaned[start : index+1]), true
			}
		}
	}
	return "", false
}

// stripMarkdownCodeFence mirrors the NestJS helper.
func stripMarkdownCodeFence(text string) string {
	trimmed := jsTrim(text)
	if len(trimmed) < 3 || trimmed[0:3] != "```" {
		return trimmed
	}
	firstNewline := indexByteString(trimmed, '\n')
	if firstNewline < 0 {
		return trimmed
	}
	afterFence := trimmed[firstNewline+1:]
	closingFence := lastIndexByteString(afterFence, "```")
	if closingFence < 0 {
		return trimmed
	}
	return jsTrim(afterFence[:closingFence])
}

// indexByteString returns the first byte index of needle, or -1.
func indexByteString(value string, needle byte) int {
	for index := 0; index < len(value); index++ {
		if value[index] == needle {
			return index
		}
	}
	return -1
}

// lastIndexByteString returns the last index of needle, or -1.
func lastIndexByteString(value, needle string) int {
	if len(needle) == 0 {
		return len(value)
	}
	for index := len(value) - len(needle); index >= 0; index-- {
		if value[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}
