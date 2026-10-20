package newssourcescheduler

import (
	"encoding/json"
	"math"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
)

// This file ports buildPayload, withAutoCrawlQualityDefaults and the two payload
// builders the dispatch body needs: the CrawlTask.config object for the crawl4ai
// worker and the raw_item payload for the RSS seed path. crawlOptions is still
// extension JSON (a user-authored object), so it is built with the object
// helpers and marshalled once at the end.

// CrawlDefaults are the EnvService defaults withAutoCrawlQualityDefaults reads.
type CrawlDefaults struct {
	AutoExpandDetails       bool
	QualityProfile          string
	DetailMaxURLs           int
	DetailMinRelevanceScore float64
	DetailRequireSameDomain bool
}

// defaultCrawlDefaults is the NestJS fallback set.
func defaultCrawlDefaults() CrawlDefaults {
	return CrawlDefaults{
		AutoExpandDetails:       true,
		QualityProfile:          "quality_first",
		DetailMaxURLs:           12,
		DetailMinRelevanceScore: 0.35,
		DetailRequireSameDomain: true,
	}
}

// seedPayloadInput is the optional seed block of buildPayload.
type seedPayloadInput struct {
	Mode                seedMode
	ParentURL           string
	RelevanceScore      *float64
	PublishedAt         *string
	CrawledAt           *string
	EffectiveAt         *string
	TimestampSource     string
	DedupeWindowHours   int
	QueryParamAllowlist []string
}

// crawlPayload is the NormalizedNewsPayload-shaped payload built by
// buildPayload. CrawlOptions stays nil for RSS seeds (the pipeline consumes the
// prefetched article instead).
type crawlPayload struct {
	URL          string
	Language     *string
	SourceName   *string
	Keywords     []string
	Tags         []string
	SummaryHints []string
	Metadata     jsonObject
	CrawlOptions jsonObject
	ForceRefresh bool
}

// newsSourceSeedPayload is metadata.newsSourceSeed. timestampSource and
// dedupeWindowHours are always present in the NestJS object (never undefined),
// so they are not omitted when they hold their zero value.
type newsSourceSeedPayload struct {
	Mode              string   `json:"mode"`
	ParentURL         string   `json:"parentUrl"`
	RelevanceScore    *float64 `json:"relevanceScore,omitempty"`
	PublishedAt       *string  `json:"publishedAt,omitempty"`
	CrawledAt         *string  `json:"crawledAt,omitempty"`
	EffectiveAt       *string  `json:"effectiveAt,omitempty"`
	TimestampSource   string   `json:"timestampSource"`
	DedupeWindowHours int      `json:"dedupeWindowHours"`
}

// sourceConfigView is the NewsSource.config projection buildPayload reads.
type sourceConfigView struct {
	Keywords     []string
	Tags         []string
	SummaryHints []string
	Metadata     jsonObject
	CrawlOptions jsonObject
	ForceRefresh bool
}

// readSourceConfig is the config object projection of buildPayload.
func readSourceConfig(source *source) sourceConfigView {
	config, ok := decodeObject(source.Config)
	if !ok {
		return sourceConfigView{Keywords: []string{}, Tags: []string{}, SummaryHints: []string{}}
	}
	metadata, _ := config.objectField("metadata")
	crawlOptions, _ := config.objectField("crawlOptions")
	forceRefresh, _ := config.boolField("forceRefresh")
	return sourceConfigView{
		Keywords:     stringListField(config["keywords"]),
		Tags:         stringListField(config["tags"]),
		SummaryHints: stringListField(config["summaryHints"]),
		Metadata:     metadata,
		CrawlOptions: crawlOptions,
		ForceRefresh: forceRefresh,
	}
}

