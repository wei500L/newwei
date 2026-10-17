package kgimpact

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	eigDataCachePrefix        = "entityImpactGraph:data:"
	maxCorrelationEntities    = 50
	maxCorrelationInstruments = 50
	minCorrelationDataPoints  = 5
)

type entityNode struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Category   string  `json:"category"`
	Value      float64 `json:"value"`
	SymbolSize float64 `json:"symbolSize"`
}

type entityLink struct {
	Source   string  `json:"source"`
	Target   string  `json:"target"`
	Value    float64 `json:"value"`
	LinkType string  `json:"linkType"`
}

type entityCategory struct {
	Name string `json:"name"`
}

// entityGraphData mirrors EntityImpactGraphService's EntityImpactGraphData JSON
// so either side can read the other's Redis key.
type entityGraphData struct {
	Nodes      []entityNode     `json:"nodes"`
	Links      []entityLink     `json:"links"`
	Categories []entityCategory `json:"categories"`
}

type coOccurrenceRecord struct {
	EntityA string `bson:"entityA"`
	EntityB string `bson:"entityB"`
	TypeA   any    `bson:"typeA"`
	TypeB   any    `bson:"typeB"`
	Count   int    `bson:"count"`
}

type correlationResult struct {
	entity         string
	entityType     string
	instrument     string
	instrumentType string
	correlation    float64
	pValue         float64
}

type timeSeriesSet struct {
	order  []string
	series map[string]map[string]float64
}

func (s *store) getEntityImpactGraph(call contract.Context) (any, error) {
	orgID := call.Identity.OrgID
	input, _ := contract.MapArg(call.Args, "input")

	now := s.clock()
	endDate := now
	if value, ok := inputDate(input, "endDate"); ok {
		endDate = value
	}
	rawStartDate := endDate.Add(-30 * 24 * time.Hour)
	if value, ok := inputDate(input, "startDate"); ok {
		rawStartDate = value
	}
	maxWindow := 365 * 24 * time.Hour
	startDate := rawStartDate
	if endDate.Sub(rawStartDate) > maxWindow {
		startDate = endDate.Add(-maxWindow)
	}

	minEntityConfidence := clampUnitInterval(inputFloatDefault(input, "minConfidence", 0.5))
	minCorrelation := clampUnitInterval(inputFloatDefault(input, "minCorrelation", 0.3))
	minCoOccurrence := clampInt(truncInt(inputIntDefault(input, "minCoOccurrence", 2)), 1, 100)
	maxNodes := clampInt(truncInt(inputIntDefault(input, "maxNodes", 100)), 1, 500)
	categories := inputStringList(input, "categories")
	if categories == nil {
		categories = []string{"person", "organization", "stock", "commodity"}
	}

	settings := s.loadEigSettings(callContext(call), orgID)
	allowedCategories := normalizeEntityCategories(categories)
	cacheTTLSeconds := settings.CacheTTLSeconds

	loader := func() entityGraphData {
		ctx := callContext(call)
		coOccurrences := make([]coOccurrenceRecord, 0)
		if values, err := s.calculateCoOccurrence(ctx, orgID, startDate, endDate, minCoOccurrence, minEntityConfidence); err != nil {
			log.Printf("kgimpact: entity co-occurrence failed for org %s: %v", orgID, err)
		} else {
			coOccurrences = values
		}
		correlations := make([]correlationResult, 0)
		if values, err := s.calculateCorrelation(ctx, orgID, startDate, endDate, minCorrelation, minEntityConfidence); err != nil {
			log.Printf("kgimpact: entity correlation failed for org %s: %v", orgID, err)
		} else {
			correlations = values
		}
		return buildGraphData(coOccurrences, correlations, allowedCategories, maxNodes)
	}

	if cacheTTLSeconds <= 0 {
		return dataToModel(loader(), s.clock()), nil
	}

	cacheKey := buildEigCacheKey(orgID, startDate, endDate, minEntityConfidence, minCorrelation, minCoOccurrence, maxNodes, allowedCategories)
	ctx := callContext(call)
	if raw, ok, err := redisGetBytes(ctx, s.redis, cacheKey); err == nil && ok {
		var data entityGraphData
		if json.Unmarshal(raw, &data) == nil {
			return dataToModel(data, s.clock()), nil
		}
	}
	data := loader()
	if raw, err := json.Marshal(data); err == nil {
		if err := redisSetJSON(ctx, s.redis, cacheKey, json.RawMessage(raw), time.Duration(cacheTTLSeconds)*time.Second); err != nil {
			log.Printf("kgimpact: entity impact graph cache write failed for org %s: %v", orgID, err)
		}
	}
	return dataToModel(data, s.clock()), nil
}

