package itemsingestgraphql

// CrawlIngestBatchModel is the GraphQL CrawlIngestBatchModel object. Every
// counter is a Float in the SDL, and nextCursor is only set when hasMore.
type CrawlIngestBatchModel struct {
	TaskID          string  `graphql:"taskId"`
	Scanned         float64 `graphql:"scanned"`
	Attempted       float64 `graphql:"attempted"`
	Ingested        float64 `graphql:"ingested"`
	SkippedExisting float64 `graphql:"skippedExisting"`
	Failed          float64 `graphql:"failed"`
	NextCursor      *string `graphql:"nextCursor"`
	HasMore         bool    `graphql:"hasMore"`
}