// buildPayload is buildPayload.
func (s *Service) buildPayload(source *source, targetURL string, seed *seedPayloadInput) crawlPayload {
	isRSSSeed := seed != nil && seed.Mode == seedModeRSS
	view := readSourceConfig(source)
	metadata := jsonObject{"sourceId": rawValue(source.ID), "sourceType": rawValue(source.SiteType)}
	if !isRSSSeed {
		if source.CrawlTemplateID != nil {
			metadata["crawlTemplateId"] = rawValue(*source.CrawlTemplateID)
		}
	}
	if seed != nil {
		metadata["newsSourceSeed"] = rawValue(newsSourceSeedPayload{
			Mode:              string(seed.Mode),
			ParentURL:         seed.ParentURL,
			RelevanceScore:    seed.RelevanceScore,
			PublishedAt:       seed.PublishedAt,
			CrawledAt:         seed.CrawledAt,
			EffectiveAt:       seed.EffectiveAt,
			TimestampSource:   seed.TimestampSource,
			DedupeWindowHours: seed.DedupeWindowHours,
		})
		metadata["urlQueryParamAllowlist"] = rawValue(seed.QueryParamAllowlist)
	}
	for key, value := range view.Metadata {
		metadata[key] = value
	}

	payload := crawlPayload{
		URL:          targetURL,
		Language:     source.Language,
		SourceName:   stringPtr(source.Name),
		Keywords:     view.Keywords,
		Tags:         view.Tags,
		SummaryHints: view.SummaryHints,
		Metadata:     metadata,
		ForceRefresh: view.ForceRefresh,
	}
	if isRSSSeed {
		payload.ForceRefresh = false
		return payload
	}
	baseOptions := jsonObject(nil)
	if source.CrawlTemplateActive {
		baseOptions, _ = decodeObject(source.CrawlTemplateOptions)
	}
	payload.CrawlOptions = s.withAutoCrawlQualityDefaults(
		mergeObjects(baseOptions, view.CrawlOptions),
		seedModeValue(seed),
	)
	return payload
}

// seedModeValue returns the buildPayload seed mode, or "" for a single URL.
func seedModeValue(seed *seedPayloadInput) seedMode {
	if seed == nil {
		return ""
	}
	return seed.Mode
}