func dataToModel(data entityGraphData, generatedAt time.Time) entityImpactGraphModel {
	nodes := make([]entityImpactNodeModel, 0, len(data.Nodes))
	for _, node := range data.Nodes {
		nodes = append(nodes, entityImpactNodeModel{
			ID:       node.ID,
			Name:     node.Name,
			Category: node.Category,
			Type:     node.Category,
			Value:    node.Value,
		})
	}
	links := make([]entityImpactLinkModel, 0, len(data.Links))
	for _, link := range data.Links {
		links = append(links, entityImpactLinkModel{
			Source: link.Source,
			Target: link.Target,
			Value:  link.Value,
			Type:   link.LinkType,
		})
	}
	return entityImpactGraphModel{
		Nodes: nodes,
		Links: links,
		Metadata: entityImpactMetadataModel{
			TotalNodes:  len(nodes),
			TotalLinks:  len(links),
			GeneratedAt: generatedAt,
		},
	}
}

func buildEigCacheKey(orgID string, startDate, endDate time.Time, minEntityConfidence, minCorrelation float64, minCoOccurrence, maxNodes int, categories []string) string {
	return eigDataCachePrefix + orgID +
		":" + formatISO(startDate) +
		":" + formatISO(endDate) +
		":conf=" + toFixed(minEntityConfidence, 3) +
		":corr=" + toFixed(minCorrelation, 3) +
		":co=" + itoa(minCoOccurrence) +
		":max=" + itoa(maxNodes) +
		":cats=" + strings.Join(normalizeEntityCategories(categories), ",")
}

// normalizeEntityCategories mirrors EntityImpactGraphService.normalizeCategories
// (allowed filter, dedupe, ascending sort, full default set when empty).
func normalizeEntityCategories(input []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(allowedEntityImpactCategories))
	for _, entry := range input {
		normalized := strings.ToLower(strings.TrimSpace(entry))
		if !containsString(allowedEntityImpactCategories, normalized) {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	if len(out) == 0 {
		out = append(out, allowedEntityImpactCategories...)
	}
	sort.Strings(out)
	return out
}

func (s *store) calculateCoOccurrence(ctx context.Context, orgID string, startDate, endDate time.Time, minCount int, minEntityConfidence float64) ([]coOccurrenceRecord, error) {
	if s == nil || s.mongo == nil {
		return nil, errMongoUnavailable
	}
	cursor, err := s.mongo.Collection(processedItemsCollection).Aggregate(ctx, coOccurrencePipeline(orgID, startDate, endDate, minCount, minEntityConfidence))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]coOccurrenceRecord, 0)
	for cursor.Next(ctx) {
		var record coOccurrenceRecord
		if err := cursor.Decode(&record); err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, cursor.Err()
}

