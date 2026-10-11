package newsevents

import "time"

// GraphQL object fields use the SDL names. Pointers are nullable.
// A nil slice pointer is GraphQL null; a non-nil empty slice is [].

type NewsEventSourceEvidenceModel struct {
	UniqueSourceCount        int  `graphql:"uniqueSourceCount"`
	AuthoritativeSourceCount int  `graphql:"authoritativeSourceCount"`
	BlogSourceCount          int  `graphql:"blogSourceCount"`
	Corroborated             bool `graphql:"corroborated"`
}

type NewsEventArticleModel struct {
	ID          string    `graphql:"id"`
	URL         string    `graphql:"url"`
	SourceLabel *string   `graphql:"sourceLabel"`
	CrawlAt     time.Time `graphql:"crawlAt"`
}

type NewsEventProcessedArticleModel struct {
	ID          string                `graphql:"id"`
	ArticleID   string                `graphql:"articleId"`
	Title       *string               `graphql:"title"`
	Summary     *string               `graphql:"summary"`
	PublishedAt *time.Time            `graphql:"publishedAt"`
	Language    *string               `graphql:"language"`
	ProcessedAt time.Time             `graphql:"processedAt"`
	Article     NewsEventArticleModel `graphql:"article"`
}

type NewsEventItemModel struct {
	ID                 string                         `graphql:"id"`
	EventID            string                         `graphql:"eventId"`
	ProcessedArticleID string                         `graphql:"processedArticleId"`
	ItemMetaID         *string                        `graphql:"itemMetaId"`
	ProcessedItemID    *string                        `graphql:"processedItemId"`
	Similarity         *float64                       `graphql:"similarity"`
	AssignedBy         string                         `graphql:"assignedBy"`
	CreatedAt          time.Time                      `graphql:"createdAt"`
	ProcessedArticle   NewsEventProcessedArticleModel `graphql:"processedArticle"`
}

type NewsEventTimelineEntryModel struct {
	ID                   string    `graphql:"id"`
	EventID              string    `graphql:"eventId"`
	BucketStart          time.Time `graphql:"bucketStart"`
	Title                *string   `graphql:"title"`
	Summary              *string   `graphql:"summary"`
	KeyPoints            any       `graphql:"keyPoints"`
	ReferencedArticleIDs any       `graphql:"referencedArticleIds"`
	CategoryPath         *string   `graphql:"categoryPath"`
	CategoryConfidence   *float64  `graphql:"categoryConfidence"`
	Tentative            *bool     `graphql:"tentative"`
	Anchor               *bool     `graphql:"anchor"`
	CreatedAt            time.Time `graphql:"createdAt"`
	UpdatedAt            time.Time `graphql:"updatedAt"`
}

type NewsEventModel struct {
	ID                               string                         `graphql:"id"`
	Status                           string                         `graphql:"status"`
	Language                         *string                        `graphql:"language"`
	PrimaryTopic                     *string                        `graphql:"primaryTopic"`
	PrimaryEntity                    *string                        `graphql:"primaryEntity"`
	Title                            *string                        `graphql:"title"`
	Summary                          *string                        `graphql:"summary"`
	StartAt                          time.Time                      `graphql:"startAt"`
	LastAt                           time.Time                      `graphql:"lastAt"`
	ItemCount                        int                            `graphql:"itemCount"`
	RepresentativeProcessedArticleID *string                        `graphql:"representativeProcessedArticleId"`
	RepresentativeProcessedItemID    *string                        `graphql:"representativeProcessedItemId"`
	Metadata                         any                            `graphql:"metadata"`
	CategoryDistribution             any                            `graphql:"categoryDistribution"`
	TopicDriftWarning                *bool                          `graphql:"topicDriftWarning"`
	TopicDriftSummary                *string                        `graphql:"topicDriftSummary"`
	TimelinePhases                   any                            `graphql:"timelinePhases"`
	SubEvents                        any                            `graphql:"subEvents"`
	CreatedAt                        time.Time                      `graphql:"createdAt"`
	UpdatedAt                        time.Time                      `graphql:"updatedAt"`
	Items                            *[]NewsEventItemModel          `graphql:"items"`
	Timeline                         *[]NewsEventTimelineEntryModel `graphql:"timeline"`
	Breaking                         bool                           `graphql:"breaking"`
	HeatScore                        float64                        `graphql:"heatScore"`
	CredibilityScore                 float64                        `graphql:"credibilityScore"`
	SourceType                       string                         `graphql:"sourceType"`
	SourceEvidence                   NewsEventSourceEvidenceModel   `graphql:"sourceEvidence"`
}

