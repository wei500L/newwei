package itemsreading

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// This file holds the typed projections of the two genuinely open JSON leaves
// (RawItem.payload and ProcessedItem.result) plus the alias/coercion helpers
// the previews and facet pipelines share with NestJS. Everything decodes into a
// named struct; no untyped map is used.

// firstNonEmpty returns the first trimmed, non-empty value.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// dedupeStrings preserves the first occurrence order.
func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// resultProjection is the typed view of the open processed result used by the
// filters, facets, previews and suggestions.
type resultProjection struct {
	Title               *string  `json:"title"`
	Headline            *string  `json:"headline"`
	TitleZh             *string  `json:"title_zh"`
	TitleZhCamel        *string  `json:"titleZh"`
	Summary             *string  `json:"summary"`
	Abstract            *string  `json:"abstract"`
	Subtitle            *string  `json:"subtitle"`
	Language            *string  `json:"language"`
	Lang                *string  `json:"lang"`
	Source              *string  `json:"source"`
	SourceName          *string  `json:"sourceName"`
	SourceNameSnake     *string  `json:"source_name"`
	Publisher           *string  `json:"publisher"`
	PublishedAt         *string  `json:"published_at"`
	PublishedAtCamel    *string  `json:"publishedAt"`
	Sentiment           *string  `json:"sentiment"`
	SentimentLabel      *string  `json:"sentiment_label"`
	SentimentLabelCamel *string  `json:"sentimentLabel"`
	ContentType         *string  `json:"content_type"`
	ContentTypeCamel    *string  `json:"contentType"`
	Location            *string  `json:"location"`
	Region              *string  `json:"region"`
	QualityScore        *float64 `json:"quality_score"`
	QualityScoreCamel   *float64 `json:"qualityScore"`
	Topics              OpenJSON `json:"topics"`
	Entities            OpenJSON `json:"entities"`
}

// decodeResultProjection decodes the open result leaf into the typed
// projection. A missing or invalid value yields the zero projection.
func decodeResultProjection(result OpenJSON) resultProjection {
	var projection resultProjection
	if !result.Valid() {
		return projection
	}
	_ = json.Unmarshal(result.Bytes(), &projection)
	return projection
}

// decodeResultRecord is the same decode but also reports whether the leaf held
// a JSON object.
func decodeResultRecord(result OpenJSON) (resultProjection, bool) {
	if !result.Valid() {
		return resultProjection{}, false
	}
	raw := bytes.TrimSpace(result.Bytes())
	if len(raw) == 0 || raw[0] != '{' {
		return resultProjection{}, false
	}
	var projection resultProjection
	if err := json.Unmarshal(raw, &projection); err != nil {
		return resultProjection{}, false
	}
	return projection, true
}

// NormalizeProcessedResult ports normalizeProcessedResult: null and blank
// values collapse to null, a JSON string is parsed (recursively), malformed
// JSON becomes null, and any other value is returned unchanged.
func NormalizeProcessedResult(result OpenJSON) OpenJSON {
	if !result.Valid() {
		return OpenJSON{}
	}
	raw := bytes.TrimSpace(result.Bytes())
	if len(raw) == 0 {
		return OpenJSON{}
	}
	if raw[0] != '"' {
		return result
	}
	// The stored value is a JSON string; unwrap it and recurse so multi-level
	// string encodings converge, exactly like the NestJS helper.
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return OpenJSON{}
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return OpenJSON{}
	}
	if !json.Valid([]byte(trimmed)) {
		return OpenJSON{}
	}
	return NormalizeProcessedResult(NewOpenJSON([]byte(trimmed)))
}

// ResultJSONToken returns the JSON token the GraphQL resultJson field projects:
// the normalized object, or null when the normalized value is not an object.
func ResultJSONToken(result OpenJSON) json.RawMessage {
	normalized := NormalizeProcessedResult(result)
	if !normalized.Valid() {
		return json.RawMessage("null")
	}
	raw := bytes.TrimSpace(normalized.Bytes())
	if len(raw) == 0 || raw[0] != '{' {
		return json.RawMessage("null")
	}
	return normalized.Bytes()
}

