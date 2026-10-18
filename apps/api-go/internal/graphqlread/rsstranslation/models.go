// Package rsstranslation registers the translateRssItems mutation on the Go
// GraphQL executor. It decodes the strongly typed input, calls the RSS
// translation service, and projects the named payload models. It reuses the
// shared SDL and the existing executor engine; it does not modify either.
package rsstranslation

// TranslateRssItemsPayloadModel is the GraphQL TranslateRssItemsPayloadModel.
type TranslateRssItemsPayloadModel struct {
	Provider       string                    `graphql:"provider"`
	TargetLanguage string                    `graphql:"targetLanguage"`
	Translations   []RssItemTranslationModel `graphql:"translations"`
}

// RssItemTranslationModel is the GraphQL RssItemTranslationModel. A nil field
// is projected as GraphQL null: a field that was not requested or whose source
// value is absent is never replaced with an empty string or an empty list.
type RssItemTranslationModel struct {
	ItemID          string    `graphql:"itemId"`
	Title           *string   `graphql:"title"`
	Summary         *string   `graphql:"summary"`
	KeyPoints       *[]string `graphql:"keyPoints"`
	CleanedMarkdown *string   `graphql:"cleanedMarkdown"`
}
