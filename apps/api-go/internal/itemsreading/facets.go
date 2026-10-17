package itemsreading

import (
	"context"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// readModelFacetRow is the denormalized read-model projection the facet
// aggregation reads.
type readModelFacetRow struct {
	Region      *string  `bson:"region"`
	Location    *string  `bson:"location"`
	Topics      []string `bson:"topics"`
	Entities    []string `bson:"entities"`
	Tags        []string `bson:"tags"`
	Sentiment   *string  `bson:"sentiment"`
	ContentType *string  `bson:"contentType"`
}

// FacetReadModelFields loads the denormalized facet fields for the scoped ids.
func (s *mongoStore) FacetReadModelFields(
	ctx context.Context,
	orgID string,
	scopedIDs []string,
) ([]readModelFacetRow, error) {
	projection := bson.D{
		{Key: "region", Value: 1},
		{Key: "location", Value: 1},
		{Key: "topics", Value: 1},
		{Key: "entities", Value: 1},
		{Key: "tags", Value: 1},
		{Key: "sentiment", Value: 1},
		{Key: "contentType", Value: 1},
	}
	cursor, err := s.readModels().Find(ctx, readModelScopedMatch(orgID, scopedIDs), options.Find().SetProjection(projection))
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)
	out := make([]readModelFacetRow, 0, 64)
	for cursor.Next(ctx) {
		var row readModelFacetRow
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// allowedSentiments and allowedContentTypes mirror the facet whitelists.
var allowedSentiments = []string{"positive", "neutral", "negative"}

var allowedContentTypes = []string{"news_fact", "opinion", "analysis", "mixed"}

func isAllowedSentiment(value string) bool {
	for _, allowed := range allowedSentiments {
		if value == allowed {
			return true
		}
	}
	return false
}

func isAllowedContentType(value string) bool {
	for _, allowed := range allowedContentTypes {
		if value == allowed {
			return true
		}
	}
	return false
}

// Facets ports ItemsSearchService.getFacets. A null candidate set means "no
// restriction"; an empty one means "no results".
func (s *Service) Facets(
	ctx context.Context,
	orgID string,
	search string,
	filters *ItemFilters,
) (ItemFacets, error) {
	parsed := ParseSearchPayload(search)
	effectiveFilters := filters
	if effectiveFilters == nil {
		effectiveFilters = parsed.Filters
	}
	scopedIDs, restricted, err := s.search.ResolveScopedIDs(ctx, orgID, parsed.Search, effectiveFilters)
	if err != nil {
		return ItemFacets{}, err
	}
	if restricted && len(scopedIDs) == 0 {
		return emptyFacets(), nil
	}
	var candidates []string
	if restricted {
		candidates = scopedIDs
	}

	regionCounts := make(map[string]int)
	topicCounts := make(map[string]int)
	sentimentCounts := make(map[string]int)
	contentTypeCounts := make(map[string]int)

	if s.readModelEnabled {
		rows, err := s.mongo.FacetReadModelFields(ctx, orgID, candidates)
		if err != nil {
			return ItemFacets{}, err
		}
		for _, row := range rows {
			regionValue := nonEmptyString(row.Location)
			if regionValue == "" {
				regionValue = nonEmptyString(row.Region)
			}
			if regionValue != "" {
				incrementFacetCount(regionCounts, regionValue)
			}
			topicSet := make(map[string]struct{}, len(row.Topics)+len(row.Entities)+len(row.Tags))
			for _, values := range [][]string{row.Topics, row.Entities, row.Tags} {
				for _, value := range values {
					trimmed := strings.TrimSpace(value)
					if trimmed != "" {
						topicSet[trimmed] = struct{}{}
					}
				}
			}
			for topic := range topicSet {
				incrementFacetCount(topicCounts, topic)
			}
			sentiment := strings.ToLower(nonEmptyString(row.Sentiment))
			if isAllowedSentiment(sentiment) {
				incrementFacetCount(sentimentCounts, sentiment)
			}
			contentType := strings.ToLower(nonEmptyString(row.ContentType))
			if isAllowedContentType(contentType) {
				incrementFacetCount(contentTypeCounts, contentType)
			}
		}
	} else {
		snapshots, err := s.mongo.ListLatestProcessedSnapshots(ctx, orgID, candidates)
		if err != nil {
			return ItemFacets{}, err
		}
		for _, snapshot := range snapshots {
			projection, _ := decodeResultRecord(snapshot.Result)
			regionValue := pickResultString(projection, []string{"location", "region"})
			if regionValue != "" {
				incrementFacetCount(regionCounts, regionValue)
			}
			topicSet := make(map[string]struct{}, 8)
			for _, topic := range entityNamesFromJSON(projection.Topics.Bytes()) {
				topicSet[topic] = struct{}{}
			}
			for _, entity := range entityNamesFromJSON(projection.Entities.Bytes()) {
				topicSet[entity] = struct{}{}
			}
			for _, tag := range snapshot.Tags {
				if trimmed := strings.TrimSpace(tag); trimmed != "" {
					topicSet[trimmed] = struct{}{}
				}
			}
			for topic := range topicSet {
				incrementFacetCount(topicCounts, topic)
			}
			sentimentSet := make(map[string]struct{}, 2)
			if value := strings.ToLower(nonEmptyString(projection.Sentiment)); value != "" {
				sentimentSet[value] = struct{}{}
			}
			if value := strings.ToLower(nonEmptyString(projection.SentimentLabel)); value != "" {
				sentimentSet[value] = struct{}{}
			}
			for _, tag := range snapshot.Tags {
				normalized := strings.ToLower(strings.TrimSpace(tag))
				if isAllowedSentiment(normalized) {
					sentimentSet[normalized] = struct{}{}
				}
			}
			for sentiment := range sentimentSet {
				if isAllowedSentiment(sentiment) {
					incrementFacetCount(sentimentCounts, sentiment)
				}
			}
			contentTypeRaw := nonEmptyString(projection.ContentType)
			if contentTypeRaw == "" {
				contentTypeRaw = nonEmptyString(projection.ContentTypeCamel)
			}
			contentType := strings.ToLower(contentTypeRaw)
			if contentType != "" && isAllowedContentType(contentType) {
				incrementFacetCount(contentTypeCounts, contentType)
			}
		}
	}

	return ItemFacets{
		Regions:      buildFacetOptions(regionCounts),
		Topics:       buildFacetOptions(topicCounts),
		Sentiments:   buildFacetOptions(sentimentCounts),
		ContentTypes: buildFacetOptions(contentTypeCounts),
	}, nil
}

// emptyFacets returns the four empty groups with non-nil slices.
func emptyFacets() ItemFacets {
	return ItemFacets{
		Regions:      []FacetOption{},
		Topics:       []FacetOption{},
		Sentiments:   []FacetOption{},
		ContentTypes: []FacetOption{},
	}
}
