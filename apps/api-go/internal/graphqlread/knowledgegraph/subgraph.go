package knowledgegraph

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

var relationTypes = []string{
	"belongs_to_industry",
	"supplies",
	"customer_of",
	"competes_with",
	"holds_position",
	"affects_industry",
	"affects_company",
	"upstream_of",
	"downstream_of",
	"has_ticker",
}

func validRelationType(value string) (string, bool) {
	normalized := strings.ToLower(trimSpace(value))
	for _, allowed := range relationTypes {
		if normalized == allowed {
			return allowed, true
		}
	}
	return "", false
}

type cacheNode struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Properties any    `json:"properties"`
}

type cacheEdge struct {
	ID         string  `json:"id"`
	From       string  `json:"from"`
	To         string  `json:"to"`
	Type       string  `json:"type"`
	Weight     float64 `json:"weight"`
	Confidence float64 `json:"confidence"`
	Properties any     `json:"properties"`
}

type cacheMetadata struct {
	TotalNodes  int    `json:"totalNodes"`
	TotalEdges  int    `json:"totalEdges"`
	GeneratedAt string `json:"generatedAt"`
}

type cacheSubgraph struct {
	Seed     cacheNode     `json:"seed"`
	Nodes    []cacheNode   `json:"nodes"`
	Edges    []cacheEdge   `json:"edges"`
	Metadata cacheMetadata `json:"metadata"`
}

// getKnowledgeGraphSubgraph is the getKnowledgeGraphSubgraph root resolver.
func (s *service) getKnowledgeGraphSubgraph(ctx contract.Context) (any, error) {
	if !s.healthy() {
		return nil, fmt.Errorf("knowledge graph database is not configured")
	}
	input, ok := contract.MapArg(ctx.Args, "input")
	if !ok {
		return nil, fmt.Errorf("input is required")
	}
	seedName, _ := input["seedName"].(string)
	maxDepth := clampDepth(input["maxDepth"])
	maxNodes := clampNodes(input["maxNodes"])

	var seedType *string
	if raw, exists := input["seedType"]; exists && raw != nil {
		if text, ok := raw.(string); ok {
			if value, valid := validEntityType(text); valid {
				seedType = &value
			}
		}
	}

	var relationFilter []string
	if raw, exists := input["relationTypes"]; exists && raw != nil {
		list, ok := raw.([]any)
		if ok {
			relationFilter = make([]string, 0, len(list))
			for _, entry := range list {
				text, ok := entry.(string)
				if !ok {
					continue
				}
				if value, valid := validRelationType(text); valid {
					relationFilter = append(relationFilter, value)
				}
			}
		}
	}

	current := s.getSettings(ctx.Ctx, ctx.Identity.OrgID)
	if !current.Enabled {
		return nil, nil
	}

	cacheKey := buildSubgraphCacheKey(ctx.Identity.OrgID, seedName, seedType, maxDepth, maxNodes, relationFilter)
	ttl := current.CacheTTLSeconds
	callCtx := s.call(ctx.Ctx)

	if ttl > 0 && s.redis != nil {
		if raw, err := s.redis.Get(callCtx, cacheKey).Bytes(); err == nil && len(raw) > 0 && string(raw) != "null" {
			var cached cacheSubgraph
			if json.Unmarshal(raw, &cached) == nil && cached.Seed.ID != "" {
				return cached.model(), nil
			}
		}
	}

	cached, err := s.loadSubgraph(callCtx, ctx.Identity.OrgID, seedName, seedType, maxDepth, maxNodes, relationFilter)
	if err != nil {
		return nil, err
	}
	if cached == nil {
		return nil, nil
	}
	if ttl > 0 && s.redis != nil {
		if encoded, marshalErr := json.Marshal(cached); marshalErr == nil {
			_ = s.redis.Set(callCtx, cacheKey, encoded, time.Duration(ttl)*time.Second).Err()
		}
	}
	return cached.model(), nil
}

