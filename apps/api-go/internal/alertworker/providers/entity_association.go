package providers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AlertEventStatus values, matching the Prisma enum.
const (
	alertEventStatusPending   = "pending"
	alertEventStatusDelivered = "delivered"
	alertEventStatusConfirmed = "confirmed"
)

// KnowledgeGraphService preference tables, in declaration order.
var associationEntityTypePreference = []string{
	"company",
	"commodity",
	"policy",
	"industry",
	"person",
	"instrument",
	"organization",
}

var associationAliasSourcePreference = []string{
	"user",
	"seed",
	"derived",
	"llm",
}

// Ticker shapes accepted by KnowledgeGraphService.parseTicker.
var (
	associationWhitespacePattern   = regexp.MustCompile(`\s+`)
	associationBracketsPattern     = regexp.MustCompile(`\s*[(（][^)）]+[)）]\s*`)
	associationTickerDotPattern    = regexp.MustCompile(`^(\d{6})\.(SH|SZ|BJ)$`)
	associationTickerPrefixPattern = regexp.MustCompile(`^(SH|SZ|BJ)(\d{6})$`)
	associationTickerCodePattern   = regexp.MustCompile(`^(\d{6})$`)
)

// associationCompanySuffixes is buildCompanyAliasCandidates' suffix table. The
// order matches the NestJS array; the suffix check is independent per entry.
var associationCompanySuffixes = []string{
	"股份有限公司",
	"有限责任公司",
	"有限公司",
	"集团股份有限公司",
	"集团有限公司",
	"集团",
	"CO., LTD",
	"CO.,LTD",
	"CO. LTD",
	"CO LTD",
	"COMPANY LIMITED",
	"LIMITED",
	"LTD",
	"INC",
	"CORPORATION",
	"CORP",
}

// associationEntity is one KnowledgeEntity row.
type associationEntity struct {
	ID            string
	Type          string
	CanonicalName string
}

// associationCandidate is one knowledgeEntityAlias row joined with its entity.
type associationCandidate struct {
	Entity associationEntity
	Source string
}

// associationEdge is one KnowledgeEdge row.
type associationEdge struct {
	ID           string
	Type         string
	FromEntityID string
	ToEntityID   string
	Weight       float64
	Confidence   float64
}

// associationTarget is one entry of the context targets array.
type associationTarget struct {
	EntityID     string  `json:"entityId"`
	Name         string  `json:"name"`
	Type         string  `json:"type"`
	Confidence   float64 `json:"confidence"`
	Weight       float64 `json:"weight"`
	Score        float64 `json:"score"`
	RelationType string  `json:"relationType"`
}

// associationSeedContext is the seed object of the context.
type associationSeedContext struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// associationSourceEventContext is the sourceEvent object of the context.
type associationSourceEventContext struct {
	ID          string  `json:"id"`
	RuleID      string  `json:"ruleId"`
	TriggeredAt string  `json:"triggeredAt"`
	MetricValue float64 `json:"metricValue"`
	Status      string  `json:"status"`
}

// associationContext is the successful evaluation context.
type associationContext struct {
	Seed                 associationSeedContext        `json:"seed"`
	SourceEvent          associationSourceEventContext `json:"sourceEvent"`
	WindowMinutes        int                           `json:"windowMinutes"`
	MinAssociationWeight float64                       `json:"minAssociationWeight"`
	MaxTargets           int                           `json:"maxTargets"`
	Targets              []associationTarget           `json:"targets"`
}

// associationSeedMissingContext is {error: "seed_missing"}.
type associationSeedMissingContext struct {
	Error string `json:"error"`
}

// associationSourceNoneContext is {source: "none"}.
type associationSourceNoneContext struct {
	Source string `json:"source"`
}

// associationSeedNotFoundContext is {error: "seed_not_found", seedName}.
type associationSeedNotFoundContext struct {
	Error    string `json:"error"`
	SeedName string `json:"seedName"`
}

// associationProvider is EntityAssociationMetricProvider.
type associationProvider struct {
	deps Dependencies
}

// NewEntityAssociation returns the entity_association metric provider.
func NewEntityAssociation(deps Dependencies) Provider {
	return &associationProvider{deps: deps}
}

// Type is AlertMetricProvider.entity_association.
func (p *associationProvider) Type() string {
	return TypeEntityAssociation
}

