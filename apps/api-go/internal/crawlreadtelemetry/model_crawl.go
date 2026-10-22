package crawlreadtelemetry

import "encoding/json"

// CrawlTaskStatus is the Prisma CrawlTaskStatus enum as a named string type.
type CrawlTaskStatus string

const (
	CrawlTaskStatusPending   CrawlTaskStatus = "pending"
	CrawlTaskStatusQueued    CrawlTaskStatus = "queued"
	CrawlTaskStatusRunning   CrawlTaskStatus = "running"
	CrawlTaskStatusCompleted CrawlTaskStatus = "completed"
	CrawlTaskStatusFailed    CrawlTaskStatus = "failed"
	CrawlTaskStatusPaused    CrawlTaskStatus = "paused"
)

// isCrawlTaskStatus reports whether value is one of the six Prisma statuses.
func isCrawlTaskStatus(value string) bool {
	switch CrawlTaskStatus(value) {
	case CrawlTaskStatusPending, CrawlTaskStatusQueued, CrawlTaskStatusRunning,
		CrawlTaskStatusCompleted, CrawlTaskStatusFailed, CrawlTaskStatusPaused:
		return true
	default:
		return false
	}
}

// CrawlMediaAccessMode is the :mode path segment of the media delivery route.
type CrawlMediaAccessMode string

const (
	// CrawlMediaAccessModePreview serves an inline preview when the content
	// type is on the inline allow list.
	CrawlMediaAccessModePreview CrawlMediaAccessMode = "preview"
	// CrawlMediaAccessModeDownload always serves an attachment.
	CrawlMediaAccessModeDownload CrawlMediaAccessMode = "download"
)

// CrawlImageStorageProvider is the Prisma CrawlImageStorageProvider enum.
type CrawlImageStorageProvider string

const (
	CrawlImageStorageProviderMySQL CrawlImageStorageProvider = "mysql"
	CrawlImageStorageProviderS3    CrawlImageStorageProvider = "s3"
)

// CrawlMemoryStats is the memory block written by the crawler into the
// "complete" task log. Fields are optional and omitted when absent, matching
// the NestJS CrawlMemoryStats interface.
type CrawlMemoryStats struct {
	ServerMemoryMb    *float64 `json:"serverMemoryMb,omitempty" bson:"serverMemoryMb"`
	PeakMemoryMb      *float64 `json:"peakMemoryMb,omitempty" bson:"peakMemoryMb"`
	EfficiencyPercent *float64 `json:"efficiencyPercent,omitempty" bson:"efficiencyPercent"`
}

// CrawlExecutionSummary is the last-run summary derived from the latest
// "complete" task log. Only the fields toLatestExecutionSummary emits are
// modelled; every optional field is omitted when unset, matching
// JSON.stringify dropping undefined keys.
type CrawlExecutionSummary struct {
	Inserted          int     `json:"inserted" bson:"inserted"`
	Skipped           int     `json:"skipped" bson:"skipped"`
	ItemsQueued       *int    `json:"itemsQueued,omitempty" bson:"itemsQueued"`
	ItemsQueueFailed  *int    `json:"itemsQueueFailed,omitempty" bson:"itemsQueueFailed"`
	LastFetchedAt     *JSTime `json:"lastFetchedAt,omitempty" bson:"lastFetchedAt"`
	RunID             *string `json:"runId,omitempty" bson:"runId"`
	ReusedResultID    *string `json:"reusedResultId,omitempty" bson:"reusedResultId"`
	RetryableFailures *int    `json:"retryableFailures,omitempty" bson:"retryableFailures"`
}

