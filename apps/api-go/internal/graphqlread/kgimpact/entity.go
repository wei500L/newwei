package kgimpact

import (
	"context"
	"database/sql"
	"regexp"
	"sort"
	"strings"
)

var (
	tickerDotRe    = regexp.MustCompile(`^(\d{6})\.(SH|SZ|BJ)$`)
	tickerPrefixRe = regexp.MustCompile(`^(SH|SZ|BJ)(\d{6})$`)
	tickerRawRe    = regexp.MustCompile(`^(\d{6})$`)
	bracketRe      = regexp.MustCompile(`\s*[(\x{FF08}][^)\x{FF09}]+[)\x{FF09}]\s*`)
	whitespaceRe   = regexp.MustCompile(`\s+`)
)

var companyAliasSuffixes = []string{
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

var entityTypePreference = []string{"company", "commodity", "policy", "industry", "person", "instrument", "organization"}
var recordSourcePreference = []string{"user", "seed", "derived", "llm"}

func normalizeEntityKey(value string) string {
	return strings.ToLower(strings.TrimSpace(whitespaceRe.ReplaceAllString(strings.TrimSpace(value), " ")))
}

// normalizeSearchKeys mirrors KnowledgeGraphService.normalizeSearchKeys.
func normalizeSearchKeys(value string) []string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	keys := map[string]struct{}{}
	order := make([]string, 0, 20)
	add := func(raw string) {
		key := normalizeEntityKey(raw)
		if key == "" {
			return
		}
		if _, exists := keys[key]; exists {
			return
		}
		keys[key] = struct{}{}
		order = append(order, key)
	}

	add(trimmed)
	for _, alias := range buildCompanyAliasCandidates(trimmed) {
		add(alias)
	}
	for _, alias := range buildTickerAliases(trimmed) {
		add(alias)
	}
	if len(order) > 20 {
		order = order[:20]
	}
	return order
}

// buildCompanyAliasCandidates mirrors KnowledgeGraphService.buildCompanyAliasCandidates.
func buildCompanyAliasCandidates(value string) []string {
	trimmed := strings.TrimSpace(whitespaceRe.ReplaceAllString(value, " "))
	if trimmed == "" {
		return nil
	}
	aliases := map[string]struct{}{}
	order := make([]string, 0, 4)
	add := func(raw string) {
		if raw == "" {
			return
		}
		if _, exists := aliases[raw]; exists {
			return
		}
		aliases[raw] = struct{}{}
		order = append(order, raw)
	}

	add(trimmed)

	withoutBrackets := strings.TrimSpace(whitespaceRe.ReplaceAllString(bracketRe.ReplaceAllString(trimmed, " "), " "))
	if withoutBrackets != "" && withoutBrackets != trimmed {
		add(withoutBrackets)
	}

	upper := strings.ToUpper(withoutBrackets)
	for _, suffix := range companyAliasSuffixes {
		if !strings.HasSuffix(upper, suffix) {
			continue
		}
		runes := []rune(withoutBrackets)
		cut := len(runes) - len([]rune(suffix))
		if cut <= 0 {
			continue
		}
		add(strings.TrimSpace(string(runes[:cut])))
	}
	return order
}

type parsedTicker struct {
	code     string
	exchange string
}

// parseTicker mirrors KnowledgeGraphService.parseTicker.
func parseTicker(value string) (parsedTicker, bool) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	if match := tickerDotRe.FindStringSubmatch(normalized); match != nil {
		return parsedTicker{code: match[1], exchange: match[2]}, true
	}
	if match := tickerPrefixRe.FindStringSubmatch(normalized); match != nil {
		return parsedTicker{code: match[2], exchange: match[1]}, true
	}
	if match := tickerRawRe.FindStringSubmatch(normalized); match != nil {
		return parsedTicker{code: match[1]}, true
	}
	return parsedTicker{}, false
}

func looksLikeTicker(value string) bool {
	_, ok := parseTicker(value)
	return ok
}

// buildTickerAliases mirrors KnowledgeGraphService.buildTickerAliases.
func buildTickerAliases(value string) []string {
	parsed, ok := parseTicker(value)
	if !ok {
		return nil
	}
	aliases := map[string]struct{}{}
	order := make([]string, 0, 7)
	add := func(raw string) {
		if _, exists := aliases[raw]; exists {
			return
		}
		aliases[raw] = struct{}{}
		order = append(order, raw)
	}

	add(parsed.code)
	if parsed.exchange != "" {
		add(parsed.code + "." + parsed.exchange)
		add(parsed.exchange + parsed.code)
	} else {
		for _, exchange := range []string{"SH", "SZ", "BJ"} {
			add(parsed.code + "." + exchange)
			add(exchange + parsed.code)
		}
	}
	return order
}