// withAutoCrawlQualityDefaults is withAutoCrawlQualityDefaults.
func (s *Service) withAutoCrawlQualityDefaults(options jsonObject, mode seedMode) jsonObject {
	current := jsonObject{}
	for key, value := range options {
		current[key] = value
	}

	setBoolDefault(current, "headless", false)
	setBoolDefault(current, "enableUndetectedBrowser", true)
	setBoolDefault(current, "enableStealthMode", true)
	setBoolDefault(current, "simulateUser", true)
	setBoolDefault(current, "overrideNavigator", true)
	setStringDefault(current, "userAgentMode", "random")
	setStringDefault(current, "waitUntil", "networkidle")
	setNumberDefault(current, "waitForTimeoutMs", 12_000)
	setNumberDefault(current, "delayBeforeReturnHtmlMs", 2_000)
	setNumberDefault(current, "meanDelayMs", 900)
	setNumberDefault(current, "maxDelayRangeMs", 1_600)

	markdownOptions, _ := current.objectField("markdownOptions")
	markdownOptions = cloneObject(markdownOptions)
	setStringDefault(markdownOptions, "contentSource", "cleaned_html")
	setBoolDefault(markdownOptions, "citations", true)
	current["markdownOptions"] = rawValue(markdownOptions)

	cleanMarkdown, _ := current.objectField("cleanMarkdown")
	cleanMarkdown = cloneObject(cleanMarkdown)
	setBoolDefault(cleanMarkdown, "removeOverlayElements", true)
	setNumberDefault(cleanMarkdown, "wordCountThreshold", 20)
	excludedTags := []string{}
	if values, ok := cleanMarkdown.arrayField("excludedTags"); ok {
		for _, value := range values {
			var text string
			if err := json.Unmarshal(value, &text); err != nil {
				continue
			}
			trimmed := trimJS(text)
			if trimmed != "" {
				excludedTags = append(excludedTags, trimmed)
			}
		}
	}
	combined := []string{"nav", "footer", "aside", "script", "style", "noscript", "form"}
	seen := map[string]bool{}
	for _, tag := range combined {
		seen[tag] = true
	}
	for _, tag := range excludedTags {
		if seen[tag] {
			continue
		}
		seen[tag] = true
		combined = append(combined, tag)
	}
	if len(combined) > 12 {
		combined = combined[:12]
	}
	cleanMarkdown["excludedTags"] = rawValue(combined)
	delete(cleanMarkdown, "cssSelector")
	current["cleanMarkdown"] = rawValue(cleanMarkdown)

	setStringDefault(current, "pageTypeHint", "auto")
	if _, ok := current.boolField("autoExpandDetails"); !ok {
		current["autoExpandDetails"] = rawValue(s.crawlDefaults.AutoExpandDetails)
	}
	if _, ok := current.stringField("qualityProfile"); !ok {
		current["qualityProfile"] = rawValue(s.crawlDefaults.QualityProfile)
	}

	detailExpansion, _ := current.objectField("detailExpansion")
	detailExpansion = cloneObject(detailExpansion)
	if _, ok := detailExpansion.numberField("maxDetailUrls"); !ok {
		detailExpansion["maxDetailUrls"] = rawValue(s.crawlDefaults.DetailMaxURLs)
	}
	if _, ok := detailExpansion.numberField("minRelevanceScore"); !ok {
		detailExpansion["minRelevanceScore"] = rawValue(s.crawlDefaults.DetailMinRelevanceScore)
	}
	if _, ok := detailExpansion.boolField("requireSameDomain"); !ok {
		detailExpansion["requireSameDomain"] = rawValue(s.crawlDefaults.DetailRequireSameDomain)
	}
	if _, ok := detailExpansion.boolField("allowExternalLinks"); !ok {
		detailExpansion["allowExternalLinks"] = rawValue(true)
	}
	if values, ok := detailExpansion.arrayField("includeUrlPatterns"); ok {
		trimmed := trimStringList(values, 25)
		if len(trimmed) > 0 {
			detailExpansion["includeUrlPatterns"] = rawValue(trimmed)
		} else {
			delete(detailExpansion, "includeUrlPatterns")
		}
	} else {
		delete(detailExpansion, "includeUrlPatterns")
	}
	if values, ok := detailExpansion.arrayField("excludeUrlPatterns"); ok {
		detailExpansion["excludeUrlPatterns"] = rawValue(trimStringList(values, 25))
	} else {
		detailExpansion["excludeUrlPatterns"] = rawValue([]string{
			"/tag/", "/tags/", "/topic/", "/topics/", "/archive/", "/category/",
			"/categories/", "/author/", "/authors/", "/section/", "/sections/", "/latest",
		})
	}
	if value, ok := detailExpansion.numberField("minPublishTimeConfidence"); ok && !math.IsNaN(value) && !math.IsInf(value, 0) {
		clamped := math.Max(0, math.Min(1, roundTo(value, 3)))
		detailExpansion["minPublishTimeConfidence"] = rawValue(clamped)
	} else {
		detailExpansion["minPublishTimeConfidence"] = rawValue(0.55)
	}
	if _, ok := detailExpansion.boolField("preferFitMarkdownForQuality"); !ok {
		detailExpansion["preferFitMarkdownForQuality"] = rawValue(true)
	}
	current["detailExpansion"] = rawValue(detailExpansion)

	if mode == seedModeList || mode == seedModeDeep {
		setBoolDefault(current, "extractLinks", true)
		setBoolDefault(current, "prefetch", true)
		setBoolDefault(current, "scanFullPage", false)
		if _, ok := current.objectField("virtualScroll"); !ok {
			current["virtualScroll"] = rawValue(virtualScrollDefaults{
				ContainerSelector: "body",
				ScrollCount:       8,
				ScrollBy:          "page_height",
				WaitAfterScrollMs: 700,
			})
		}
	}
	return current
}

