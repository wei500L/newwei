package kgimpact

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

type explainChain struct {
	reason string
	nodes  []entityRow
	edges  []edgeRow
}

type impactCandidate struct {
	entity entityRow
	score  float64
	kind   string
	chains []explainChain
}

type candidateSet struct {
	order []*impactCandidate
	index map[string]int
}

func newCandidateSet() *candidateSet {
	return &candidateSet{index: map[string]int{}}
}

// upsert mirrors KnowledgeGraphImpactService.upsertCandidate.
func (c *candidateSet) upsert(entity entityRow, score float64, kind string, chain explainChain) {
	if idx, ok := c.index[entity.id]; ok {
		existing := c.order[idx]
		if score > existing.score {
			existing.score = score
		}
		if existing.kind != kind {
			existing.kind = existing.kind + "," + kind
		}
		existing.chains = append(existing.chains, chain)
		return
	}
	c.index[entity.id] = len(c.order)
	c.order = append(c.order, &impactCandidate{
		entity: entity,
		score:  score,
		kind:   kind,
		chains: []explainChain{chain},
	})
}

func (c *candidateSet) size() int {
	return len(c.order)
}

// sortedCandidates mirrors sortCandidates: score desc, then canonicalName.
func (c *candidateSet) sortedCandidates() []*impactCandidate {
	out := append([]*impactCandidate(nil), c.order...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return localeCompare(out[i].entity.canonicalName, out[j].entity.canonicalName) < 0
	})
	return out
}

type impactResult struct {
	scenario   string
	seed       entityRow
	candidates []*impactCandidate
	metadata   map[string]any
}

func (s *store) analyzeExecutiveChange(ctx context.Context, orgID, companyName string, maxCandidates int) (*impactResult, error) {
	maxCandidates = clampInt(maxCandidates, 1, 200)
	seed, err := s.resolveCompanySeed(ctx, orgID, companyName)
	if err != nil {
		return nil, err
	}
	if seed == nil {
		return nil, nil
	}

	candidates := newCandidateSet()

	tickerEdges, tickerNodes, err := s.findRelatedEntities(ctx, orgID, seed.id, []string{"has_ticker"}, 50)
	if err != nil {
		return nil, err
	}
	for _, edge := range tickerEdges {
		instrumentID := edge.fromEntityID
		if edge.fromEntityID == seed.id {
			instrumentID = edge.toEntityID
		}
		instrument, ok := tickerNodes[instrumentID]
		if !ok || instrument.entityType != "instrument" {
			continue
		}
		candidates.upsert(instrument, 100+edge.weight*2+edge.confidence*10, "ticker", explainChain{
			reason: "company_has_ticker",
			nodes:  []entityRow{*seed, instrument},
			edges:  []edgeRow{edge},
		})
	}

	industryEdges, industryNodes, err := s.findRelatedEntities(ctx, orgID, seed.id, []string{"belongs_to_industry"}, 50)
	if err != nil {
		return nil, err
	}
	industryIDs := make([]string, 0, len(industryNodes))
	industryIDSet := map[string]struct{}{}
	for _, node := range industryNodes {
		if node.entityType != "industry" {
			continue
		}
		if _, exists := industryIDSet[node.id]; exists {
			continue
		}
		industryIDSet[node.id] = struct{}{}
		industryIDs = append(industryIDs, node.id)
	}

	competitorEdges, competitorNodes, err := s.findRelatedEntities(ctx, orgID, seed.id, []string{"competes_with"}, 50)
	if err != nil {
		return nil, err
	}
	for _, edge := range competitorEdges {
		competitorID := edge.fromEntityID
		if edge.fromEntityID == seed.id {
			competitorID = edge.toEntityID
		}
		competitor, ok := competitorNodes[competitorID]
		if !ok || competitor.entityType != "company" || competitor.id == seed.id {
			continue
		}
		candidates.upsert(competitor, 80+edge.weight*2+edge.confidence*10, "competitor", explainChain{
			reason: "competes_with",
			nodes:  []entityRow{*seed, competitor},
			edges:  []edgeRow{edge},
		})
	}

	if len(industryIDs) > 0 {
		take := maxInt(200, maxCandidates*10)
		membership, err := s.loadIndustryMembership(ctx, orgID, industryIDs, take)
		if err != nil {
			return nil, err
		}
		normalized := normalizeIndustryMemberships(membership, industryIDSet)
		seedIndustryEdges := indexSeedIndustryEdges(seed.id, industryEdges)

		companyIDs := map[string]struct{}{}
		for _, info := range normalized {
			if info.companyID != seed.id {
				companyIDs[info.companyID] = struct{}{}
			}
		}
		idList := make([]string, 0, len(companyIDs))
		for id := range companyIDs {
			idList = append(idList, id)
		}
		companies, err := s.loadEntitiesByIDs(ctx, orgID, idList)
		if err != nil {
			return nil, err
		}

		for _, info := range normalized {
			company, ok := companies[info.companyID]
			if !ok || company.entityType != "company" || company.id == seed.id {
				continue
			}
			industry, ok := industryNodes[info.industryID]
			if !ok || industry.entityType != "industry" {
				continue
			}
			seedIndustryEdge, ok := seedIndustryEdges[industry.id]
			if !ok {
				continue
			}
			candidates.upsert(company, 60+info.edge.weight+info.edge.confidence*5, "peer", explainChain{
				reason: "same_industry",
				nodes:  []entityRow{*seed, industry, company},
				edges:  []edgeRow{seedIndustryEdge, info.edge},
			})
		}
	}

	sorted := sliceCandidates(candidates.sortedCandidates(), maxCandidates)
	return &impactResult{
		scenario:   "executive_change",
		seed:       *seed,
		candidates: sorted,
		metadata:   map[string]any{"totalCandidates": len(sorted)},
	}, nil
}