func (s *store) calculateCorrelation(ctx context.Context, orgID string, startDate, endDate time.Time, minCorrelation, minEntityConfidence float64) ([]correlationResult, error) {
	results := make([]correlationResult, 0)

	entitySeries, err := s.getEntityMentionTimeSeries(ctx, orgID, startDate, endDate, minEntityConfidence)
	if err != nil {
		return nil, err
	}
	if len(entitySeries.series) == 0 {
		return results, nil
	}
	instrumentSeries, err := s.getFinancialTimeSeries(ctx, startDate, endDate)
	if err != nil {
		return nil, err
	}
	if len(instrumentSeries.series) == 0 {
		return results, nil
	}

	type entry struct {
		key           string
		data          map[string]float64
		totalMentions float64
		points        int
	}

	entityEntries := make([]entry, 0, len(entitySeries.order))
	for _, key := range entitySeries.order {
		data := entitySeries.series[key]
		total := 0.0
		for _, value := range data {
			total += value
		}
		entityEntries = append(entityEntries, entry{key: key, data: data, totalMentions: total})
	}
	sort.SliceStable(entityEntries, func(i, j int) bool {
		return entityEntries[i].totalMentions > entityEntries[j].totalMentions
	})
	if len(entityEntries) > maxCorrelationEntities {
		entityEntries = entityEntries[:maxCorrelationEntities]
	}

	instrumentEntries := make([]entry, 0, len(instrumentSeries.order))
	for _, key := range instrumentSeries.order {
		data := instrumentSeries.series[key]
		instrumentEntries = append(instrumentEntries, entry{key: key, data: data, points: len(data)})
	}
	sort.SliceStable(instrumentEntries, func(i, j int) bool {
		return instrumentEntries[i].points > instrumentEntries[j].points
	})
	if len(instrumentEntries) > maxCorrelationInstruments {
		instrumentEntries = instrumentEntries[:maxCorrelationInstruments]
	}

	for _, entityEntry := range entityEntries {
		entityParts := strings.Split(entityEntry.key, "::")
		if len(entityParts) < 2 {
			continue
		}
		entityName, entityType := entityParts[0], entityParts[1]
		if entityName == "" || entityType == "" {
			continue
		}
		for _, instrumentEntry := range instrumentEntries {
			instrumentParts := strings.Split(instrumentEntry.key, "::")
			if len(instrumentParts) < 2 {
				continue
			}
			instrumentName, instrumentType := instrumentParts[0], instrumentParts[1]
			if instrumentName == "" || instrumentType == "" {
				continue
			}
			alignedX, alignedY := alignTimeSeries(entityEntry.data, instrumentEntry.data)
			if len(alignedX) < minCorrelationDataPoints {
				continue
			}
			correlation, pValue := pearsonCorrelation(alignedX, alignedY)
			if math.Abs(correlation) >= minCorrelation && pValue < 0.05 {
				results = append(results, correlationResult{
					entity:         entityName,
					entityType:     entityType,
					instrument:     instrumentName,
					instrumentType: instrumentType,
					correlation:    correlation,
					pValue:         pValue,
				})
			}
		}
	}
	return results, nil
}

func (s *store) getEntityMentionTimeSeries(ctx context.Context, orgID string, startDate, endDate time.Time, minEntityConfidence float64) (timeSeriesSet, error) {
	out := timeSeriesSet{order: []string{}, series: map[string]map[string]float64{}}
	if s == nil || s.mongo == nil {
		return out, errMongoUnavailable
	}
	cursor, err := s.mongo.Collection(processedItemsCollection).Aggregate(ctx, entityMentionPipeline(orgID, startDate, endDate, minEntityConfidence))
	if err != nil {
		return out, err
	}
	defer cursor.Close(ctx)
	type seriesPoint struct {
		DateKey string `bson:"dateKey"`
		Count   int    `bson:"count"`
	}
	type row struct {
		Name   string        `bson:"name"`
		Type   any           `bson:"type"`
		Series []seriesPoint `bson:"series"`
	}
	for cursor.Next(ctx) {
		var document row
		if err := cursor.Decode(&document); err != nil {
			return out, err
		}
		key := document.Name + "::" + jsString(document.Type)
		series := map[string]float64{}
		for _, point := range document.Series {
			series[point.DateKey] = float64(point.Count)
		}
		out.series[key] = series
		out.order = append(out.order, key)
	}
	return out, cursor.Err()
}