// ResultStringToken returns the JSON string the GraphQL result field projects
// (JSON.stringify of the normalized value), or null when normalization failed.
func ResultStringToken(result OpenJSON) *string {
	normalized := NormalizeProcessedResult(result)
	if !normalized.Valid() {
		return nil
	}
	text := string(normalized.Bytes())
	return &text
}

// SeriesPoint is one history point.
type SeriesPoint struct {
	Timestamp string
	Value     float64
}

// normalizeSeriesPointsMongo ports the rawPreview (Mongo) history rule: at most
// 60 points, the timestamp is kept verbatim, and the value comes from the
// `value` key only.
func normalizeSeriesPointsMongo(raw json.RawMessage) []SeriesPoint {
	limit := 60
	if limit < 1 {
		limit = 1
	}
	if limit > 500 {
		limit = 500
	}
	entries := jsonArrayElements(raw)
	points := make([]SeriesPoint, 0, len(entries))
	for _, entry := range entries {
		var record struct {
			Timestamp *string         `json:"timestamp"`
			Time      *string         `json:"time"`
			Date      *string         `json:"date"`
			Value     json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(entry, &record); err != nil {
			continue
		}
		timestamp := firstNonEmptyPtr(record.Timestamp, record.Time, record.Date)
		value, ok := jsonFiniteNumber(record.Value)
		if timestamp == "" || !ok {
			continue
		}
		points = append(points, SeriesPoint{Timestamp: timestamp, Value: value})
		if len(points) >= limit {
			break
		}
	}
	if len(points) == 0 {
		return nil
	}
	return points
}

// normalizeSeriesPointsReadModel ports the read-model history rule: no limit,
// the timestamp is normalized to ISO, and the value falls back to price/close.
func normalizeSeriesPointsReadModel(raw json.RawMessage) []SeriesPoint {
	entries := jsonArrayElements(raw)
	points := make([]SeriesPoint, 0, len(entries))
	for _, entry := range entries {
		var record struct {
			Timestamp *string         `json:"timestamp"`
			Time      *string         `json:"time"`
			Value     json.RawMessage `json:"value"`
			Price     json.RawMessage `json:"price"`
			Close     json.RawMessage `json:"close"`
		}
		if err := json.Unmarshal(entry, &record); err != nil {
			continue
		}
		timestamp := normalizeISOStringPtr(record.Timestamp)
		if timestamp == nil {
			timestamp = normalizeISOStringPtr(record.Time)
		}
		value, ok := jsonFiniteNumber(record.Value)
		if !ok {
			value, ok = jsonFiniteNumber(record.Price)
		}
		if !ok {
			value, ok = jsonFiniteNumber(record.Close)
		}
		if timestamp == nil || !ok {
			continue
		}
		points = append(points, SeriesPoint{Timestamp: *timestamp, Value: value})
	}
	if len(points) == 0 {
		return nil
	}
	return points
}

// jsonArrayElements splits a JSON array into its element tokens.
func jsonArrayElements(raw json.RawMessage) []json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil
	}
	var elements []json.RawMessage
	if err := json.Unmarshal(trimmed, &elements); err != nil {
		return nil
	}
	return elements
}

// stringListFromJSON ports normalizeStringList: string elements are trimmed,
// object elements fall back through name/label/value/topic, blanks are dropped
// and duplicates removed.
func stringListFromJSON(raw json.RawMessage) []string {
	out := make([]string, 0, 8)
	for _, element := range jsonArrayElements(raw) {
		trimmed := strings.TrimSpace(elementText(element))
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return dedupeStrings(out)
}

// elementText returns the textual value of a string or object element.
func elementText(element json.RawMessage) string {
	trimmed := bytes.TrimSpace(element)
	if len(trimmed) == 0 {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return ""
		}
		return text
	}
	if trimmed[0] != '{' {
		return ""
	}
	var record struct {
		Name  *string `json:"name"`
		Label *string `json:"label"`
		Value *string `json:"value"`
		Topic *string `json:"topic"`
	}
	if err := json.Unmarshal(trimmed, &record); err != nil {
		return ""
	}
	return firstNonEmptyPtr(record.Name, record.Label, record.Value, record.Topic)
}