func clampDepth(value any) int {
	number, ok := contract.AsInt(value)
	if !ok {
		return 2
	}
	if number < 1 {
		return 1
	}
	if number > 5 {
		return 5
	}
	return number
}

func clampNodes(value any) int {
	number, ok := contract.AsInt(value)
	if !ok {
		return 200
	}
	if number < 10 {
		return 10
	}
	if number > 500 {
		return 500
	}
	return number
}

func buildSubgraphCacheKey(orgID, seedName string, seedType *string, maxDepth, maxNodes int, relationFilter []string) string {
	typePart := "any"
	if seedType != nil {
		typePart = *seedType
	}
	relsPart := "any"
	if relationFilter != nil {
		sorted := append([]string{}, relationFilter...)
		sort.Strings(sorted)
		relsPart = strings.Join(sorted, ",")
	}
	return "knowledgeGraph:subgraph:" + orgID +
		":seed=" + strings.ToLower(trimSpace(seedName)) +
		":type=" + typePart +
		":depth=" + fmt.Sprint(maxDepth) +
		":max=" + fmt.Sprint(maxNodes) +
		":rels=" + relsPart
}

func (cached *cacheSubgraph) model() *KnowledgeGraphModel {
	generatedAt, err := time.Parse(time.RFC3339Nano, cached.Metadata.GeneratedAt)
	if err != nil {
		generatedAt = time.Time{}
	}
	nodes := make([]KnowledgeGraphNodeModel, len(cached.Nodes))
	for i, node := range cached.Nodes {
		nodes[i] = KnowledgeGraphNodeModel{ID: node.ID, Name: node.Name, Type: node.Type, Properties: node.Properties}
	}
	edges := make([]KnowledgeGraphEdgeModel, len(cached.Edges))
	for i, edge := range cached.Edges {
		edges[i] = KnowledgeGraphEdgeModel{
			ID: edge.ID, From: edge.From, To: edge.To, Type: edge.Type,
			Weight: edge.Weight, Confidence: edge.Confidence, Properties: edge.Properties,
		}
	}
	return &KnowledgeGraphModel{
		Seed:  KnowledgeGraphNodeModel{ID: cached.Seed.ID, Name: cached.Seed.Name, Type: cached.Seed.Type, Properties: cached.Seed.Properties},
		Nodes: nodes,
		Edges: edges,
		Metadata: KnowledgeGraphMetadataModel{
			TotalNodes:  cached.Metadata.TotalNodes,
			TotalEdges:  cached.Metadata.TotalEdges,
			GeneratedAt: generatedAt,
		},
	}
}

