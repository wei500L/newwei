package itemsreading

import (
	"bytes"
	"encoding/json"
	"strings"
)

// rawPayloadProjection is the typed view of the open RawItem.payload document.
// It carries every alias the preview contracts read; unknown keys are ignored
// because the projections never consult them.
type rawPayloadProjection struct {
	URL                 *string               `json:"url"`
	Link                *string               `json:"link"`
	SourceURL           *string               `json:"sourceUrl"`
	SourceName          *string               `json:"sourceName"`
	SourceNameSnake     *string               `json:"source_name"`
	Source              *string               `json:"source"`
	Publisher           *string               `json:"publisher"`
	SiteName            *string               `json:"siteName"`
	SiteNameSnake       *string               `json:"site_name"`
	Thumbnail           *string               `json:"thumbnail"`
	ThumbnailURL        *string               `json:"thumbnailUrl"`
	Image               *string               `json:"image"`
	ImageURL            *string               `json:"imageUrl"`
	ImageURLSnake       *string               `json:"image_url"`
	Summary             *string               `json:"summary"`
	Abstract            *string               `json:"abstract"`
	Description         *string               `json:"description"`
	SentimentLabel      *string               `json:"sentiment_label"`
	SentimentLabelCamel *string               `json:"sentimentLabel"`
	Sentiment           *string               `json:"sentiment"`
	Region              *string               `json:"region"`
	Country             *string               `json:"country"`
	Area                *string               `json:"area"`
	Location            *string               `json:"location"`
	Ticker              *string               `json:"ticker"`
	Symbol              *string               `json:"symbol"`
	Price               json.RawMessage       `json:"price"`
	ChangePercent       json.RawMessage       `json:"changePercent"`
	ChangePercentSnake  json.RawMessage       `json:"change_percent"`
	Change              json.RawMessage       `json:"change"`
	PublishedAt         *string               `json:"publishedAt"`
	PublishedAtSnake    *string               `json:"published_at"`
	History             json.RawMessage       `json:"history"`
	Metadata            *rawPayloadProjection `json:"metadata"`
}

// decodeRawPayloadProjection decodes the open payload into the typed
// projection, or nil when the leaf is not a JSON object.
func decodeRawPayloadProjection(payload OpenJSON) *rawPayloadProjection {
	if !payload.Valid() {
		return nil
	}
	raw := bytes.TrimSpace(payload.Bytes())
	if len(raw) == 0 || raw[0] != '{' {
		return nil
	}
	projection := &rawPayloadProjection{}
	if err := json.Unmarshal(raw, projection); err != nil {
		return nil
	}
	return projection
}