// virtualScrollDefaults is the list/deep virtualScroll object.
type virtualScrollDefaults struct {
	ContainerSelector string `json:"containerSelector"`
	ScrollCount       int    `json:"scrollCount"`
	ScrollBy          string `json:"scrollBy"`
	WaitAfterScrollMs int    `json:"waitAfterScrollMs"`
}

// cloneObject copies an object so defaults never mutate the source config.
func cloneObject(object jsonObject) jsonObject {
	out := jsonObject{}
	for key, value := range object {
		out[key] = value
	}
	return out
}

func setBoolDefault(object jsonObject, key string, fallback bool) {
	if _, ok := object.boolField(key); ok {
		return
	}
	object[key] = rawValue(fallback)
}

func setStringDefault(object jsonObject, key string, fallback string) {
	if _, ok := object.stringField(key); ok {
		return
	}
	object[key] = rawValue(fallback)
}

func setNumberDefault(object jsonObject, key string, fallback float64) {
	if _, ok := object.numberField(key); ok {
		return
	}
	object[key] = rawValue(fallback)
}

// trimStringList trims and filters a JSON array of strings, capped at limit.
func trimStringList(values []json.RawMessage, limit int) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			continue
		}
		trimmed := trimJS(text)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// crawlTaskConfig is the CrawlTask.config object written for one seed URL.
type crawlTaskConfig struct {
	Payload             jsonObject
	ItemPayload         jsonObject
	PipelineJobID       string
	PipelinePriority    int
	CrawlPriorityClass  string
	SourcePriority      int
	DedupeWindowHours   *int
	QueryParamAllowlist []string
	Keywords            []string
}

// marshalTaskConfig renders the CrawlTask.config column. crawlOptions keys come
// first (spread), then the scheduler-owned keys in the NestJS order.
func (c crawlTaskConfig) marshalTaskConfig() json.RawMessage {
	object := jsonObject{}
	for key, value := range c.Payload {
		object[key] = value
	}
	object["ingestToItems"] = rawValue(true)
	object["pipelineJobId"] = rawValue(c.PipelineJobID)
	object["pipelinePriority"] = rawValue(c.PipelinePriority)
	object["crawlPriorityClass"] = rawValue(c.CrawlPriorityClass)
	object["sourcePriority"] = rawValue(c.SourcePriority)
	if c.DedupeWindowHours != nil {
		object["orgContentDedupeWindowHours"] = rawValue(*c.DedupeWindowHours)
	}
	if c.QueryParamAllowlist != nil {
		object["urlQueryParamAllowlist"] = rawValue(c.QueryParamAllowlist)
	}
	object["itemPayload"] = rawValue(c.ItemPayload)
	return mustJSON(object)
}

// buildItemPayload is the itemPayload object of CrawlTask.config.
func buildItemPayload(payload crawlPayload, itemPayloadConfig jsonObject) jsonObject {
	metadata := jsonObject{}
	for key, value := range itemPayloadConfig {
		metadata[key] = value
	}
	for key, value := range payload.Metadata {
		metadata[key] = value
	}
	itemPayload := jsonObject{
		"keywords":     rawValue(payload.Keywords),
		"tags":         rawValue(payload.Tags),
		"summaryHints": rawValue(payload.SummaryHints),
		"metadata":     rawValue(metadata),
		"forceRefresh": rawValue(payload.ForceRefresh),
	}
	if payload.SourceName != nil {
		itemPayload["sourceName"] = rawValue(*payload.SourceName)
	}
	if payload.Language != nil {
		itemPayload["language"] = rawValue(*payload.Language)
	}
	return itemPayload
}