// Fetch mirrors EntityAssociationMetricProvider.fetch: use the newest
// entity_sentiment alert event as the source, resolve its slug to a knowledge
// entity and turn the strongest neighbors into the impact score.
func (p *associationProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := strings.TrimSpace(rule.MetricSlug)
	if metricSlug == "" {
		return associationEvaluation(associationSeedMissingContext{Error: "seed_missing"})
	}
	metadata := readRuleMetadata(rule.Metadata)
	windowMinutes := clampEntityInt(metadata.numberOr("sourceWindowMinutes", 180), 5, 7*24*60)
	minAssociationWeight := clampEntityFloat(metadata.numberOr("minAssociationWeight", 0.3), 0, 1)
	maxTargets := clampEntityInt(metadata.numberOr("maxTargets", 10), 1, 50)

	sourceSince := p.deps.now().UTC().Add(-time.Duration(windowMinutes) * time.Minute)
	sourceEvent, found, err := p.findSourceEvent(ctx, rule.OrgID, metricSlug, sourceSince)
	if err != nil {
		return Evaluation{}, err
	}
	if !found {
		return associationEvaluation(associationSourceNoneContext{Source: "none"})
	}

	seed, err := p.resolveEntity(ctx, rule.OrgID, metricSlug)
	if err != nil {
		return Evaluation{}, err
	}
	if seed == nil {
		return associationEvaluation(associationSeedNotFoundContext{
			Error:    "seed_not_found",
			SeedName: metricSlug,
		})
	}

	edges, err := p.findEdges(ctx, rule.OrgID, seed.ID, maxAssociationEdgeLimit(maxTargets))
	if err != nil {
		return Evaluation{}, err
	}
	neighbors, err := p.findNeighbors(ctx, seed.ID, edges)
	if err != nil {
		return Evaluation{}, err
	}

	targets := associationTargets(seed.ID, edges, neighbors, minAssociationWeight, maxTargets)
	impactScore := associationImpactScore(sourceEvent.MetricValue, targets)

	raw, err := marshalProviderContext(associationContext{
		Seed: associationSeedContext{
			ID:   seed.ID,
			Name: seed.CanonicalName,
			Type: seed.Type,
		},
		SourceEvent: associationSourceEventContext{
			ID:          sourceEvent.ID,
			RuleID:      sourceEvent.RuleID,
			TriggeredAt: jsISOTimestamp(sourceEvent.TriggeredAt),
			MetricValue: sourceEvent.MetricValue,
			Status:      sourceEvent.Status,
		},
		WindowMinutes:        windowMinutes,
		MinAssociationWeight: minAssociationWeight,
		MaxTargets:           maxTargets,
		Targets:              targets,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: evaluationNumber(impactScore), Context: raw}, nil
}

// associationEvaluation returns a value-less evaluation that only carries
// context.
func associationEvaluation(payload any) (Evaluation, error) {
	raw, err := marshalProviderContext(payload)
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Context: raw}, nil
}

// associationSourceEvent is the AlertEvent row the provider reads.
type associationSourceEvent struct {
	ID          string
	RuleID      string
	TriggeredAt time.Time
	MetricValue float64
	Status      string
}

// maxAssociationEdgeLimit is take: Math.max(50, maxTargets * 10).
func maxAssociationEdgeLimit(maxTargets int) int {
	limit := maxTargets * 10
	if limit < 50 {
		return 50
	}
	return limit
}

// findSourceEvent selects the newest entity_sentiment event of the rule slug.
// The Prisma `rule` relation condition becomes a join on AlertRule; `orderBy
// triggeredAt desc` plus findFirst becomes ORDER BY ... LIMIT 1.
func (p *associationProvider) findSourceEvent(ctx context.Context, orgID, metricSlug string, since time.Time) (associationSourceEvent, bool, error) {
	if p.deps.DB == nil {
		return associationSourceEvent{}, false, errors.New("alertworker/providers: entity association: mysql is not configured")
	}
	var event associationSourceEvent
	var triggeredAt sql.NullTime
	var metricValue sql.NullString
	err := p.deps.DB.QueryRowContext(ctx,
		"SELECT e.id, e.ruleId, e.triggeredAt, e.metricValue, e.status"+
			" FROM AlertEvent e JOIN AlertRule r ON r.id = e.ruleId"+
			" WHERE e.triggeredAt >= ? AND e.status IN (?, ?, ?)"+
			" AND r.orgId = ? AND r.metricProvider = ? AND r.metricSlug = ?"+
			" ORDER BY e.triggeredAt DESC LIMIT 1",
		since,
		alertEventStatusPending, alertEventStatusDelivered, alertEventStatusConfirmed,
		orgID, TypeEntitySentiment, metricSlug,
	).Scan(&event.ID, &event.RuleID, &triggeredAt, &metricValue, &event.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return associationSourceEvent{}, false, nil
	}
	if err != nil {
		return associationSourceEvent{}, false, fmt.Errorf("alertworker/providers: entity association source event: %w", err)
	}
	if triggeredAt.Valid {
		event.TriggeredAt = triggeredAt.Time
	}
	// AlertEvent.metricValue is Decimal(38,12); database/sql hands it back as a
	// string (the house style keeps it in a sql.NullString). Number(decimal) in
	// NestJS is the same decimal value, and Number(null) is 0.
	rawMetricValue := "0"
	if metricValue.Valid {
		rawMetricValue = metricValue.String
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(rawMetricValue), 64)
	if err != nil {
		return associationSourceEvent{}, false, fmt.Errorf(
			"alertworker/providers: entity association metric value %q: %w", rawMetricValue, err)
	}
	event.MetricValue = value
	return event, true, nil
}