func (s *store) analyzeCommodityMove(ctx context.Context, orgID, commodityName string, maxCandidates int) (*impactResult, error) {
	maxCandidates = clampInt(maxCandidates, 1, 200)
	seed, err := s.resolveEntity(ctx, orgID, commodityName, "commodity")
	if err != nil {
		return nil, err
	}
	if seed == nil {
		return nil, nil
	}

	candidates := newCandidateSet()

	impactEdges, impactNodes, err := s.findRelatedEntities(ctx, orgID, seed.id, []string{
		"affects_industry", "affects_company", "downstream_of", "upstream_of",
	}, 200)
	if err != nil {
		return nil, err
	}

	industryIDs, industryIDSet := collectIndustryIDs(impactEdges, impactNodes, seed.id)
	for _, edge := range impactEdges {
		otherID := otherEntityID(edge, seed.id)
		other, ok := impactNodes[otherID]
		if !ok {
			continue
		}
		if other.entityType == "industry" {
			candidates.upsert(other, 80+edge.confidence*20+edge.weight, "industry", explainChain{
				reason: edge.edgeType,
				nodes:  []entityRow{*seed, other},
				edges:  []edgeRow{edge},
			})
		} else if other.entityType == "company" && edge.edgeType == "affects_company" {
			candidates.upsert(other, 70+edge.confidence*20+edge.weight, "company", explainChain{
				reason: edge.edgeType,
				nodes:  []entityRow{*seed, other},
				edges:  []edgeRow{edge},
			})
		}
	}

	if len(industryIDs) > 0 {
		membership, err := s.loadIndustryMembership(ctx, orgID, industryIDs, maxInt(500, maxCandidates*10))
		if err != nil {
			return nil, err
		}
		normalized := normalizeIndustryMemberships(membership, industryIDSet)
		seedIndustryEdges := indexSeedIndustryEdges(seed.id, impactEdges)

		companyIDs := map[string]struct{}{}
		for _, info := range normalized {
			companyIDs[info.companyID] = struct{}{}
		}
		idList := make([]string, 0, len(companyIDs))
		for id := range companyIDs {
			idList = append(idList, id)
		}
		companies, err := s.loadEntitiesByIDs(ctx, orgID, idList)
		if err != nil {
			return nil, err
		}

		for _, info := range normalized {
			company, ok := companies[info.companyID]
			if !ok || company.entityType != "company" {
				continue
			}
			industry, ok := impactNodes[info.industryID]
			if !ok || industry.entityType != "industry" {
				continue
			}
			seedIndustryEdge, ok := seedIndustryEdges[industry.id]
			if !ok {
				continue
			}
			candidates.upsert(company, 50+seedIndustryEdge.confidence*10+info.edge.confidence*5, "company", explainChain{
				reason: "commodity_to_industry_to_company",
				nodes:  []entityRow{*seed, industry, company},
				edges:  []edgeRow{seedIndustryEdge, info.edge},
			})
		}
	}

	sorted := sliceCandidates(candidates.sortedCandidates(), maxCandidates)
	return &impactResult{
		scenario:   "commodity_move",
		seed:       *seed,
		candidates: sorted,
		metadata: map[string]any{
			"totalCandidates":    len(sorted),
			"impactedIndustries": len(industryIDs),
		},
	}, nil
}