// getFinancialTimeSeries mirrors EntityImpactGraphService.getFinancialTimeSeries.
func (s *store) getFinancialTimeSeries(ctx context.Context, startDate, endDate time.Time) (timeSeriesSet, error) {
	out := timeSeriesSet{order: []string{}, series: map[string]map[string]float64{}}
	if s == nil || s.db == nil {
		return out, errDatabaseUnavailable
	}
	const query = `SELECT p.recordedAt, p.value, i.displayName,
       COALESCE((SELECT c.key FROM EconomicDataItemCategory ic JOIN EconomicCategory c ON c.id = ic.categoryId WHERE ic.itemId = i.id ORDER BY ic.id ASC LIMIT 1), 'unknown') AS categoryKey
FROM EconomicDataPoint p
JOIN EconomicDataItem i ON i.id = p.itemId
WHERE p.recordedAt >= ? AND p.recordedAt <= ?
  AND EXISTS (SELECT 1 FROM EconomicDataItemCategory ic2 JOIN EconomicCategory c2 ON c2.id = ic2.categoryId WHERE ic2.itemId = i.id AND c2.key IN ('stock-index','commodity','forex','precious-metals'))
ORDER BY p.recordedAt ASC`
	rows, err := s.db.QueryContext(ctx, query, startDate, endDate)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var recordedAt time.Time
		var valueRaw []byte
		var displayName, categoryKey string
		if err := rows.Scan(&recordedAt, &valueRaw, &displayName, &categoryKey); err != nil {
			return out, err
		}
		dateKey := recordedAt.UTC().Format("2006-01-02")
		instrumentType := "commodity"
		if strings.Contains(categoryKey, "stock") {
			instrumentType = "stock"
		}
		key := displayName + "::" + instrumentType
		series, ok := out.series[key]
		if !ok {
			series = map[string]float64{}
			out.series[key] = series
			out.order = append(out.order, key)
		}
		series[dateKey] = parseDecimal(valueRaw)
	}
	return out, rows.Err()
}

func parseDecimal(raw []byte) float64 {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil {
		return 0
	}
	return parsed
}

func alignTimeSeries(seriesA, seriesB map[string]float64) ([]float64, []float64) {
	x := make([]float64, 0)
	y := make([]float64, 0)
	for date, valueA := range seriesA {
		valueB, ok := seriesB[date]
		if !ok {
			continue
		}
		x = append(x, valueA)
		y = append(y, valueB)
	}
	return x, y
}