// CrawlTaskView is the toView projection of a CrawlTask row. The declaration
// order is the NestJS object literal order, which fixes the JSON key order.
type CrawlTaskView struct {
	ID                   string                 `json:"id"`
	TargetURL            string                 `json:"targetUrl"`
	DisplayName          *string                `json:"displayName"`
	Status               CrawlTaskStatus        `json:"status"`
	Keywords             []string               `json:"keywords"`
	Concurrency          int                    `json:"concurrency"`
	TimeRangeFrom        *JSTime                `json:"timeRangeFrom"`
	TimeRangeTo          *JSTime                `json:"timeRangeTo"`
	LastRunAt            *JSTime                `json:"lastRunAt"`
	LastSuccessAt        *JSTime                `json:"lastSuccessAt"`
	LastResultAt         *JSTime                `json:"lastResultAt"`
	LastCursor           *string                `json:"lastCursor"`
	LastError            *string                `json:"lastError"`
	RunCount             int                    `json:"runCount"`
	CreatedAt            JSTime                 `json:"createdAt"`
	UpdatedAt            JSTime                 `json:"updatedAt"`
	ResultCount          int                    `json:"resultCount"`
	Config               RawJSON                `json:"config"`
	MemoryStats          *CrawlMemoryStats      `json:"memoryStats,omitempty"`
	LastRunSummary       *CrawlExecutionSummary `json:"lastRunSummary,omitempty"`
	LastServerMemoryMb   *float64               `json:"lastServerMemoryMb"`
	LastPeakMemoryMb     *float64               `json:"lastPeakMemoryMb"`
	LastMemoryEfficiency *float64               `json:"lastMemoryEfficiency"`
}

// CrawlTaskListResponse is the GET /api/crawl-tasks payload.
type CrawlTaskListResponse struct {
	Tasks    []CrawlTaskView `json:"tasks"`
	Total    int             `json:"total"`
	Page     int             `json:"page"`
	PageSize int             `json:"pageSize"`
}

// crawlTaskDetailTask is the detail task: the toView projection followed by the
// hydrated results. Embedding reproduces the NestJS spread-then-append order.
//
// The JSON shape cannot reuse CrawlTaskView as is: toView reserves the
// memoryStats and lastRunSummary keys and leaves them undefined, so the list
// projection omits them, while getTask spreads the same keys and then assigns
// the values it read from the latest "complete" task log. A task without such a
// log therefore serializes "memoryStats": null and "lastRunSummary": null in the
// detail response. MarshalJSON reproduces exactly that: the two keys are always
// present (null when absent) and the hydrated results stay last.
type crawlTaskDetailTask struct {
	CrawlTaskView
	Results []CrawlTaskResult `json:"results"`
}

// MarshalJSON renders the detail task with the two always-present run keys.
func (t crawlTaskDetailTask) MarshalJSON() ([]byte, error) {
	// The outer fields shadow the embedded view's memoryStats / lastRunSummary
	// (a shallower field wins in encoding/json), which lets the two keys drop
	// their omitempty for this projection only.
	type detailJSON struct {
		CrawlTaskView
		MemoryStats    *CrawlMemoryStats      `json:"memoryStats"`
		LastRunSummary *CrawlExecutionSummary `json:"lastRunSummary"`
		Results        []CrawlTaskResult      `json:"results"`
	}
	return json.Marshal(detailJSON{
		CrawlTaskView:  t.CrawlTaskView,
		MemoryStats:    t.CrawlTaskView.MemoryStats,
		LastRunSummary: t.CrawlTaskView.LastRunSummary,
		Results:        t.Results,
	})
}

// CrawlTaskDetailResponse is the GET /api/crawl-tasks/:id payload.
type CrawlTaskDetailResponse struct {
	Task crawlTaskDetailTask `json:"task"`
}

// CrawlMediaSource mirrors the CrawlMediaSource interface (responsive sources).
type CrawlMediaSource struct {
	Src    *string `json:"src,omitempty" bson:"src"`
	Srcset *string `json:"srcset,omitempty" bson:"srcset"`
	Type   *string `json:"type,omitempty" bson:"type"`
	Media  *string `json:"media,omitempty" bson:"media"`
	Sizes  *string `json:"sizes,omitempty" bson:"sizes"`
}