// entityNamesFromJSON ports normalizeEntityNames: string elements are taken
// verbatim, object elements contribute their `name`.
func entityNamesFromJSON(raw json.RawMessage) []string {
	out := make([]string, 0, 8)
	for _, element := range jsonArrayElements(raw) {
		trimmed := bytes.TrimSpace(element)
		if len(trimmed) == 0 {
			continue
		}
		if trimmed[0] == '"' {
			var text string
			if err := json.Unmarshal(trimmed, &text); err != nil {
				continue
			}
			out = append(out, text)
			continue
		}
		if trimmed[0] != '{' {
			continue
		}
		var record struct {
			Name *string `json:"name"`
		}
		if err := json.Unmarshal(trimmed, &record); err != nil {
			continue
		}
		if record.Name != nil {
			out = append(out, *record.Name)
		}
	}
	return dedupeStrings(out)
}

// normalizeContentType ports normalizeContentType from items.resolver.ts.
func normalizeContentType(value string) string {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	if trimmed == "" {
		return ""
	}
	normalized := strings.NewReplacer(" ", "_", "\t", "_", "\n", "_", "-", "_").Replace(trimmed)
	for strings.Contains(normalized, "__") {
		normalized = strings.ReplaceAll(normalized, "__", "_")
	}
	switch normalized {
	case "news_fact", "opinion", "analysis", "mixed":
		return normalized
	case "news", "fact", "facts", "report":
		return "news_fact"
	case "editorial", "commentary", "op_ed", "column":
		return "opinion"
	case "insight", "insights", "explainer":
		return "analysis"
	case "hybrid":
		return "mixed"
	default:
		return ""
	}
}

