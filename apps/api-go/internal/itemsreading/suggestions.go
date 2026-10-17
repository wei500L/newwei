package itemsreading

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// suggestionEntry is one merged suggestion with its score bookkeeping.
type suggestionEntry struct {
	Type          SuggestionType
	Value         string
	Score         float64
	Hits          int
	LexicalScore  float64
	SemanticScore float64
}

// semanticSuggestion is one vector-recalled suggestion before merging.
type semanticSuggestion struct {
	Type  SuggestionType
	Value string
	Score float64
}

// ReadModelSourceCounts ports the read-model branch of
// resolveSourceSuggestionCounts.
func (s *mongoStore) ReadModelSourceCounts(
	ctx context.Context,
	orgID string,
	normalizedPrefix string,
) ([]SourceCount, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: bson.D{{Key: "$ne", Value: string(ItemStatusDuplicate)}}},
			{Key: "sourceNameLower", Value: bson.Regex{Pattern: EscapeRegex(normalizedPrefix), Options: "i"}},
		}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$sourceNameLower"},
			{Key: "sourceName", Value: bson.D{{Key: "$first", Value: "$sourceName"}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
		{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}, {Key: "sourceName", Value: 1}}}},
		{{Key: "$limit", Value: SearchSuggestionsMaxSourceScan}},
	}
	cursor, err := s.readModels().Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]SourceCount, 0, 32)
	for cursor.Next(ctx) {
		var row struct {
			SourceName string `bson:"sourceName"`
			Count      int    `bson:"count"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		source := strings.TrimSpace(row.SourceName)
		if source == "" {
			continue
		}
		out = append(out, SourceCount{
			Source:           source,
			NormalizedSource: strings.ToLower(source),
			Count:            row.Count,
		})
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// SearchSuggestions ports ItemsSearchService.searchSuggestions. limit keeps the
// GraphQL Float contract: it is clamped to [1,25] without being floored, the
// cache key uses the same textual form NestJS produces, and the slice截断 uses
// the integer part.
func (s *Service) SearchSuggestions(
	ctx context.Context,
	orgID string,
	prefix string,
	limit *float64,
) ([]SearchSuggestion, error) {
	trimmedPrefix := strings.TrimSpace(prefix)
	normalizedPrefix := strings.ToLower(trimmedPrefix)
	if normalizedPrefix == "" {
		return []SearchSuggestion{}, nil
	}

	limitValue := float64(DefaultSuggestionLimit)
	if limit != nil {
		limitValue = *limit
	}
	clampedLimit := limitValue
	if clampedLimit < 1 {
		clampedLimit = 1
	}
	if clampedLimit > SearchSuggestionsMaxLimit {
		clampedLimit = SearchSuggestionsMaxLimit
	}
	semanticLimitValue := clampedLimit * 6
	if semanticLimitValue > 80 {
		semanticLimitValue = 80
	}
	semanticLimit := int(truncate(semanticLimitValue))
	sliceLimit := int(truncate(clampedLimit))

	cacheKey := ItemsSearchSuggestionsPrefix + orgID + ":" + normalizedPrefix + ":" +
		formatJSNumber(clampedLimit) + ":v3"

	payload, err := s.cache.Wrap(ctx, cacheKey, SearchSuggestionsCacheTTLSeconds, func(inner context.Context) (json.RawMessage, error) {
		facets, err := s.Facets(inner, orgID, "", nil)
		if err != nil {
			return nil, err
		}
		sourceCounts, err := s.resolveSourceSuggestionCounts(inner, orgID, normalizedPrefix)
		if err != nil {
			return nil, err
		}
		semantic, err := s.resolveSemanticSuggestions(inner, orgID, trimmedPrefix, semanticLimit)
		if err != nil {
			return nil, err
		}
		merged := mergeSuggestions(facets, sourceCounts, semantic, normalizedPrefix, sliceLimit)
		encoded, err := json.Marshal(merged)
		if err != nil {
			return nil, err
		}
		return json.RawMessage(encoded), nil
	})
	if err != nil {
		return nil, err
	}
	var suggestions []SearchSuggestion
	if err := json.Unmarshal(payload, &suggestions); err != nil {
		return nil, err
	}
	return suggestions, nil
}

// mergeSuggestions ports the lexical + semantic merge inside searchSuggestions.
func mergeSuggestions(
	facets ItemFacets,
	sourceCounts []SourceCount,
	semantic []semanticSuggestion,
	normalizedPrefix string,
	sliceLimit int,
) []SearchSuggestion {
	bucket := make(map[string]*suggestionEntry)
	order := make([]string, 0, 32)

	add := func(suggestionType SuggestionType, rawValue string, score float64, semantic bool) {
		value := strings.TrimSpace(rawValue)
		if value == "" {
			return
		}
		key := string(suggestionType) + ":" + strings.ToLower(value)
		current, ok := bucket[key]
		if !ok {
			entry := &suggestionEntry{Type: suggestionType, Value: value, Score: score, Hits: 1}
			if semantic {
				entry.SemanticScore = score
			} else {
				entry.LexicalScore = score
			}
			bucket[key] = entry
			order = append(order, key)
			return
		}
		current.Score += score
		current.Hits++
		if semantic {
			current.SemanticScore += score
		} else {
			current.LexicalScore += score
		}
	}

	for _, topic := range facets.Topics {
		value := strings.TrimSpace(topic.Value)
		if value == "" {
			continue
		}
		normalized := strings.ToLower(value)
		switch {
		case strings.HasPrefix(normalized, normalizedPrefix):
			add(SuggestionTypeTopic, value, 360+float64(topic.Count)*2.5, false)
		case strings.Contains(normalized, normalizedPrefix):
			add(SuggestionTypeTopic, value, 180+float64(topic.Count)*1.2, false)
		}
	}
	for _, region := range facets.Regions {
		value := strings.TrimSpace(region.Value)
		if value == "" {
			continue
		}
		normalized := strings.ToLower(value)
		switch {
		case strings.HasPrefix(normalized, normalizedPrefix):
			add(SuggestionTypeRegion, value, 320+float64(region.Count)*2, false)
		case strings.Contains(normalized, normalizedPrefix):
			add(SuggestionTypeRegion, value, 160+float64(region.Count), false)
		}
	}

	sentimentCounts := make(map[string]int, len(facets.Sentiments))
	for _, entry := range facets.Sentiments {
		sentimentCounts[strings.ToLower(strings.TrimSpace(entry.Value))] = entry.Count
	}
	for _, sentiment := range allowedSentiments {
		if !strings.Contains(sentiment, normalizedPrefix) {
			continue
		}
		scoreBoost := 150.0
		if strings.HasPrefix(sentiment, normalizedPrefix) {
			scoreBoost = 300
		}
		add(SuggestionTypeSentiment, sentiment, scoreBoost+float64(sentimentCounts[sentiment])*2, false)
	}

	for _, source := range sourceCounts {
		normalized := strings.ToLower(source.Source)
		scoreBoost := 165.0
		if strings.HasPrefix(normalized, normalizedPrefix) {
			scoreBoost = 330
		}
		add(SuggestionTypeSource, source.Source, scoreBoost+float64(source.Count)*2.2, false)
	}

	for _, entry := range semantic {
		add(entry.Type, entry.Value, entry.Score, true)
	}

	entries := make([]*suggestionEntry, 0, len(order))
	for _, key := range order {
		entries = append(entries, bucket[key])
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Score != entries[j].Score {
			return entries[i].Score > entries[j].Score
		}
		if entries[i].Hits != entries[j].Hits {
			return entries[i].Hits > entries[j].Hits
		}
		if entries[i].Type != entries[j].Type {
			return localeCompare(string(entries[i].Type), string(entries[j].Type)) < 0
		}
		return localeCompare(entries[i].Value, entries[j].Value) < 0
	})
	if sliceLimit >= 0 && len(entries) > sliceLimit {
		entries = entries[:sliceLimit]
	}
	out := make([]SearchSuggestion, 0, len(entries))
	for _, entry := range entries {
		origin := SuggestionOriginLexical
		switch {
		case entry.LexicalScore > 0 && entry.SemanticScore > 0:
			origin = SuggestionOriginHybrid
		case entry.SemanticScore > 0:
			origin = SuggestionOriginSemantic
		}
		out = append(out, SearchSuggestion{Type: entry.Type, Value: entry.Value, Origin: origin})
	}
	return out
}

// resolveSourceSuggestionCounts ports resolveSourceSuggestionCounts.
func (s *Service) resolveSourceSuggestionCounts(
	ctx context.Context,
	orgID string,
	normalizedPrefix string,
) ([]SourceCount, error) {
	if s.readModelEnabled {
		rows, err := s.mongo.ReadModelSourceCounts(ctx, orgID, normalizedPrefix)
		if err != nil {
			return nil, err
		}
		return filterSourceCounts(rows, normalizedPrefix), nil
	}

	cacheKey := ItemsSourceSuggestionsPrefix + orgID + ":v1"
	payload, err := s.cache.Wrap(ctx, cacheKey, SourceSuggestionsCacheTTLSeconds, func(inner context.Context) (json.RawMessage, error) {
		rows, err := s.mongo.SourceCounts(inner, orgID)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(rows)
		if err != nil {
			return nil, err
		}
		return json.RawMessage(encoded), nil
	})
	if err != nil {
		return nil, err
	}
	var rows []SourceCount
	if err := json.Unmarshal(payload, &rows); err != nil {
		return nil, err
	}
	return filterSourceCounts(rows, normalizedPrefix), nil
}

// filterSourceCounts keeps the snapshot entries that start with or contain the
// prefix.
func filterSourceCounts(rows []SourceCount, normalizedPrefix string) []SourceCount {
	out := make([]SourceCount, 0, len(rows))
	for _, row := range rows {
		normalized := strings.ToLower(row.Source)
		if !strings.HasPrefix(normalized, normalizedPrefix) && !strings.Contains(normalized, normalizedPrefix) {
			continue
		}
		out = append(out, row)
	}
	return out
}

// shouldUseSemanticSuggestions ports shouldUseSemanticSuggestions.
func shouldUseSemanticSuggestions(prefix string) bool {
	tokens := TokenizeSearch(prefix, MongoMinTokenLength)
	return len(tokens) >= 2 || len([]rune(prefix)) >= SearchSuggestionsMinSemanticChars
}

// resolveSemanticSuggestions ports resolveSemanticSuggestions.
func (s *Service) resolveSemanticSuggestions(
	ctx context.Context,
	orgID string,
	query string,
	limit int,
) ([]semanticSuggestion, error) {
	trimmedQuery := strings.TrimSpace(query)
	normalizedQuery := strings.ToLower(trimmedQuery)
	if !shouldUseSemanticSuggestions(normalizedQuery) {
		return nil, nil
	}
	if s.vector == nil {
		return nil, nil
	}
	vectorIDs, err := s.vector.RecallIDs(ctx, orgID, trimmedQuery)
	if err != nil {
		return nil, err
	}
	if len(vectorIDs) == 0 {
		return nil, nil
	}
	topIDs := vectorIDs
	if len(topIDs) > SearchSuggestionsMaxSemanticIDs {
		topIDs = topIDs[:SearchSuggestionsMaxSemanticIDs]
	}
	tokens := TokenizeSearch(normalizedQuery, MongoMinTokenLength)
	scored := make(map[string]*semanticSuggestion)
	order := make([]string, 0, 32)
	push := func(values []string, suggestionType SuggestionType, baseScore float64) {
		pushSemanticSuggestions(scored, &order, values, suggestionType, normalizedQuery, tokens, baseScore)
	}

	if s.readModelEnabled {
		docs, err := s.readModel.loadItemReadModelsByIDs(ctx, orgID, topIDs)
		if err != nil {
			return nil, err
		}
		for index, itemMetaID := range topIDs {
			doc, ok := docs[itemMetaID]
			if !ok {
				continue
			}
			rankScore := 140 - (float64(index)/float64(maxInt(1, len(topIDs))))*80
			topics := doc.Topics
			if len(topics) > 10 {
				topics = topics[:10]
			}
			push(topics, SuggestionTypeTopic, rankScore)
			regions := make([]string, 0, 2)
			if location := nonEmptyString(doc.Location); location != "" {
				regions = append(regions, location)
			}
			if region := nonEmptyString(doc.Region); region != "" {
				regions = append(regions, region)
			}
			push(regions, SuggestionTypeRegion, rankScore*0.92)
			sources := make([]string, 0, 2)
			if sourceName := nonEmptyString(doc.SourceName); sourceName != "" {
				sources = append(sources, sourceName)
			}
			if sourceID := nonEmptyString(doc.SourceID); sourceID != "" {
				sources = append(sources, sourceID)
			}
			push(sources, SuggestionTypeSource, rankScore*0.88)
			sentiments := make([]string, 0, 1)
			if sentiment := nonEmptyString(doc.Sentiment); sentiment != "" {
				sentiments = append(sentiments, sentiment)
			}
			push(sentiments, SuggestionTypeSentiment, rankScore*0.8)
		}
	} else {
		fieldsByItem, err := s.mongo.SemanticFieldsForItems(ctx, orgID, topIDs)
		if err != nil {
			return nil, err
		}
		for index, itemMetaID := range topIDs {
			fields, ok := fieldsByItem[itemMetaID]
			if !ok {
				continue
			}
			rankScore := 140 - (float64(index)/float64(maxInt(1, len(topIDs))))*80
			push(fields.Topics, SuggestionTypeTopic, rankScore)
			push(fields.Regions, SuggestionTypeRegion, rankScore*0.92)
			push(fields.Sources, SuggestionTypeSource, rankScore*0.88)
			push(fields.Sentiments, SuggestionTypeSentiment, rankScore*0.8)
		}
	}

	entries := make([]semanticSuggestion, 0, len(order))
	for _, key := range order {
		entries = append(entries, *scored[key])
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Score != entries[j].Score {
			return entries[i].Score > entries[j].Score
		}
		if entries[i].Type != entries[j].Type {
			return localeCompare(string(entries[i].Type), string(entries[j].Type)) < 0
		}
		return localeCompare(entries[i].Value, entries[j].Value) < 0
	})
	if limit >= 0 && len(entries) > limit {
		entries = entries[:limit]
	}
	return entries, nil
}

// pushSemanticSuggestions ports pushSemanticSuggestions.
func pushSemanticSuggestions(
	bucket map[string]*semanticSuggestion,
	order *[]string,
	values []string,
	suggestionType SuggestionType,
	normalizedPrefix string,
	tokens []string,
	baseScore float64,
) {
	for _, value := range values {
		normalizedValue := strings.ToLower(strings.TrimSpace(value))
		if normalizedValue == "" {
			continue
		}
		startsWithPrefix := strings.HasPrefix(normalizedValue, normalizedPrefix)
		containsPrefix := strings.Contains(normalizedValue, normalizedPrefix)
		tokenHits := 0
		for _, token := range tokens {
			if strings.Contains(normalizedValue, token) {
				tokenHits++
			}
		}
		if !startsWithPrefix && !containsPrefix && tokenHits == 0 && len(tokens) < 2 &&
			len([]rune(normalizedPrefix)) < SearchSuggestionsMinSemanticChars {
			continue
		}
		score := baseScore
		if startsWithPrefix {
			score += 48
		}
		if containsPrefix {
			score += 24
		}
		score += float64(tokenHits) * 10

		key := string(suggestionType) + ":" + normalizedValue
		current, ok := bucket[key]
		if !ok {
			bucket[key] = &semanticSuggestion{Type: suggestionType, Value: strings.TrimSpace(value), Score: score}
			*order = append(*order, key)
			continue
		}
		current.Score += score
	}
}

// formatJSNumber renders a float the way JavaScript `${value}` does for the
// clamped suggestion limit (integers stay integral).
func formatJSNumber(value float64) string {
	return strconv.FormatFloat(value, 'g', -1, 64)
}

// maxInt returns the larger of two ints.
func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