type entityCandidate struct {
	entity entityRow
	source string
}

// listEntityCandidatesByName mirrors KnowledgeGraphService.listEntityCandidatesByName.
func (s *store) listEntityCandidatesByName(ctx context.Context, orgID, name, entityType string) ([]entityRow, error) {
	normalizedAliases := normalizeSearchKeys(name)
	if len(normalizedAliases) == 0 {
		return nil, nil
	}
	query := "SELECT e.id, e.type, e.canonicalName, e.properties, a.source FROM KnowledgeEntityAlias a JOIN KnowledgeEntity e ON e.id = a.entityId WHERE a.orgId = ? AND a.normalizedAlias IN (" + placeholders(len(normalizedAliases)) + ") LIMIT 20"
	args := make([]any, 0, len(normalizedAliases)+1)
	args = append(args, orgID)
	for _, alias := range normalizedAliases {
		args = append(args, alias)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	candidates := make([]entityCandidate, 0)
	for rows.Next() {
		var candidate entityCandidate
		var source sql.NullString
		var id, candidateType, canonicalName sql.NullString
		var properties []byte
		if err := rows.Scan(&id, &candidateType, &canonicalName, &properties, &source); err != nil {
			return nil, err
		}
		candidate.entity = entityRow{
			id:            id.String,
			entityType:    candidateType.String,
			canonicalName: canonicalName.String,
			properties:    jsonValue(properties),
		}
		candidate.source = source.String
		if entityType != "" && candidate.entity.entityType != entityType {
			continue
		}
		candidates = append(candidates, candidate)
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
			leftInstrument := left.entity.entityType == "instrument"
			rightInstrument := right.entity.entityType == "instrument"
			if leftInstrument && !rightInstrument {
				return true
			}
			if rightInstrument && !leftInstrument {
				return false
			}
		}
		leftSource := rankOf(recordSourcePreference, left.source)
		rightSource := rankOf(recordSourcePreference, right.source)
		if leftSource != rightSource {
			return leftSource < rightSource
		}
		return rankOf(entityTypePreference, left.entity.entityType) < rankOf(entityTypePreference, right.entity.entityType)
	})

	out := make([]entityRow, 0, len(candidates))
	for _, candidate := range candidates {
		out = append(out, candidate.entity)
	}
	return out, nil
}

func rankOf(preference []string, value string) int {
	for index, item := range preference {
		if item == value {
			return index
		}
	}
	return len(preference)
}

// resolveEntity mirrors KnowledgeGraphService.resolveEntity.
func (s *store) resolveEntity(ctx context.Context, orgID, name, entityType string) (*entityRow, error) {
	candidates, err := s.listEntityCandidatesByName(ctx, orgID, name, entityType)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	first := candidates[0]
	return &first, nil
}

// resolveCompanySeed mirrors KnowledgeGraphImpactService.resolveCompanySeed.
func (s *store) resolveCompanySeed(ctx context.Context, orgID, companyName string) (*entityRow, error) {
	company, err := s.resolveEntity(ctx, orgID, companyName, "company")
	if err != nil {
		return nil, err
	}
	if company != nil {
		return company, nil
	}
	instrument, err := s.resolveEntity(ctx, orgID, companyName, "instrument")
	if err != nil || instrument == nil {
		return nil, err
	}
	edges, err := s.loadHasTickerEdges(ctx, orgID, instrument.id, 20)
	if err != nil {
		return nil, err
	}
	candidateIDs := map[string]struct{}{}
	for _, edge := range edges {
		if edge.fromEntityID == instrument.id {
			candidateIDs[edge.toEntityID] = struct{}{}
		} else {
			candidateIDs[edge.fromEntityID] = struct{}{}
		}
	}
	idList := make([]string, 0, len(candidateIDs))
	for id := range candidateIDs {
		idList = append(idList, id)
	}
	entities, err := s.loadEntityList(ctx, orgID, idList)
	if err != nil {
		return nil, err
	}
	for index := range entities {
		if entities[index].entityType == "company" {
			return &entities[index], nil
		}
	}
	return nil, nil
}