// CrawlMediaItem mirrors the normalized CrawlMediaItem stored in Mongo Mixed
// media buckets.
type CrawlMediaItem struct {
	Src               *string            `json:"src,omitempty" bson:"src"`
	Alt               *string            `json:"alt,omitempty" bson:"alt"`
	Title             *string            `json:"title,omitempty" bson:"title"`
	Desc              *string            `json:"desc,omitempty" bson:"desc"`
	Type              *string            `json:"type,omitempty" bson:"type"`
	Format            *string            `json:"format,omitempty" bson:"format"`
	Width             *int               `json:"width,omitempty" bson:"width"`
	Height            *int               `json:"height,omitempty" bson:"height"`
	Score             *float64           `json:"score,omitempty" bson:"score"`
	Poster            *string            `json:"poster,omitempty" bson:"poster"`
	Sizes             *string            `json:"sizes,omitempty" bson:"sizes"`
	Srcset            []string           `json:"srcset,omitempty" bson:"srcset"`
	PictureSources    []CrawlMediaSource `json:"pictureSources,omitempty" bson:"pictureSources"`
	ResponsiveSources []CrawlMediaSource `json:"responsiveSources,omitempty" bson:"responsiveSources"`
	Raw               RawJSON            `json:"raw,omitempty" bson:"raw"`
}

// CrawlMediaCollection groups Crawl4AI media items by their bucket name. The
// bucket keys are defined by Crawl4AI (for example "images" or "videos"), so
// the collection is a named map whose value type stays strongly typed.
type CrawlMediaCollection map[string][]CrawlMediaItem

// CrawlLinkAnalysisLink mirrors one analysed link.
type CrawlLinkAnalysisLink struct {
	Href            string   `json:"href" bson:"href"`
	Text            *string  `json:"text,omitempty" bson:"text"`
	Title           *string  `json:"title,omitempty" bson:"title"`
	BaseDomain      *string  `json:"baseDomain,omitempty" bson:"baseDomain"`
	Rel             *string  `json:"rel,omitempty" bson:"rel"`
	Type            *string  `json:"type,omitempty" bson:"type"`
	IntrinsicScore  *float64 `json:"intrinsicScore,omitempty" bson:"intrinsicScore"`
	ContextualScore *float64 `json:"contextualScore,omitempty" bson:"contextualScore"`
	TotalScore      *float64 `json:"totalScore,omitempty" bson:"totalScore"`
}

// CrawlLinkAnalysisStats mirrors the CrawlLinkAnalysisStats interface.
type CrawlLinkAnalysisStats struct {
	TotalLinks            int      `json:"totalLinks" bson:"totalLinks"`
	InternalLinks         int      `json:"internalLinks" bson:"internalLinks"`
	ExternalLinks         int      `json:"externalLinks" bson:"externalLinks"`
	AverageIntrinsicScore *float64 `json:"averageIntrinsicScore,omitempty" bson:"averageIntrinsicScore"`
	HighQualityLinks      *int     `json:"highQualityLinks,omitempty" bson:"highQualityLinks"`
	LowQualityLinks       *int     `json:"lowQualityLinks,omitempty" bson:"lowQualityLinks"`
}

// CrawlLinkAnalysisBucket mirrors one link analysis bucket.
type CrawlLinkAnalysisBucket struct {
	Kind  string                  `json:"kind" bson:"kind"`
	Links []CrawlLinkAnalysisLink `json:"links" bson:"links"`
}

// CrawlLinkAnalysis mirrors the CrawlLinkAnalysis interface stored in Mongo.
type CrawlLinkAnalysis struct {
	Stats           CrawlLinkAnalysisStats    `json:"stats" bson:"stats"`
	Buckets         []CrawlLinkAnalysisBucket `json:"buckets" bson:"buckets"`
	TopLinks        []CrawlLinkAnalysisLink   `json:"topLinks" bson:"topLinks"`
	LowQualityLinks []CrawlLinkAnalysisLink   `json:"lowQualityLinks" bson:"lowQualityLinks"`
}

// CrawlTableCell is one schema-less table cell (string, number, boolean or
// null). The raw JSON value is preserved verbatim.
type CrawlTableCell RawJSON