type NewsEventReferencedArticleModel struct {
	ID                 string     `graphql:"id"`
	URL                string     `graphql:"url"`
	SourceLabel        *string    `graphql:"sourceLabel"`
	Title              *string    `graphql:"title"`
	CrawlAt            time.Time  `graphql:"crawlAt"`
	PublishedAt        *time.Time `graphql:"publishedAt"`
	ProcessedAt        time.Time  `graphql:"processedAt"`
	ProcessedArticleID string     `graphql:"processedArticleId"`
}

type NewsEventBriefPointModel struct {
	Text      string `graphql:"text"`
	Citations []int  `graphql:"citations"`
}

type NewsEventBriefComparisonModel struct {
	Consensus  []NewsEventBriefPointModel `graphql:"consensus"`
	Divergence []NewsEventBriefPointModel `graphql:"divergence"`
}

type NewsEventBriefSourceModel struct {
	Index              int        `graphql:"index"`
	URL                string     `graphql:"url"`
	SourceLabel        *string    `graphql:"sourceLabel"`
	Title              *string    `graphql:"title"`
	PublishedAt        *time.Time `graphql:"publishedAt"`
	ProcessedItemID    *string    `graphql:"processedItemId"`
	ProcessedArticleID *string    `graphql:"processedArticleId"`
}

type NewsEventBriefModel struct {
	Version         int                            `graphql:"version"`
	GeneratedAt     time.Time                      `graphql:"generatedAt"`
	Language        string                         `graphql:"language"`
	DetailedSummary string                         `graphql:"detailedSummary"`
	Tldr            string                         `graphql:"tldr"`
	KeyPoints       []NewsEventBriefPointModel     `graphql:"keyPoints"`
	WhyItMatters    []NewsEventBriefPointModel     `graphql:"whyItMatters"`
	LatestUpdate    *NewsEventBriefPointModel      `graphql:"latestUpdate"`
	WhatToWatch     []NewsEventBriefPointModel     `graphql:"whatToWatch"`
	Comparison      *NewsEventBriefComparisonModel `graphql:"comparison"`
	Limitations     *string                        `graphql:"limitations"`
	Sources         []NewsEventBriefSourceModel    `graphql:"sources"`
}

type TopicItemModel struct {
	ID          string    `graphql:"id"`
	ItemMetaID  string    `graphql:"itemMetaId"`
	Title       *string   `graphql:"title"`
	Summary     *string   `graphql:"summary"`
	Source      *string   `graphql:"source"`
	PublishedAt *string   `graphql:"publishedAt"`
	CreatedAt   time.Time `graphql:"createdAt"`
}

type TopicGroupModel struct {
	Topic    string           `graphql:"topic"`
	Count    int              `graphql:"count"`
	LatestAt time.Time        `graphql:"latestAt"`
	Items    []TopicItemModel `graphql:"items"`
}

type EventGroupItemModel struct {
	ID          string    `graphql:"id"`
	ItemMetaID  string    `graphql:"itemMetaId"`
	Title       *string   `graphql:"title"`
	Summary     *string   `graphql:"summary"`
	Source      *string   `graphql:"source"`
	PublishedAt *string   `graphql:"publishedAt"`
	CreatedAt   time.Time `graphql:"createdAt"`
}

type EventGroupModel struct {
	EventID     string                `graphql:"eventId"`
	Count       int                   `graphql:"count"`
	LatestAt    time.Time             `graphql:"latestAt"`
	Title       *string               `graphql:"title"`
	Summary     *string               `graphql:"summary"`
	Source      *string               `graphql:"source"`
	PublishedAt *string               `graphql:"publishedAt"`
	Topics      []string              `graphql:"topics"`
	Entities    []string              `graphql:"entities"`
	Items       []EventGroupItemModel `graphql:"items"`
}