func (s *store) analyzePolicyEvent(ctx context.Context, orgID, policyName string, maxCandidates int, includeLprSnapshot bool) (*impactResult, error) {
	maxCandidates = clampInt(maxCandidates, 1, 200)
	seed, err := s.resolveEntity(ctx, orgID, policyName, "policy")
	if err != nil {
		return nil, err
	}
	if seed == nil {
		return nil, nil
	}

	candidates := newCandidateSet()

	impactEdges, impactNodes, err := s.findRelatedEntities(ctx, orgID, seed.id, []string{"affects_industry", "affects_company"}, 200)
	if err != nil {
		return nil, err
	}

	industryIDs, industryIDSet := collectIndustryIDs(impactEdges, impactNodes, seed.id)
	for _, edge := range impactEdges {
		otherID := otherEntityID(edge, seed.id)
		other, ok := impactNodes[otherID]
		if !ok {
			continue
		}
		if other.entityType == "industry" {
			candidates.upsert(other, 80+edge.confidence*20+edge.weight, "industry", explainChain{
				reason: edge.edgeType,
				nodes:  []entityRow{*seed, other},
				edges:  []edgeRow{edge},
			})
		} else if other.entityType == "company" && edge.edgeType == "affects_company" {
			candidates.upsert(other, 70+edge.confidence*20+edge.weight, "company", explainChain{
				reason: edge.edgeType,
				nodes:  []entityRow{*seed, other},
				edges:  []edgeRow{edge},
			})
		}
	}

	if len(industryIDs) > 0 {
		membership, err := s.loadIndustryMembership(ctx, orgID, industryIDs, maxInt(500, maxCandidates*10))
		if err != nil {
			return nil, err
		}
		normalized := normalizeIndustryMemberships(membership, industryIDSet)
		seedIndustryEdges := indexSeedIndustryEdges(seed.id, impactEdges)

		companyIDs := map[string]struct{}{}
		for _, info := range normalized {
			companyIDs[info.companyID] = struct{}{}
		}
		idList := make([]string, 0, len(companyIDs))
		for id := range companyIDs {
			idList = append(idList, id)
		}
		companies, err := s.loadEntitiesByIDs(ctx, orgID, idList)
		if err != nil {
			return nil, err
		}

		for _, info := range normalized {
			company, ok := companies[info.companyID]
			if !ok || company.entityType != "company" {
				continue
			}
			industry, ok := impactNodes[info.industryID]
			if !ok || industry.entityType != "industry" {
				continue
			}
			seedIndustryEdge, ok := seedIndustryEdges[industry.id]
			if !ok {
				continue
			}
			candidates.upsert(company, 50+seedIndustryEdge.confidence*10+info.edge.confidence*5, "company", explainChain{
				reason: "policy_to_industry_to_company",
				nodes:  []entityRow{*seed, industry, company},
				edges:  []edgeRow{seedIndustryEdge, info.edge},
			})
		}
	}

	// Policy metadata keeps the pre-truncation candidate count, unlike the
	// other two scenarios. includeLprSnapshot never issues a real AkShare
	// request: an unreachable gateway is only logged and ignored.
	metadata := map[string]any{
		"totalCandidates":    candidates.size(),
		"impactedIndustries": len(industryIDs),
	}
	if includeLprSnapshot {
		log.Printf("kgimpact: includeLprSnapshot ignored (akshare snapshot not fetched by the read path)")
	}

	sorted := sliceCandidates(candidates.sortedCandidates(), maxCandidates)
	return &impactResult{
		scenario:   "policy_event",
		seed:       *seed,
		candidates: sorted,
		metadata:   metadata,
	}, nil
}

type industryMembership struct {
	edge       edgeRow
	industryID string
	companyID  string
}

func normalizeIndustryMemberships(membership []edgeRow, industryIDSet map[string]struct{}) []industryMembership {
	out := make([]industryMembership, 0, len(membership))
	for _, edge := range membership {
		_, fromIsIndustry := industryIDSet[edge.fromEntityID]
		_, toIsIndustry := industryIDSet[edge.toEntityID]
		if fromIsIndustry == toIsIndustry {
			continue
		}
		info := industryMembership{edge: edge}
		if fromIsIndustry {
			info.industryID = edge.fromEntityID
			info.companyID = edge.toEntityID
		} else {
			info.industryID = edge.toEntityID
			info.companyID = edge.fromEntityID
		}
		out = append(out, info)
	}
	return out
}