// mergedString resolves an alias list against `{...payload, ...metadata}`:
// metadata overrides a payload key of the same name, and the first alias with a
// non-empty trimmed value wins.
func mergedString(payload, metadata *rawPayloadProjection, keys []string) string {
	for _, key := range keys {
		value, ok := lookupString(metadata, key)
		if !ok {
			value, ok = lookupString(payload, key)
		}
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// mergedNumber resolves a numeric alias list with the same override rule.
func mergedNumber(payload, metadata *rawPayloadProjection, keys []string) (float64, bool) {
	for _, key := range keys {
		raw, ok := lookupRaw(metadata, key)
		if !ok {
			raw, ok = lookupRaw(payload, key)
		}
		if !ok {
			continue
		}
		if number, ok := jsonFiniteNumber(raw); ok {
			return number, true
		}
	}
	return 0, false
}

// mergedRaw resolves a raw alias list with the same override rule.
func mergedRaw(payload, metadata *rawPayloadProjection, keys []string) json.RawMessage {
	for _, key := range keys {
		raw, ok := lookupRaw(metadata, key)
		if !ok {
			raw, ok = lookupRaw(payload, key)
		}
		if !ok {
			continue
		}
		if len(bytes.TrimSpace(raw)) > 0 {
			return raw
		}
	}
	return nil
}

func lookupString(projection *rawPayloadProjection, key string) (string, bool) {
	if projection == nil {
		return "", false
	}
	var target *string
	switch key {
	case "url":
		target = projection.URL
	case "link":
		target = projection.Link
	case "sourceUrl":
		target = projection.SourceURL
	case "sourceName":
		target = projection.SourceName
	case "source_name":
		target = projection.SourceNameSnake
	case "source":
		target = projection.Source
	case "publisher":
		target = projection.Publisher
	case "siteName":
		target = projection.SiteName
	case "site_name":
		target = projection.SiteNameSnake
	case "thumbnail":
		target = projection.Thumbnail
	case "thumbnailUrl":
		target = projection.ThumbnailURL
	case "image":
		target = projection.Image
	case "imageUrl":
		target = projection.ImageURL
	case "image_url":
		target = projection.ImageURLSnake
	case "summary":
		target = projection.Summary
	case "abstract":
		target = projection.Abstract
	case "description":
		target = projection.Description
	case "sentiment_label":
		target = projection.SentimentLabel
	case "sentimentLabel":
		target = projection.SentimentLabelCamel
	case "sentiment":
		target = projection.Sentiment
	case "region":
		target = projection.Region
	case "country":
		target = projection.Country
	case "area":
		target = projection.Area
	case "location":
		target = projection.Location
	case "ticker":
		target = projection.Ticker
	case "symbol":
		target = projection.Symbol
	case "publishedAt":
		target = projection.PublishedAt
	case "published_at":
		target = projection.PublishedAtSnake
	}
	if target == nil {
		return "", false
	}
	return *target, true
}

func lookupRaw(projection *rawPayloadProjection, key string) (json.RawMessage, bool) {
	if projection == nil {
		return nil, false
	}
	switch key {
	case "price":
		return projection.Price, len(projection.Price) > 0
	case "changePercent":
		return projection.ChangePercent, len(projection.ChangePercent) > 0
	case "change_percent":
		return projection.ChangePercentSnake, len(projection.ChangePercentSnake) > 0
	case "change":
		return projection.Change, len(projection.Change) > 0
	case "history":
		return projection.History, len(projection.History) > 0
	}
	return nil, false
}

// RawPreview is the typed rawPreview payload shared by the GraphQL resolver
// and the read-model projection.
type RawPreview struct {
	URL           string
	SourceName    string
	Thumbnail     string
	Summary       string
	Sentiment     string
	Region        string
	Location      string
	Ticker        string
	Price         *float64
	ChangePercent *float64
	History       []SeriesPoint
}

// Empty reports whether no field carries data.
func (p RawPreview) Empty() bool {
	return p.URL == "" && p.SourceName == "" && p.Thumbnail == "" && p.Summary == "" &&
		p.Sentiment == "" && p.Region == "" && p.Location == "" && p.Ticker == "" &&
		p.Price == nil && p.ChangePercent == nil && len(p.History) == 0
}

// ExtractRawPreviewMongo exposes the resolver-side rawPreview projection to the
// GraphQL adapter package.
func ExtractRawPreviewMongo(payload OpenJSON) RawPreview {
	return extractRawPreviewMongo(payload)
}

// extractRawPreviewMongo ports the resolver's rawPreview body.
func extractRawPreviewMongo(payload OpenJSON) RawPreview {
	projection := decodeRawPayloadProjection(payload)
	if projection == nil {
		return RawPreview{}
	}
	metadata := projection.Metadata
	preview := RawPreview{
		URL:        mergedString(projection, metadata, []string{"url", "link", "sourceUrl"}),
		SourceName: mergedString(projection, metadata, []string{"sourceName", "source_name", "source", "publisher", "siteName", "site_name"}),
		Thumbnail:  mergedString(projection, metadata, []string{"thumbnail", "thumbnailUrl", "image", "imageUrl", "image_url"}),
		Summary:    mergedString(projection, metadata, []string{"summary", "abstract", "description"}),
		Sentiment:  mergedString(projection, metadata, []string{"sentiment_label", "sentimentLabel", "sentiment"}),
		Region:     mergedString(projection, metadata, []string{"region", "country", "area"}),
		Location:   mergedString(projection, metadata, []string{"location"}),
		Ticker:     mergedString(projection, metadata, []string{"ticker", "symbol"}),
	}
	if number, ok := mergedNumber(projection, metadata, []string{"price"}); ok {
		preview.Price = &number
	}
	if number, ok := mergedNumber(projection, metadata, []string{"changePercent", "change_percent", "change"}); ok {
		preview.ChangePercent = &number
	}
	preview.History = normalizeSeriesPointsMongo(mergedRaw(projection, metadata, []string{"history"}))
	return preview
}

// ExtractRawPreviewReadModel exposes the read-model rawPreview projection to
// the GraphQL adapter package.
func ExtractRawPreviewReadModel(payload OpenJSON) RawPreview {
	return extractRawPreviewReadModel(payload)
}

// extractRawPreviewReadModel ports extractRawPayloadFields (the read-model
// variant: the ISO-normalized history rule and no alias-set differences for the
// string fields).
func extractRawPreviewReadModel(payload OpenJSON) RawPreview {
	projection := decodeRawPayloadProjection(payload)
	if projection == nil {
		return RawPreview{}
	}
	metadata := projection.Metadata
	preview := RawPreview{
		URL:        mergedString(projection, metadata, []string{"url", "link", "sourceUrl"}),
		SourceName: mergedString(projection, metadata, []string{"sourceName", "source_name", "source", "publisher", "siteName", "site_name"}),
		Thumbnail:  mergedString(projection, metadata, []string{"thumbnail", "thumbnailUrl", "image", "imageUrl", "image_url"}),
		Summary:    mergedString(projection, metadata, []string{"summary", "abstract", "description"}),
		Sentiment:  mergedString(projection, metadata, []string{"sentiment_label", "sentimentLabel", "sentiment"}),
		Region:     mergedString(projection, metadata, []string{"region", "country", "area"}),
		Location:   mergedString(projection, metadata, []string{"location"}),
		Ticker:     mergedString(projection, metadata, []string{"ticker", "symbol"}),
	}
	if number, ok := mergedNumber(projection, metadata, []string{"price"}); ok {
		preview.Price = &number
	}
	if number, ok := mergedNumber(projection, metadata, []string{"changePercent", "change_percent", "change"}); ok {
		preview.ChangePercent = &number
	}
	preview.History = normalizeSeriesPointsReadModel(mergedRaw(projection, metadata, []string{"history"}))
	return preview
}

// ProcessedResultFields is the typed processed-preview projection.
type ProcessedResultFields struct {
	Source       string
	Title        string
	Language     string
	PublishedAt  *string
	Summary      string
	Sentiment    string
	ContentType  string
	Topics       []string
	Entities     []string
	QualityScore *float64
	Location     string
	Region       string
}

// ExtractProcessedResultFieldsResolver ports the resolver's normalized
// processedPreview fields (normalizeContentType applies synonym mapping).
func ExtractProcessedResultFieldsResolver(result OpenJSON) ProcessedResultFields {
	projection, _ := decodeResultRecord(result)
	fields := ProcessedResultFields{
		Source:      pickResultString(projection, []string{"source", "sourceName", "source_name"}),
		Title:       pickResultString(projection, []string{"title", "headline", "title_zh", "titleZh"}),
		Language:    pickResultString(projection, []string{"language", "lang"}),
		PublishedAt: resolvePublishedAtFromProcessedResult(result),
		Summary:     pickResultString(projection, []string{"summary", "abstract"}),
		Sentiment:   pickResultString(projection, []string{"sentiment_label", "sentimentLabel", "sentiment"}),
		Topics:      stringListFromJSON(projection.Topics.Bytes()),
		Entities:    entityNamesFromJSON(projection.Entities.Bytes()),
		Location:    pickResultString(projection, []string{"location"}),
		Region:      pickResultString(projection, []string{"region"}),
	}
	if value, ok := pickResultNumber(projection, []string{"quality_score", "qualityScore"}); ok {
		fields.QualityScore = &value
	}
	fields.ContentType = normalizeContentType(pickResultString(projection, []string{"content_type", "contentType"}))
	return fields
}

// ExtractProcessedResultFieldsReadModel ports extractProcessedResultFields
// from item-read-model.utils.ts. The differences from the resolver variant are
// deliberate and preserved: publisher/subtitle aliases and normalizeLowerKey
// instead of the contentType synonym mapping.
func ExtractProcessedResultFieldsReadModel(result OpenJSON) ProcessedResultFields {
	projection, _ := decodeResultRecord(result)
	fields := ProcessedResultFields{
		Source:      pickResultString(projection, []string{"source", "sourceName", "source_name", "publisher"}),
		Title:       pickResultString(projection, []string{"title", "headline", "title_zh", "titleZh"}),
		Language:    pickResultString(projection, []string{"language", "lang"}),
		PublishedAt: resolvePublishedAtFromProcessedResult(result),
		Summary:     pickResultString(projection, []string{"summary", "abstract", "subtitle"}),
		Sentiment:   pickResultString(projection, []string{"sentiment_label", "sentimentLabel", "sentiment"}),
		Topics:      stringListFromJSON(projection.Topics.Bytes()),
		Entities:    entityNamesFromJSON(projection.Entities.Bytes()),
		Location:    pickResultString(projection, []string{"location"}),
		Region:      pickResultString(projection, []string{"region"}),
	}
	if value, ok := pickResultNumber(projection, []string{"quality_score", "qualityScore"}); ok {
		fields.QualityScore = &value
	}
	fields.ContentType = normalizeLowerKey(pickResultString(projection, []string{"content_type", "contentType"}))
	return fields
}

// normalizeLowerKey ports normalizeLowerKey from item-read-model.utils.ts.
func normalizeLowerKey(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	collapsed := strings.Join(strings.Fields(trimmed), " ")
	lowered := strings.ToLower(collapsed)
	runes := []rune(lowered)
	if len(runes) > 128 {
		runes = runes[:128]
	}
	return string(runes)
}