// buildItemPayloadConfig is the itemPayload.metadata prefix before the payload
// metadata override.
func buildItemPayloadConfig(source *source, seed *seedConfig, seedParentURL string, seedInput *seedPayloadInput) jsonObject {
	out := jsonObject{
		"sourceId":   rawValue(source.ID),
		"sourceType": rawValue(source.SiteType),
	}
	if source.CrawlTemplateID != nil {
		out["crawlTemplateId"] = rawValue(*source.CrawlTemplateID)
	}
	if seed != nil {
		seedPayload := newsSourceSeedPayload{
			Mode:              string(seed.Mode),
			ParentURL:         seedParentURL,
			DedupeWindowHours: seed.DedupeWindowHours,
		}
		if seedInput != nil {
			seedPayload.RelevanceScore = seedInput.RelevanceScore
			seedPayload.PublishedAt = seedInput.PublishedAt
			seedPayload.CrawledAt = seedInput.CrawledAt
			seedPayload.EffectiveAt = seedInput.EffectiveAt
			seedPayload.TimestampSource = seedInput.TimestampSource
		}
		out["urlQueryParamAllowlist"] = rawValue(seed.QueryParamAllowlist)
		out["newsSourceSeed"] = rawValue(seedPayload)
	}
	return out
}

// buildRSSPrefetchedPayload is buildRssPrefetchedPayload followed by the
// NormalizedNewsPayloadSchema validation.
func buildRSSPrefetchedPayload(base crawlPayload, article *prefetchedArticle) (itemsingest.NormalizedNewsPayload, bool) {
	metadata := jsonObject{}
	for key, value := range base.Metadata {
		metadata[key] = value
	}
	metadata["prefetchedArticle"] = rawValue(true)

	articleMetadata := jsonObject{"source": rawValue("rss")}
	if incoming, ok := decodeObject(article.Metadata); ok {
		for key, value := range incoming {
			articleMetadata[key] = value
		}
	}
	articlePayload := prefetchedArticlePayload{
		Title:       article.Title,
		Description: article.Description,
		Author:      article.Author,
		Markdown:    article.Markdown,
		PublishedAt: article.PublishedAt,
		Metadata:    articleMetadata,
	}
	raw := jsonObject{
		"url":               rawValue(base.URL),
		"keywords":          rawValue(base.Keywords),
		"tags":              rawValue(base.Tags),
		"summaryHints":      rawValue(base.SummaryHints),
		"metadata":          rawValue(metadata),
		"prefetchedArticle": rawValue(articlePayload),
		"forceRefresh":      rawValue(false),
	}
	if base.Language != nil {
		raw["language"] = rawValue(*base.Language)
	}
	if base.SourceName != nil {
		raw["sourceName"] = rawValue(*base.SourceName)
	}
	encoded := mustJSON(raw)
	normalized, err := itemsingest.NormalizeNewsPayload(encoded)
	if err != nil {
		return itemsingest.NormalizedNewsPayload{}, false
	}
	return normalized, true
}

// prefetchedArticlePayload is the prefetchedArticle object.
type prefetchedArticlePayload struct {
	Title       *string    `json:"title,omitempty"`
	Description *string    `json:"description,omitempty"`
	Author      *string    `json:"author,omitempty"`
	Markdown    string     `json:"markdown"`
	PublishedAt *string    `json:"publishedAt,omitempty"`
	Metadata    jsonObject `json:"metadata"`
}

// displayName is `NewsSource:{id}:{name}` sliced to 80 UTF-16 code units.
func displayName(source *source) string {
	value := "NewsSource:" + source.ID + ":" + source.Name
	return truncateUTF16(value, displayNameMaxLength)
}

// toItemMetaName is toItemMetaName.
func toItemMetaName(value string) string {
	trimmed := trimJS(value)
	if utf16Length(trimmed) <= itemMetaNameMaxLength {
		return trimmed
	}
	head := trimEndJS(truncateUTF16(trimmed, itemMetaNameMaxLength-1))
	return head + "…"
}

// stringPtr returns a pointer to the value.
func stringPtr(value string) *string {
	return &value
}