func buildGraphData(coOccurrences []coOccurrenceRecord, correlations []correlationResult, allowedCategories []string, maxNodes int) entityGraphData {
	nodeMap := map[string]*entityNode{}
	nodeOrder := make([]string, 0)
	links := make([]entityLink, 0)

	categories := make([]entityCategory, 0, 4)
	for _, name := range []string{"person", "organization", "stock", "commodity"} {
		if containsString(allowedCategories, name) {
			categories = append(categories, entityCategory{Name: name})
		}
	}

	addNode := func(name string, rawType any, weight float64) (string, bool) {
		normalizedName := strings.TrimSpace(name)
		if normalizedName == "" {
			return "", false
		}
		category := normalizeEntityCategory(rawType)
		if !containsString(allowedCategories, category) {
			return "", false
		}
		if existing, ok := nodeMap[normalizedName]; ok {
			existing.Value += weight
			existing.SymbolSize = math.Min(50, 10+math.Sqrt(existing.Value)*3)
			return existing.ID, true
		}
		node := &entityNode{
			ID:         normalizedName,
			Name:       normalizedName,
			Category:   category,
			Value:      weight,
			SymbolSize: math.Min(50, 10+math.Sqrt(weight)*3),
		}
		nodeMap[normalizedName] = node
		nodeOrder = append(nodeOrder, normalizedName)
		return node.ID, true
	}

	for _, record := range coOccurrences {
		sourceID, okSource := addNode(record.EntityA, record.TypeA, float64(record.Count))
		targetID, okTarget := addNode(record.EntityB, record.TypeB, float64(record.Count))
		if !okSource || !okTarget || sourceID == targetID {
			continue
		}
		links = append(links, entityLink{Source: sourceID, Target: targetID, Value: float64(record.Count), LinkType: "co-occurrence"})
	}

	for _, record := range correlations {
		weight := math.Abs(record.correlation) * 10
		sourceID, okSource := addNode(record.entity, record.entityType, weight)
		targetID, okTarget := addNode(record.instrument, record.instrumentType, weight)
		if !okSource || !okTarget || sourceID == targetID {
			continue
		}
		links = append(links, entityLink{Source: sourceID, Target: targetID, Value: math.Abs(record.correlation), LinkType: "correlation"})
	}

	nodesList := make([]*entityNode, 0, len(nodeOrder))
	for _, name := range nodeOrder {
		nodesList = append(nodesList, nodeMap[name])
	}
	nodeIDs := map[string]struct{}{}
	for _, node := range nodesList {
		nodeIDs[node.ID] = struct{}{}
	}
	filteredLinks := make([]entityLink, 0, len(links))
	for _, link := range links {
		if _, ok := nodeIDs[link.Source]; !ok {
			continue
		}
		if _, ok := nodeIDs[link.Target]; !ok {
			continue
		}
		if link.Source == link.Target {
			continue
		}
		filteredLinks = append(filteredLinks, link)
	}

	if len(nodesList) > maxNodes {
		sort.SliceStable(nodesList, func(i, j int) bool {
			return nodesList[i].Value > nodesList[j].Value
		})
		nodesList = nodesList[:maxNodes]
		nodeIDs = map[string]struct{}{}
		for _, node := range nodesList {
			nodeIDs[node.ID] = struct{}{}
		}
		kept := make([]entityLink, 0, len(filteredLinks))
		for _, link := range filteredLinks {
			if _, ok := nodeIDs[link.Source]; !ok {
				continue
			}
			if _, ok := nodeIDs[link.Target]; !ok {
				continue
			}
			if link.Source == link.Target {
				continue
			}
			kept = append(kept, link)
		}
		filteredLinks = kept
	}

	nodes := make([]entityNode, 0, len(nodesList))
	for _, node := range nodesList {
		nodes = append(nodes, *node)
	}
	return entityGraphData{Nodes: nodes, Links: filteredLinks, Categories: categories}
}

// normalizeEntityCategory mirrors buildGraphData's normalizeCategory.
func normalizeEntityCategory(rawType any) string {
	lower := ""
	if text, ok := rawType.(string); ok {
		lower = strings.ToLower(strings.TrimSpace(text))
	}
	switch {
	case strings.Contains(lower, "person") || strings.Contains(lower, "people"):
		return "person"
	case strings.Contains(lower, "org") || strings.Contains(lower, "company") || strings.Contains(lower, "institution"):
		return "organization"
	case strings.Contains(lower, "stock") || strings.Contains(lower, "equity"):
		return "stock"
	case strings.Contains(lower, "commodity") || strings.Contains(lower, "gold") || strings.Contains(lower, "oil"):
		return "commodity"
	default:
		return "organization"
	}
}

