// Package itemsreading serves the five item reading and RSS search-assist
// GraphQL read roots that belong to the items-reading migration unit: item,
// itemFacets, rssSources, rssTranslationStatus and searchSuggestions.
//
// The roots are registered only when both API_GO_GRAPHQL_READ_MODE and
// API_GO_ITEMS_READING_MODE are go; while either switch is legacy, every
// document selecting one of them stays on NestJS. The GraphQL `items` root,
// the createItem/updateItem/translateRssItems mutations and the RSS
// subscription are not migrated.
//
// The nested types ProcessedItemErrorModelGraph, ProcessedItemLlmModel and
// ProcessedItemModelGraph are the workspace package's exported models, reused so
// the two packages cannot drift apart. They are re-registered here only when the
// workspace sub-switch is off, because the registry maps a type name to exactly
// one projection struct.
package itemsreading

import (
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	itemsdomain "github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// ItemMetaModel is the GraphQL ItemMetaModel object.
type ItemMetaModel struct {
	CreatedAt  time.Time `graphql:"createdAt"`
	ExternalID string    `graphql:"externalId"`
	ID         string    `graphql:"id"`
	MongoRef   string    `graphql:"mongoRef"`
	Name       string    `graphql:"name"`
	Status     string    `graphql:"status"`
	UpdatedAt  time.Time `graphql:"updatedAt"`
}

// SeriesPointModel is the GraphQL SeriesPointModel object.
type SeriesPointModel struct {
	Timestamp string  `graphql:"timestamp"`
	Value     float64 `graphql:"value"`
}

// ItemSearchHighlightModel is the GraphQL ItemSearchHighlightModel object.
type ItemSearchHighlightModel struct {
	Field    string   `graphql:"field"`
	Snippets []string `graphql:"snippets"`
}

// RawItemModelGraph is the GraphQL RawItemModelGraph object. payload is the raw
// payload JSON string.
type RawItemModelGraph struct {
	CreatedAt  time.Time `graphql:"createdAt"`
	ID         string    `graphql:"id"`
	ItemMetaID string    `graphql:"itemMetaId"`
	Payload    string    `graphql:"payload"`
	Source     *string   `graphql:"source"`
	UpdatedAt  time.Time `graphql:"updatedAt"`
}

// RawItemPreviewModelGraph is the GraphQL RawItemPreviewModelGraph object.
type RawItemPreviewModelGraph struct {
	ChangePercent *float64           `graphql:"changePercent"`
	History       []SeriesPointModel `graphql:"history"`
	Location      *string            `graphql:"location"`
	Price         *float64           `graphql:"price"`
	Region        *string            `graphql:"region"`
	Sentiment     *string            `graphql:"sentiment"`
	SourceName    *string            `graphql:"sourceName"`
	Summary       *string            `graphql:"summary"`
	Thumbnail     *string            `graphql:"thumbnail"`
	Ticker        *string            `graphql:"ticker"`
	URL           *string            `graphql:"url"`
}

// ProcessedItemPreviewModelGraph is the GraphQL ProcessedItemPreviewModelGraph
// object. eventId and duplicateOf are resolved eagerly by the item resolver
// because the executor projects struct fields instead of calling field
// resolvers.
type ProcessedItemPreviewModelGraph struct {
	ContentType         *string                          `graphql:"contentType"`
	CreatedAt           time.Time                        `graphql:"createdAt"`
	DuplicateOf         *string                          `graphql:"duplicateOf"`
	DuplicateSimilarity *float64                         `graphql:"duplicateSimilarity"`
	Entities            []string                         `graphql:"entities"`
	EventID             *string                          `graphql:"eventId"`
	ID                  string                           `graphql:"id"`
	ItemMetaID          string                           `graphql:"itemMetaId"`
	Language            *string                          `graphql:"language"`
	Llm                 *workspace.ProcessedItemLlmModel `graphql:"llm"`
	Location            *string                          `graphql:"location"`
	PublishedAt         *string                          `graphql:"publishedAt"`
	QualityScore        *float64                         `graphql:"qualityScore"`
	Sentiment           *string                          `graphql:"sentiment"`
	Source              *string                          `graphql:"source"`
	Status              string                           `graphql:"status"`
	Summary             *string                          `graphql:"summary"`
	Tags                []string                         `graphql:"tags"`
	Title               *string                          `graphql:"title"`
	Topics              []string                         `graphql:"topics"`
}

// ItemModel is the GraphQL ItemModel object. meta is non-null in the SDL, so a
// resolution failure nulls the whole item, exactly like the NestJS field
// resolver throwing a BadRequestException.
type ItemModel struct {
	CreatedAt        time.Time                          `graphql:"createdAt"`
	ID               string                             `graphql:"id"`
	IngestedAt       time.Time                          `graphql:"ingestedAt"`
	Meta             ItemMetaModel                      `graphql:"meta"`
	OrgID            string                             `graphql:"orgId"`
	Processed        *workspace.ProcessedItemModelGraph `graphql:"processed"`
	ProcessedPreview *ProcessedItemPreviewModelGraph    `graphql:"processedPreview"`
	PublishedAt      *string                            `graphql:"publishedAt"`
	Raw              *RawItemModelGraph                 `graphql:"raw"`
	RawPreview       *RawItemPreviewModelGraph          `graphql:"rawPreview"`
	RelevanceScore   *float64                           `graphql:"relevanceScore"`
	SearchHighlights []ItemSearchHighlightModel         `graphql:"searchHighlights"`
	Status           string                             `graphql:"status"`
	Title            string                             `graphql:"title"`
	UpdatedAt        time.Time                          `graphql:"updatedAt"`
}

// ItemFacetOption is the GraphQL ItemFacetOption object.
type ItemFacetOption struct {
	Count int    `graphql:"count"`
	Value string `graphql:"value"`
}

// ItemFacetsModel is the GraphQL ItemFacets object.
type ItemFacetsModel struct {
	ContentTypes []ItemFacetOption `graphql:"contentTypes"`
	Regions      []ItemFacetOption `graphql:"regions"`
	Sentiments   []ItemFacetOption `graphql:"sentiments"`
	Topics       []ItemFacetOption `graphql:"topics"`
}

// RssSourceOptionModel is the GraphQL RssSourceOptionModel object.
type RssSourceOptionModel struct {
	FeedURL         string  `graphql:"feedUrl"`
	ID              string  `graphql:"id"`
	ItemCountWindow int     `graphql:"itemCountWindow"`
	Language        *string `graphql:"language"`
	LatestItemAt    *string `graphql:"latestItemAt"`
	Name            string  `graphql:"name"`
	SiteURL         string  `graphql:"siteUrl"`
}

// RssTranslationProviderStatusModel is the GraphQL
// RssTranslationProviderStatusModel object.
type RssTranslationProviderStatusModel struct {
	Available               bool                               `graphql:"available"`
	Message                 *string                            `graphql:"message"`
	Provider                itemsdomain.RssTranslationProvider `graphql:"provider"`
	TargetLanguageSupported bool                               `graphql:"targetLanguageSupported"`
}

// SearchSuggestionModel is the GraphQL SearchSuggestionModel object.
type SearchSuggestionModel struct {
	Origin itemsdomain.SuggestionOrigin `graphql:"origin"`
	Type   itemsdomain.SuggestionType   `graphql:"type"`
	Value  string                       `graphql:"value"`
}