// firstNonEmptyPtr returns the first trimmed, non-empty string.
func firstNonEmptyPtr(values ...*string) string {
	for _, value := range values {
		if value == nil {
			continue
		}
		if trimmed := strings.TrimSpace(*value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// normalizeISOStringPtr parses a timestamp string and normalizes it to ISO. A
// missing or unparsable value yields nil.
func normalizeISOStringPtr(value *string) *string {
	if value == nil {
		return nil
	}
	parsed, ok := parseTimeValue(*value)
	if !ok {
		return nil
	}
	formatted := FormatISOTime(parsed)
	return &formatted
}

// jsonFiniteNumber ports normalizeFiniteNumber over a raw JSON token.
func jsonFiniteNumber(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return 0, false
	}
	var number float64
	if err := json.Unmarshal(trimmed, &number); err == nil {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// pickResultString returns the first non-empty alias value.
func pickResultString(projection resultProjection, keys []string) string {
	for _, key := range keys {
		switch key {
		case "source":
			if value := nonEmptyString(projection.Source); value != "" {
				return value
			}
		case "sourceName":
			if value := nonEmptyString(projection.SourceName); value != "" {
				return value
			}
		case "source_name":
			if value := nonEmptyString(projection.SourceNameSnake); value != "" {
				return value
			}
		case "publisher":
			if value := nonEmptyString(projection.Publisher); value != "" {
				return value
			}
		case "title":
			if value := nonEmptyString(projection.Title); value != "" {
				return value
			}
		case "headline":
			if value := nonEmptyString(projection.Headline); value != "" {
				return value
			}
		case "title_zh":
			if value := nonEmptyString(projection.TitleZh); value != "" {
				return value
			}
		case "titleZh":
			if value := nonEmptyString(projection.TitleZhCamel); value != "" {
				return value
			}
		case "summary":
			if value := nonEmptyString(projection.Summary); value != "" {
				return value
			}
		case "abstract":
			if value := nonEmptyString(projection.Abstract); value != "" {
				return value
			}
		case "subtitle":
			if value := nonEmptyString(projection.Subtitle); value != "" {
				return value
			}
		case "language":
			if value := nonEmptyString(projection.Language); value != "" {
				return value
			}
		case "lang":
			if value := nonEmptyString(projection.Lang); value != "" {
				return value
			}
		case "sentiment":
			if value := nonEmptyString(projection.Sentiment); value != "" {
				return value
			}
		case "sentiment_label":
			if value := nonEmptyString(projection.SentimentLabel); value != "" {
				return value
			}
		case "sentimentLabel":
			if value := nonEmptyString(projection.SentimentLabelCamel); value != "" {
				return value
			}
		case "location":
			if value := nonEmptyString(projection.Location); value != "" {
				return value
			}
		case "region":
			if value := nonEmptyString(projection.Region); value != "" {
				return value
			}
		case "content_type":
			if value := nonEmptyString(projection.ContentType); value != "" {
				return value
			}
		case "contentType":
			if value := nonEmptyString(projection.ContentTypeCamel); value != "" {
				return value
			}
		}
	}
	return ""
}

// pickResultNumber returns the first finite alias number.
func pickResultNumber(projection resultProjection, keys []string) (float64, bool) {
	for _, key := range keys {
		switch key {
		case "quality_score":
			if projection.QualityScore != nil && !math.IsNaN(*projection.QualityScore) && !math.IsInf(*projection.QualityScore, 0) {
				return *projection.QualityScore, true
			}
		case "qualityScore":
			if projection.QualityScoreCamel != nil && !math.IsNaN(*projection.QualityScoreCamel) && !math.IsInf(*projection.QualityScoreCamel, 0) {
				return *projection.QualityScoreCamel, true
			}
		}
	}
	return 0, false
}

// resolvePublishedAtFromProcessedResult ports the resolver helper.
func resolvePublishedAtFromProcessedResult(result OpenJSON) *string {
	projection, ok := decodeResultRecord(result)
	if !ok {
		return nil
	}
	if projection.PublishedAt != nil {
		return normalizeISOStringPtr(projection.PublishedAt)
	}
	return normalizeISOStringPtr(projection.PublishedAtCamel)
}

// resolvePublishedAtFromRawPayload ports the resolver helper.
func resolvePublishedAtFromRawPayload(payload OpenJSON) *string {
	projection := decodeRawPayloadProjection(payload)
	if projection == nil {
		return nil
	}
	if projection.PublishedAt != nil {
		return normalizeISOStringPtr(projection.PublishedAt)
	}
	return normalizeISOStringPtr(projection.PublishedAtSnake)
}

// collectSuggestionValues ports collectSuggestionValuesFromProcessed.
func collectSuggestionValues(tags []string, result OpenJSON) SuggestionFields {
	projection, _ := decodeResultRecord(result)
	topicSet := make([]string, 0, 16)
	topicSet = append(topicSet, stringListFromJSON(projection.Topics)...)
	topicSet = append(topicSet, entityNamesFromJSON(projection.Entities)...)
	for _, tag := range tags {
		if trimmed := strings.TrimSpace(tag); trimmed != "" {
			topicSet = append(topicSet, trimmed)
		}
	}
	topics := dedupeStrings(topicSet)
	if len(topics) > 10 {
		topics = topics[:10]
	}

	region := pickResultString(projection, []string{"location", "region"})
	source := pickResultString(projection, []string{"source", "sourceName", "source_name", "publisher"})

	sentimentSet := make([]string, 0, 2)
	if sentiment := pickResultString(projection, []string{"sentiment", "sentiment_label"}); sentiment != "" {
		normalized := strings.ToLower(sentiment)
		switch normalized {
		case "positive", "neutral", "negative":
			sentimentSet = append(sentimentSet, normalized)
		}
	}
	for _, tag := range tags {
		normalized := strings.ToLower(strings.TrimSpace(tag))
		switch normalized {
		case "positive", "neutral", "negative":
			sentimentSet = append(sentimentSet, normalized)
		}
	}

	fields := SuggestionFields{Topics: topics, Sentiments: dedupeStrings(sentimentSet)}
	if region != "" {
		fields.Regions = []string{region}
	}
	if source != "" {
		fields.Sources = []string{source}
	}
	return fields
}