// findEdges reads the org-scoped edges touching the seed, ordered by
// confidence DESC, weight DESC, updatedAt DESC.
func (p *associationProvider) findEdges(ctx context.Context, orgID, seedID string, limit int) ([]associationEdge, error) {
	if p.deps.DB == nil {
		return nil, errors.New("alertworker/providers: entity association: mysql is not configured")
	}
	rows, err := p.deps.DB.QueryContext(ctx,
		"SELECT id, type, fromEntityId, toEntityId, weight, confidence"+
			" FROM KnowledgeEdge WHERE orgId = ? AND (fromEntityId = ? OR toEntityId = ?)"+
			" ORDER BY confidence DESC, weight DESC, updatedAt DESC LIMIT ?",
		orgID, seedID, seedID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity association edges: %w", err)
	}
	defer rows.Close()
	edges := make([]associationEdge, 0, limit)
	for rows.Next() {
		var edge associationEdge
		if err := rows.Scan(&edge.ID, &edge.Type, &edge.FromEntityID, &edge.ToEntityID,
			&edge.Weight, &edge.Confidence); err != nil {
			return nil, fmt.Errorf("alertworker/providers: entity association edge scan: %w", err)
		}
		edges = append(edges, edge)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity association edge rows: %w", err)
	}
	return edges, nil
}

// findNeighbors loads the neighbor entities of the edges. Only the endpoint on
// the far side of the seed is collected, exactly like the NestJS loop, so a
// self-loop edge never contributes the seed itself. Like the NestJS query it
// filters on the ids only: they were read from org-scoped edges.
func (p *associationProvider) findNeighbors(ctx context.Context, seedID string, edges []associationEdge) (map[string]associationEntity, error) {
	neighbors := make(map[string]associationEntity, len(edges))
	if len(edges) == 0 {
		return neighbors, nil
	}
	if p.deps.DB == nil {
		return nil, errors.New("alertworker/providers: entity association: mysql is not configured")
	}
	ids := make([]string, 0, len(edges))
	seen := make(map[string]struct{}, len(edges))
	for _, edge := range edges {
		otherID := edge.FromEntityID
		if edge.FromEntityID == seedID {
			otherID = edge.ToEntityID
		}
		if _, exists := seen[otherID]; exists {
			continue
		}
		seen[otherID] = struct{}{}
		ids = append(ids, otherID)
	}
	query := "SELECT id, type, canonicalName FROM KnowledgeEntity WHERE id IN (" +
		providerSQLPlaceholders(len(ids)) + ")"
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := p.deps.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity association neighbors: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var entity associationEntity
		if err := rows.Scan(&entity.ID, &entity.Type, &entity.CanonicalName); err != nil {
			return nil, fmt.Errorf("alertworker/providers: entity association neighbor scan: %w", err)
		}
		neighbors[entity.ID] = entity
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity association neighbor rows: %w", err)
	}
	return neighbors, nil
}