func indexSeedIndustryEdges(seedID string, edges []edgeRow) map[string]edgeRow {
	index := map[string]edgeRow{}
	for _, edge := range edges {
		var industryID string
		if edge.fromEntityID == seedID {
			industryID = edge.toEntityID
		} else if edge.toEntityID == seedID {
			industryID = edge.fromEntityID
		}
		if industryID == "" {
			continue
		}
		if _, exists := index[industryID]; exists {
			continue
		}
		index[industryID] = edge
	}
	return index
}

func collectIndustryIDs(edges []edgeRow, nodes map[string]entityRow, seedID string) ([]string, map[string]struct{}) {
	ids := make([]string, 0)
	set := map[string]struct{}{}
	for _, edge := range edges {
		other, ok := nodes[otherEntityID(edge, seedID)]
		if !ok || other.entityType != "industry" {
			continue
		}
		if _, exists := set[other.id]; exists {
			continue
		}
		set[other.id] = struct{}{}
		ids = append(ids, other.id)
	}
	return ids, set
}

func otherEntityID(edge edgeRow, seedID string) string {
	if edge.fromEntityID == seedID {
		return edge.toEntityID
	}
	return edge.fromEntityID
}

func sliceCandidates(values []*impactCandidate, maxCandidates int) []*impactCandidate {
	if len(values) > maxCandidates {
		return values[:maxCandidates]
	}
	return values
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// impactModel converts the internal result into the GraphQL shape.
func impactModel(result *impactResult, generatedAt time.Time) knowledgeGraphImpactAnalysisModel {
	candidates := make([]knowledgeGraphImpactCandidateModel, 0, len(result.candidates))
	for _, candidate := range result.candidates {
		chains := make([]knowledgeGraphExplainChainModel, 0, len(candidate.chains))
		for _, chain := range candidate.chains {
			nodes := make([]knowledgeGraphNodeModel, 0, len(chain.nodes))
			for _, node := range chain.nodes {
				nodes = append(nodes, nodeModel(node))
			}
			edges := make([]knowledgeGraphEdgeModel, 0, len(chain.edges))
			for _, edge := range chain.edges {
				edges = append(edges, edgeModel(edge))
			}
			chains = append(chains, knowledgeGraphExplainChainModel{Reason: chain.reason, Nodes: nodes, Edges: edges})
		}
		candidates = append(candidates, knowledgeGraphImpactCandidateModel{
			Entity: nodeModel(candidate.entity),
			Score:  candidate.score,
			Kind:   candidate.kind,
			Chains: chains,
		})
	}
	return knowledgeGraphImpactAnalysisModel{
		Scenario:    result.scenario,
		Seed:        nodeModel(result.seed),
		Candidates:  candidates,
		Metadata:    result.metadata,
		GeneratedAt: generatedAt,
	}
}

func encodeImpact(model knowledgeGraphImpactAnalysisModel) json.RawMessage {
	entry := impactCacheEntry{
		Scenario:    model.Scenario,
		Seed:        model.Seed,
		Candidates:  model.Candidates,
		Metadata:    model.Metadata,
		GeneratedAt: formatISO(model.GeneratedAt),
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return nil
	}
	return json.RawMessage(raw)
}

// decodeImpact returns the cached model and whether the cached value was a
// real object. A "null" cache entry (a seed that resolved to nothing) yields
// (zero, false).
func decodeImpact(raw []byte) (knowledgeGraphImpactAnalysisModel, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return knowledgeGraphImpactAnalysisModel{}, false
	}
	var entry impactCacheEntry
	if err := json.Unmarshal([]byte(trimmed), &entry); err != nil {
		return knowledgeGraphImpactAnalysisModel{}, false
	}
	return knowledgeGraphImpactAnalysisModel{
		Scenario:    entry.Scenario,
		Seed:        entry.Seed,
		Candidates:  entry.Candidates,
		Metadata:    entry.Metadata,
		GeneratedAt: parseISO(entry.GeneratedAt),
	}, true
}

