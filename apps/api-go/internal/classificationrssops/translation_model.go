package classificationrssops

// RSS translation metrics bounds translated from rss-translation-metrics.service.ts.
const (
	translationDefaultDays = 14
	translationMaxDays     = 180
	translationDateLayout  = "2006-01-02"
)

// rssTranslationMetricsRow is one RssTranslationMetricsDaily row enriched with
// the derived averages and rates the API returns.
type rssTranslationMetricsRow struct {
	Date             string  `json:"date"`
	Provider         string  `json:"provider"`
	TargetLanguage   string  `json:"targetLanguage"`
	RequestCount     int     `json:"requestCount"`
	ItemCount        int     `json:"itemCount"`
	TextCount        int     `json:"textCount"`
	CacheHitCount    int     `json:"cacheHitCount"`
	CacheMissCount   int     `json:"cacheMissCount"`
	TranslatedCount  int     `json:"translatedCount"`
	FailureCount     int     `json:"failureCount"`
	SkipTooLongCount int     `json:"skipTooLongCount"`
	TotalLatencyMs   int     `json:"totalLatencyMs"`
	MaxLatencyMs     int     `json:"maxLatencyMs"`
	AvgLatencyMs     int     `json:"avgLatencyMs"`
	CacheHitRate     float64 `json:"cacheHitRate"`
	FailureRate      float64 `json:"failureRate"`
}

// rssTranslationMetricsSummary aggregates every returned row.
type rssTranslationMetricsSummary struct {
	RequestCount     int     `json:"requestCount"`
	ItemCount        int     `json:"itemCount"`
	TextCount        int     `json:"textCount"`
	CacheHitCount    int     `json:"cacheHitCount"`
	CacheMissCount   int     `json:"cacheMissCount"`
	TranslatedCount  int     `json:"translatedCount"`
	FailureCount     int     `json:"failureCount"`
	SkipTooLongCount int     `json:"skipTooLongCount"`
	TotalLatencyMs   int     `json:"totalLatencyMs"`
	MaxLatencyMs     int     `json:"maxLatencyMs"`
	AvgLatencyMs     int     `json:"avgLatencyMs"`
	CacheHitRate     float64 `json:"cacheHitRate"`
	FailureRate      float64 `json:"failureRate"`
}

// rssTranslationMetricsResponse is the GET rss-translation/metrics response.
type rssTranslationMetricsResponse struct {
	From    string                       `json:"from"`
	To      string                       `json:"to"`
	Rows    []rssTranslationMetricsRow   `json:"rows"`
	Summary rssTranslationMetricsSummary `json:"summary"`
}

// rssTranslationMetricsDocument is one raw SELECT row. Numeric columns are read
// through sql.NullInt64 because Prisma returns the declared Int columns, but a
// missing table or NULL never has to crash the reader.
type rssTranslationMetricsDocument struct {
	Date             string
	Provider         string
	TargetLanguage   string
	RequestCount     int
	ItemCount        int
	TextCount        int
	CacheHitCount    int
	CacheMissCount   int
	TranslatedCount  int
	FailureCount     int
	SkipTooLongCount int
	TotalLatencyMs   int
	MaxLatencyMs     int
}