// MarshalJSON renders the stored cell value.
func (c CrawlTableCell) MarshalJSON() ([]byte, error) {
	return RawJSON(c).MarshalJSON()
}

// UnmarshalBSONValue decodes a BSON cell into its relaxed JSON form.
func (c *CrawlTableCell) UnmarshalBSONValue(valueType byte, data []byte) error {
	var raw RawJSON
	if err := raw.UnmarshalBSONValue(valueType, data); err != nil {
		return err
	}
	*c = CrawlTableCell(raw)
	return nil
}

// CrawlResultTableRecord is one data-frame row keyed by column name.
type CrawlResultTableRecord map[string]CrawlTableCell

// CrawlResultTableDataFrame is the tabular view of a crawled table.
type CrawlResultTableDataFrame struct {
	Columns []string                 `json:"columns" bson:"columns"`
	Rows    []CrawlResultTableRecord `json:"rows" bson:"rows"`
}

// CrawlResultTable mirrors the CrawlResultTable interface stored in Mongo.
type CrawlResultTable struct {
	ID          string                    `json:"id" bson:"id"`
	Caption     *string                   `json:"caption,omitempty" bson:"caption"`
	Headers     []string                  `json:"headers" bson:"headers"`
	Rows        [][]CrawlTableCell        `json:"rows" bson:"rows"`
	RowCount    int                       `json:"rowCount" bson:"rowCount"`
	ColumnCount int                       `json:"columnCount" bson:"columnCount"`
	Source      *string                   `json:"source,omitempty" bson:"source"`
	Metadata    RawJSON                   `json:"metadata,omitempty" bson:"metadata"`
	DataFrame   CrawlResultTableDataFrame `json:"dataFrame" bson:"dataFrame"`
}

// CrawlStoredMediaAsset is one signed media asset attached to a crawl result.
// Optional fields are omitted when unset, matching JSON.stringify dropping
// undefined keys in toCrawlStoredAsset.
type CrawlStoredMediaAsset struct {
	ID              string                    `json:"id"`
	Kind            string                    `json:"kind"`
	SourceURL       string                    `json:"sourceUrl"`
	Bytes           int                       `json:"bytes"`
	ContentType     string                    `json:"contentType"`
	StorageProvider CrawlImageStorageProvider `json:"storageProvider"`
	StorageKey      *string                   `json:"storageKey,omitempty"`
	PreviewURL      *string                   `json:"previewUrl,omitempty"`
	DownloadURL     *string                   `json:"downloadUrl,omitempty"`
	Width           *int                      `json:"width,omitempty"`
	Height          *int                      `json:"height,omitempty"`
	Alt             *string                   `json:"alt,omitempty"`
	Title           *string                   `json:"title,omitempty"`
	Desc            *string                   `json:"desc,omitempty"`
	Poster          *string                   `json:"poster,omitempty"`
	Format          *string                   `json:"format,omitempty"`
	Metadata        RawJSON                   `json:"metadata,omitempty"`
}

// CrawlTaskResult is the hydrated crawl result returned by the detail
// endpoint. Declaration order matches attachResultContent.
type CrawlTaskResult struct {
	ID                    string                  `json:"id"`
	SourceURL             string                  `json:"sourceUrl"`
	FetchedAt             JSTime                  `json:"fetchedAt"`
	Markdown              string                  `json:"markdown"`
	Metadata              RawJSON                 `json:"metadata"`
	MarkdownWithCitations *string                 `json:"markdownWithCitations,omitempty"`
	ReferencesMarkdown    *string                 `json:"referencesMarkdown,omitempty"`
	FitMarkdown           *string                 `json:"fitMarkdown,omitempty"`
	LinkAnalysis          *CrawlLinkAnalysis      `json:"linkAnalysis"`
	Media                 CrawlMediaCollection    `json:"media"`
	MediaAssets           []CrawlStoredMediaAsset `json:"mediaAssets"`
	Tables                []CrawlResultTable      `json:"tables"`
	ItemID                *string                 `json:"itemId"`
	ItemStatus            *string                 `json:"itemStatus"`
}