// associationTargets builds, filters and sorts the target list. It is the pure
// core of the provider: score = confidence * weight, dropped when non-finite or
// below minAssociationWeight, then score DESC and the first maxTargets kept.
// The sort is stable, matching Array.prototype.sort.
func associationTargets(seedID string, edges []associationEdge, neighbors map[string]associationEntity, minAssociationWeight float64, maxTargets int) []associationTarget {
	targets := make([]associationTarget, 0, len(edges))
	for _, edge := range edges {
		otherID := edge.FromEntityID
		if edge.FromEntityID == seedID {
			otherID = edge.ToEntityID
		}
		other, ok := neighbors[otherID]
		if !ok {
			continue
		}
		score := edge.Confidence * edge.Weight
		if !isFiniteMetricNumber(score) || score < minAssociationWeight {
			continue
		}
		targets = append(targets, associationTarget{
			EntityID:     other.ID,
			Name:         other.CanonicalName,
			Type:         other.Type,
			Confidence:   edge.Confidence,
			Weight:       edge.Weight,
			Score:        score,
			RelationType: edge.Type,
		})
	}
	sort.SliceStable(targets, func(i, j int) bool {
		return targets[i].Score > targets[j].Score
	})
	if len(targets) > maxTargets {
		targets = targets[:maxTargets]
	}
	return targets
}

// associationImpactScore is max(0, |sourceMetricValue| * maxEdgeScore).
func associationImpactScore(sourceMetricValue float64, targets []associationTarget) float64 {
	maxEdgeScore := 0.0
	if len(targets) > 0 {
		maxEdgeScore = targets[0].Score
	}
	impact := math.Abs(sourceMetricValue) * maxEdgeScore
	if impact < 0 || !isFiniteMetricNumber(impact) {
		return 0
	}
	return impact
}

// resolveEntity mirrors KnowledgeGraphService.resolveEntity(orgId, name) with
// no type filter: resolveEntityByName keeps the first candidate of
// listEntityCandidatesByName.
func (p *associationProvider) resolveEntity(ctx context.Context, orgID, name string) (*associationEntity, error) {
	candidates, err := p.listEntityCandidatesByName(ctx, orgID, name)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	return &candidates[0], nil
}

// listEntityCandidatesByName mirrors listEntityCandidatesByName: look the
// normalized search keys up in knowledgeEntityAlias, then rank the joined
// entities by ticker preference, alias source and entity type.
func (p *associationProvider) listEntityCandidatesByName(ctx context.Context, orgID, name string) ([]associationEntity, error) {
	normalizedAliases := associationNormalizeSearchKeys(name)
	if len(normalizedAliases) == 0 {
		return nil, nil
	}
	if p.deps.DB == nil {
		return nil, errors.New("alertworker/providers: entity association: mysql is not configured")
	}
	query := "SELECT e.id, e.type, e.canonicalName, a.source" +
		" FROM KnowledgeEntityAlias a JOIN KnowledgeEntity e ON e.id = a.entityId" +
		" WHERE a.orgId = ? AND a.normalizedAlias IN (" +
		providerSQLPlaceholders(len(normalizedAliases)) + ") LIMIT 20"
	args := make([]any, 0, len(normalizedAliases)+1)
	args = append(args, orgID)
	for _, alias := range normalizedAliases {
		args = append(args, alias)
	}
	rows, err := p.deps.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity association alias lookup: %w", err)
	}
	defer rows.Close()
	candidates := make([]associationCandidate, 0, 20)
	for rows.Next() {
		var candidate associationCandidate
		if err := rows.Scan(&candidate.Entity.ID, &candidate.Entity.Type,
			&candidate.Entity.CanonicalName, &candidate.Source); err != nil {
			return nil, fmt.Errorf("alertworker/providers: entity association alias scan: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity association alias rows: %w", err)
	}

	associationSortCandidates(candidates, associationLooksLikeTicker(name))
	entities := make([]associationEntity, 0, len(candidates))
	for _, candidate := range candidates {
		entities = append(entities, candidate.Entity)
	}
	return entities, nil
}

// associationSortCandidates is the comparator of listEntityCandidatesByName. A
// ticker-shaped query prefers instrument entities, then the alias source order
// (user, seed, derived, llm) and finally the entity type preference. The sort
// is stable, like Array.prototype.sort in V8.
func associationSortCandidates(candidates []associationCandidate, tickerQuery bool) {
	rank := func(values []string, value string) int {
		for index, candidate := range values {
			if candidate == value {
				return index
			}
		}
		return len(values)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if tickerQuery {
			leftInstrument := left.Entity.Type == "instrument"
			rightInstrument := right.Entity.Type == "instrument"
			if leftInstrument != rightInstrument {
				return leftInstrument
			}
		}
		leftSource := rank(associationAliasSourcePreference, left.Source)
		rightSource := rank(associationAliasSourcePreference, right.Source)
		if leftSource != rightSource {
			return leftSource < rightSource
		}
		return rank(associationEntityTypePreference, left.Entity.Type) <
			rank(associationEntityTypePreference, right.Entity.Type)
	})
}