func (s *service) loadSubgraph(ctx context.Context, orgID, seedName string, seedType *string, maxDepth, maxNodes int, relationFilter []string) (*cacheSubgraph, error) {
	seed, found, err := s.resolveEntity(ctx, orgID, seedName, seedType)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}

	nodesByID := map[string]entityRow{seed.ID: seed}
	nodeOrder := []string{seed.ID}
	edgesByID := map[string]edgeRow{}
	edgeOrder := make([]string, 0)
	visited := map[string]bool{}

	frontier := []string{seed.ID}
	depth := 0
	for len(frontier) > 0 && depth < maxDepth && len(nodesByID) < maxNodes {
		frontierIDs := make([]string, 0, len(frontier))
		for _, id := range frontier {
			if !visited[id] {
				frontierIDs = append(frontierIDs, id)
			}
		}
		if len(frontierIDs) == 0 {
			break
		}
		for _, id := range frontierIDs {
			visited[id] = true
		}
		frontier = nil

		edges, err := s.loadFrontierEdges(ctx, orgID, frontierIDs, relationFilter, maxNodes)
		if err != nil {
			return nil, err
		}

		neighborIDs := make([]string, 0, len(edges)*2)
		neighborSeen := map[string]bool{}
		for _, edge := range edges {
			if _, exists := edgesByID[edge.ID]; !exists {
				edgesByID[edge.ID] = edge
				edgeOrder = append(edgeOrder, edge.ID)
			}
			for _, id := range []string{edge.From, edge.To} {
				if !neighborSeen[id] {
					neighborSeen[id] = true
					neighborIDs = append(neighborIDs, id)
				}
			}
		}

		missing := make([]string, 0, len(neighborIDs))
		for _, id := range neighborIDs {
			if _, exists := nodesByID[id]; !exists {
				missing = append(missing, id)
			}
		}
		if len(missing) > 0 {
			// The dirty-edge guard: a historical KnowledgeEdge may point at an
			// entity owned by another org. Without orgId here, that entity would
			// be loaded and cached into this org's subgraph.
			loaded, err := s.loadEntities(ctx, "`orgId` = ? AND `id` IN ("+placeholders(len(missing))+")", append([]any{orgID}, stringArgs(missing)...)...)
			if err != nil {
				return nil, err
			}
			for _, entity := range loaded {
				if _, exists := nodesByID[entity.ID]; exists {
					continue
				}
				nodesByID[entity.ID] = entity
				nodeOrder = append(nodeOrder, entity.ID)
			}
		}

		for _, edge := range edges {
			if len(nodesByID) >= maxNodes {
				break
			}
			if !visited[edge.From] {
				if _, exists := nodesByID[edge.From]; exists {
					frontier = appendUnique(frontier, edge.From)
				}
			}
			if !visited[edge.To] {
				if _, exists := nodesByID[edge.To]; exists {
					frontier = appendUnique(frontier, edge.To)
				}
			}
		}
		depth++
	}

	if len(nodeOrder) > maxNodes {
		nodeOrder = nodeOrder[:maxNodes]
	}
	nodeIDs := make(map[string]bool, len(nodeOrder))
	nodes := make([]cacheNode, 0, len(nodeOrder))
	for _, id := range nodeOrder {
		entity := nodesByID[id]
		nodeIDs[id] = true
		nodes = append(nodes, cacheNode{
			ID: entity.ID, Name: entity.CanonicalName, Type: entity.Type,
			Properties: decodeJSON(entity.Properties),
		})
	}
	edges := make([]cacheEdge, 0, len(edgeOrder))
	for _, id := range edgeOrder {
		edge := edgesByID[id]
		if !nodeIDs[edge.From] || !nodeIDs[edge.To] {
			continue
		}
		edges = append(edges, cacheEdge{
			ID: edge.ID, From: edge.From, To: edge.To, Type: edge.Type,
			Weight: edge.Weight, Confidence: edge.Confidence, Properties: decodeJSON(edge.Properties),
		})
	}

	return &cacheSubgraph{
		Seed: cacheNode{
			ID: seed.ID, Name: seed.CanonicalName, Type: seed.Type,
			Properties: decodeJSON(seed.Properties),
		},
		Nodes: nodes,
		Edges: edges,
		Metadata: cacheMetadata{
			TotalNodes:  len(nodes),
			TotalEdges:  len(edges),
			GeneratedAt: s.clock().UTC().Format("2006-01-02T15:04:05.000Z"),
		},
	}, nil
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func (s *service) loadFrontierEdges(ctx context.Context, orgID string, frontierIDs []string, relationFilter []string, maxNodes int) ([]edgeRow, error) {
	where := "`orgId` = ?"
	args := []any{orgID}
	if len(relationFilter) > 0 {
		where += " AND `type` IN (" + placeholders(len(relationFilter)) + ")"
		args = append(args, stringArgs(relationFilter)...)
	}
	where += " AND (`fromEntityId` IN (" + placeholders(len(frontierIDs)) + ") OR `toEntityId` IN (" + placeholders(len(frontierIDs)) + "))"
	args = append(args, stringArgs(frontierIDs)...)
	args = append(args, stringArgs(frontierIDs)...)
	take := maxNodes * 5
	if take < 50 {
		take = 50
	}
	args = append(args, take)
	query := "SELECT `id`, `fromEntityId`, `toEntityId`, `type`, `weight`, `confidence`, `properties` " +
		"FROM `KnowledgeEdge` WHERE " + where + " ORDER BY `weight` DESC, `updatedAt` DESC LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query knowledge graph edges: %w", err)
	}
	defer rows.Close()
	out := make([]edgeRow, 0)
	for rows.Next() {
		var row edgeRow
		var properties []byte
		if err := rows.Scan(&row.ID, &row.From, &row.To, &row.Type, &row.Weight, &row.Confidence, &properties); err != nil {
			return nil, fmt.Errorf("scan knowledge graph edge: %w", err)
		}
		row.Properties = properties
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *service) loadEntities(ctx context.Context, where string, args ...any) ([]entityRow, error) {
	query := "SELECT `id`, `type`, `canonicalName`, `properties` FROM `KnowledgeEntity` WHERE " + where
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query knowledge entities: %w", err)
	}
	defer rows.Close()
	out := make([]entityRow, 0)
	for rows.Next() {
		var row entityRow
		var properties []byte
		if err := rows.Scan(&row.ID, &row.Type, &row.CanonicalName, &properties); err != nil {
			return nil, fmt.Errorf("scan knowledge entity: %w", err)
		}
		row.Properties = properties
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

type candidate struct {
	entity      entityRow
	aliasSource string
}

// resolveEntity mirrors KnowledgeGraphService.resolveEntityByName.
func (s *service) resolveEntity(ctx context.Context, orgID, name string, entityType *string) (entityRow, bool, error) {
	candidates, err := s.listEntityCandidates(ctx, orgID, name, entityType)
	if err != nil {
		return entityRow{}, false, err
	}
	if len(candidates) == 0 {
		return entityRow{}, false, nil
	}
	return candidates[0], true, nil
}

func (s *service) listEntityCandidates(ctx context.Context, orgID, name string, entityType *string) ([]entityRow, error) {
	keys := normalizeSearchKeys(name)
	if len(keys) == 0 {
		return nil, nil
	}
	query := "SELECT a.`source`, e.`id`, e.`type`, e.`canonicalName`, e.`properties` " +
		"FROM `KnowledgeEntityAlias` a INNER JOIN `KnowledgeEntity` e ON e.`id` = a.`entityId` " +
		"WHERE a.`orgId` = ? AND a.`normalizedAlias` IN (" + placeholders(len(keys)) + ") LIMIT 20"
	rows, err := s.db.QueryContext(ctx, query, append([]any{orgID}, stringArgs(keys)...)...)
	if err != nil {
		return nil, fmt.Errorf("query knowledge entity aliases: %w", err)
	}
	defer rows.Close()
	candidates := make([]candidate, 0, 20)
	for rows.Next() {
		var item candidate
		var properties []byte
		if err := rows.Scan(&item.aliasSource, &item.entity.ID, &item.entity.Type, &item.entity.CanonicalName, &properties); err != nil {
			return nil, fmt.Errorf("scan knowledge entity alias: %w", err)
		}
		item.entity.Properties = properties
		if entityType != nil && item.entity.Type != *entityType {
			continue
		}
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}

	tickerQuery := looksLikeTicker(name)
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if tickerQuery {
			leftInstrument := left.entity.Type == "instrument"
			rightInstrument := right.entity.Type == "instrument"
			if leftInstrument != rightInstrument {
				return leftInstrument
			}
		}
		leftSource := sourceRank(left.aliasSource)
		rightSource := sourceRank(right.aliasSource)
		if leftSource != rightSource {
			return leftSource < rightSource
		}
		return typeRank(left.entity.Type) < typeRank(right.entity.Type)
	})
	out := make([]entityRow, len(candidates))
	for i, item := range candidates {
		out[i] = item.entity
	}
	return out, nil
}

func sourceRank(source string) int {
	for index, value := range sourcePreference {
		if source == value {
			return index
		}
	}
	return len(sourcePreference)
}

func typeRank(entityType string) int {
	for index, value := range entityTypePreference {
		if entityType == value {
			return index
		}
	}
	return len(entityTypePreference)
}