func formatISO(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func parseISO(value string) time.Time {
	if parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	return time.Time{}
}

func callContext(call contract.Context) context.Context {
	if call.Ctx != nil {
		return call.Ctx
	}
	return context.Background()
}

func buildImpactCacheKey(orgID string, params map[string]string) string {
	parts := make([]string, 0, len(params))
	for key, value := range params {
		parts = append(parts, key+"="+value)
	}
	sort.Strings(parts)
	return kgImpactCachePrefix + orgID + ":" + strings.Join(parts, ":")
}

const kgImpactCachePrefix = "knowledgeGraph:impact:"

// cachedImpact mirrors KnowledgeGraphImpactResolver.runCached: settings gate
// first, then Redis when cacheTtlSeconds > 0.
func (s *store) cachedImpact(call contract.Context, params map[string]string, ttlSeconds int, loader func() (knowledgeGraphImpactAnalysisModel, bool, error)) (any, error) {
	ctx := callContext(call)
	key := buildImpactCacheKey(call.Identity.OrgID, params)
	if ttlSeconds > 0 {
		if raw, ok, err := redisGetBytes(ctx, s.redis, key); err == nil && ok {
			model, found := decodeImpact(raw)
			if !found {
				return nil, nil
			}
			return model, nil
		}
	}
	model, found, err := loader()
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	if ttlSeconds > 0 {
		if raw := encodeImpact(model); raw != nil {
			if err := redisSetJSON(ctx, s.redis, key, raw, time.Duration(ttlSeconds)*time.Second); err != nil {
				log.Printf("kgimpact: impact cache write failed for org %s: %v", call.Identity.OrgID, err)
			}
		}
	}
	return model, nil
}

func (s *store) getExecutiveChangeImpact(call contract.Context) (any, error) {
	orgID := call.Identity.OrgID
	input, _ := contract.MapArg(call.Args, "input")
	companyName, _ := contract.StringArg(input, "companyName")
	maxCandidates := 50
	if value, ok := contract.IntArg(input, "maxCandidates"); ok {
		maxCandidates = value
	}
	settings := s.loadKnowledgeGraphSettings(callContext(call), orgID)
	if !settings.Enabled {
		return nil, nil
	}
	ctx := callContext(call)
	return s.cachedImpact(call, map[string]string{
		"scenario":      "executive_change",
		"seedName":      strings.ToLower(strings.TrimSpace(companyName)),
		"maxCandidates": itoa(maxCandidates),
	}, settings.CacheTTLSeconds, func() (knowledgeGraphImpactAnalysisModel, bool, error) {
		result, err := s.analyzeExecutiveChange(ctx, orgID, companyName, maxCandidates)
		if err != nil || result == nil {
			return knowledgeGraphImpactAnalysisModel{}, false, err
		}
		return impactModel(result, s.clock()), true, nil
	})
}

func (s *store) getCommodityMoveImpact(call contract.Context) (any, error) {
	orgID := call.Identity.OrgID
	input, _ := contract.MapArg(call.Args, "input")
	commodityName, _ := contract.StringArg(input, "commodityName")
	maxCandidates := 50
	if value, ok := contract.IntArg(input, "maxCandidates"); ok {
		maxCandidates = value
	}
	settings := s.loadKnowledgeGraphSettings(callContext(call), orgID)
	if !settings.Enabled {
		return nil, nil
	}
	ctx := callContext(call)
	return s.cachedImpact(call, map[string]string{
		"scenario":      "commodity_move",
		"seedName":      strings.ToLower(strings.TrimSpace(commodityName)),
		"maxCandidates": itoa(maxCandidates),
	}, settings.CacheTTLSeconds, func() (knowledgeGraphImpactAnalysisModel, bool, error) {
		result, err := s.analyzeCommodityMove(ctx, orgID, commodityName, maxCandidates)
		if err != nil || result == nil {
			return knowledgeGraphImpactAnalysisModel{}, false, err
		}
		return impactModel(result, s.clock()), true, nil
	})
}

func (s *store) getPolicyEventImpact(call contract.Context) (any, error) {
	orgID := call.Identity.OrgID
	input, _ := contract.MapArg(call.Args, "input")
	policyName, _ := contract.StringArg(input, "policyName")
	maxCandidates := 50
	if value, ok := contract.IntArg(input, "maxCandidates"); ok {
		maxCandidates = value
	}
	includeLprSnapshot := false
	if value, state := contract.Lookup(input, "includeLprSnapshot"); state == contract.ArgValue {
		if flag, ok := value.(bool); ok {
			includeLprSnapshot = flag
		}
	}
	settings := s.loadKnowledgeGraphSettings(callContext(call), orgID)
	if !settings.Enabled {
		return nil, nil
	}
	ctx := callContext(call)
	return s.cachedImpact(call, map[string]string{
		"scenario":           "policy_event",
		"seedName":           strings.ToLower(strings.TrimSpace(policyName)),
		"maxCandidates":      itoa(maxCandidates),
		"includeLprSnapshot": boolString(includeLprSnapshot),
	}, settings.CacheTTLSeconds, func() (knowledgeGraphImpactAnalysisModel, bool, error) {
		result, err := s.analyzePolicyEvent(ctx, orgID, policyName, maxCandidates, includeLprSnapshot)
		if err != nil || result == nil {
			return knowledgeGraphImpactAnalysisModel{}, false, err
		}
		return impactModel(result, s.clock()), true, nil
	})
}

func boolString(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