// associationNormalizeEntityKey is normalizeEntityKey: trim, collapse
// whitespace, lowercase. Go's \s is ASCII whitespace while JavaScript also
// collapses some Unicode spaces; entity names are ASCII or CJK, where the two
// agree.
func associationNormalizeEntityKey(value string) string {
	return strings.ToLower(strings.TrimSpace(associationWhitespacePattern.ReplaceAllString(value, " ")))
}

// associationNormalizeSearchKeys is normalizeSearchKeys: the normalized name,
// the company alias candidates and the ticker aliases, deduplicated in
// insertion order and capped at 20 keys.
func associationNormalizeSearchKeys(value string) []string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	seen := make(map[string]struct{})
	keys := make([]string, 0, 20)
	add := func(candidate string) {
		key := associationNormalizeEntityKey(candidate)
		if key == "" {
			return
		}
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	add(trimmed)
	for _, alias := range associationCompanyAliasCandidates(trimmed) {
		add(alias)
	}
	for _, alias := range associationTickerAliases(trimmed) {
		add(alias)
	}
	if len(keys) > 20 {
		keys = keys[:20]
	}
	return keys
}

// associationCompanyAliasCandidates is buildCompanyAliasCandidates: the trimmed
// value, the value without bracketed segments, and every value with a company
// suffix removed.
func associationCompanyAliasCandidates(value string) []string {
	trimmed := strings.TrimSpace(associationWhitespacePattern.ReplaceAllString(value, " "))
	if trimmed == "" {
		return nil
	}
	seen := make(map[string]struct{})
	aliases := make([]string, 0, 8)
	add := func(candidate string) {
		if candidate == "" {
			return
		}
		if _, exists := seen[candidate]; exists {
			return
		}
		seen[candidate] = struct{}{}
		aliases = append(aliases, candidate)
	}
	add(trimmed)

	withoutBrackets := strings.TrimSpace(associationWhitespacePattern.ReplaceAllString(
		associationBracketsPattern.ReplaceAllString(trimmed, " "), " "))
	if withoutBrackets != "" {
		add(withoutBrackets)
	}

	upper := strings.ToUpper(withoutBrackets)
	runes := []rune(withoutBrackets)
	for _, suffix := range associationCompanySuffixes {
		if !strings.HasSuffix(upper, suffix) {
			continue
		}
		// Drop the matched suffix by rune count, like String.prototype.slice on
		// the UTF-16 code units; byte slicing would break if ToUpper changed the
		// byte length of a non-ASCII prefix.
		cut := len(runes) - len([]rune(suffix))
		if cut <= 0 {
			continue
		}
		add(strings.TrimSpace(string(runes[:cut])))
	}
	return aliases
}

// associationParseTicker is parseTicker: 600000.SH, SH600000 or a bare 6 digit
// code. It returns the code and the exchange (empty when the input has none).
func associationParseTicker(value string) (string, string, bool) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	if match := associationTickerDotPattern.FindStringSubmatch(normalized); match != nil {
		return match[1], match[2], true
	}
	if match := associationTickerPrefixPattern.FindStringSubmatch(normalized); match != nil {
		return match[2], match[1], true
	}
	if match := associationTickerCodePattern.FindStringSubmatch(normalized); match != nil {
		return match[1], "", true
	}
	return "", "", false
}

// associationLooksLikeTicker is looksLikeTicker.
func associationLooksLikeTicker(value string) bool {
	_, _, ok := associationParseTicker(value)
	return ok
}

// associationTickerAliases is buildTickerAliases: the bare code plus every
// `code.EXCHANGE` / `EXCHANGEcode` form.
func associationTickerAliases(value string) []string {
	code, exchange, ok := associationParseTicker(value)
	if !ok {
		return nil
	}
	seen := make(map[string]struct{})
	aliases := make([]string, 0, 7)
	add := func(candidate string) {
		if _, exists := seen[candidate]; exists {
			return
		}
		seen[candidate] = struct{}{}
		aliases = append(aliases, candidate)
	}
	add(code)
	exchanges := []string{"SH", "SZ", "BJ"}
	if exchange != "" {
		exchanges = []string{exchange}
	}
	for _, candidate := range exchanges {
		add(code + "." + candidate)
		add(candidate + code)
	}
	return aliases
}