func coOccurrencePipeline(orgID string, startDate, endDate time.Time, minCount int, minEntityConfidence float64) bson.A {
	return bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: startDate}, {Key: "$lte", Value: endDate}}},
			{Key: "result.entities", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: bson.A{}}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemId", Value: bson.D{{Key: "$toString", Value: "$_id"}}},
			{Key: "entities", Value: bson.D{{Key: "$filter", Value: bson.D{
				{Key: "input", Value: "$result.entities"},
				{Key: "as", Value: "e"},
				{Key: "cond", Value: bson.D{{Key: "$and", Value: bson.A{
					bson.D{{Key: "$ne", Value: bson.A{"$$e.name", nil}}},
					bson.D{{Key: "$ne", Value: bson.A{"$$e.name", ""}}},
					bson.D{{Key: "$gte", Value: bson.A{
						bson.D{{Key: "$ifNull", Value: bson.A{"$$e.confidence", 0}}},
						minEntityConfidence,
					}}},
				}}}},
			}}}},
		}}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "$expr", Value: bson.D{{Key: "$gte", Value: bson.A{
			bson.D{{Key: "$size", Value: "$entities"}}, 2,
		}}}}}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemId", Value: 1},
			{Key: "entities", Value: 1},
			{Key: "entities2", Value: "$entities"},
		}}},
		bson.D{{Key: "$unwind", Value: bson.D{{Key: "path", Value: "$entities"}, {Key: "includeArrayIndex", Value: "i"}}}},
		bson.D{{Key: "$unwind", Value: bson.D{{Key: "path", Value: "$entities2"}, {Key: "includeArrayIndex", Value: "j"}}}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "$expr", Value: bson.D{{Key: "$lt", Value: bson.A{"$i", "$j"}}}}}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemId", Value: 1},
			{Key: "a", Value: "$entities"},
			{Key: "b", Value: "$entities2"},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "itemId", Value: 1},
			{Key: "first", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$lt", Value: bson.A{"$a.name", "$b.name"}}}, "$a", "$b",
			}}}},
			{Key: "second", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$lt", Value: bson.A{"$a.name", "$b.name"}}}, "$b", "$a",
			}}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{{Key: "entityA", Value: "$first.name"}, {Key: "entityB", Value: "$second.name"}}},
			{Key: "typeA", Value: bson.D{{Key: "$first", Value: "$first.type"}}},
			{Key: "typeB", Value: bson.D{{Key: "$first", Value: "$second.type"}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "articleIds", Value: bson.D{{Key: "$addToSet", Value: "$itemId"}}},
		}}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "count", Value: bson.D{{Key: "$gte", Value: minCount}}}}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "entityA", Value: "$_id.entityA"},
			{Key: "entityB", Value: "$_id.entityB"},
			{Key: "typeA", Value: 1},
			{Key: "typeB", Value: 1},
			{Key: "count", Value: 1},
			{Key: "articleIds", Value: 1},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}},
	}
}

func entityMentionPipeline(orgID string, startDate, endDate time.Time, minEntityConfidence float64) bson.A {
	return bson.A{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: startDate}, {Key: "$lte", Value: endDate}}},
			{Key: "result.entities", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: bson.A{}}}},
		}}},
		bson.D{{Key: "$unwind", Value: "$result.entities"}},
		bson.D{{Key: "$match", Value: bson.D{{Key: "$expr", Value: bson.D{{Key: "$and", Value: bson.A{
			bson.D{{Key: "$ne", Value: bson.A{"$result.entities.name", nil}}},
			bson.D{{Key: "$ne", Value: bson.A{"$result.entities.name", ""}}},
			bson.D{{Key: "$gte", Value: bson.A{
				bson.D{{Key: "$ifNull", Value: bson.A{"$result.entities.confidence", 0}}},
				minEntityConfidence,
			}}},
		}}}}}}},
		bson.D{{Key: "$project", Value: bson.D{
			// The explicit timezone keeps entity and financial series aligned on
			// UTC calendar days.
			{Key: "dateKey", Value: bson.D{{Key: "$dateToString", Value: bson.D{
				{Key: "format", Value: "%Y-%m-%d"},
				{Key: "date", Value: "$createdAt"},
				{Key: "timezone", Value: "UTC"},
			}}}},
			{Key: "name", Value: "$result.entities.name"},
			{Key: "type", Value: "$result.entities.type"},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{
				{Key: "name", Value: "$name"},
				{Key: "type", Value: "$type"},
				{Key: "dateKey", Value: "$dateKey"},
			}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{{Key: "name", Value: "$_id.name"}, {Key: "type", Value: "$_id.type"}}},
			{Key: "totalMentions", Value: bson.D{{Key: "$sum", Value: "$count"}}},
			{Key: "series", Value: bson.D{{Key: "$push", Value: bson.D{{Key: "dateKey", Value: "$_id.dateKey"}, {Key: "count", Value: "$count"}}}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "totalMentions", Value: -1}}}},
		bson.D{{Key: "$limit", Value: maxCorrelationEntities}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "name", Value: "$_id.name"},
			{Key: "type", Value: "$_id.type"},
			{Key: "series", Value: 1},
		}}},
	}
}
