package situationsignals

import (
	"context"
	"log"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

const (
	insightsProcessedCollection = "processeditems"
	insightsRawCollection       = "rawitems"
	insightsSourceTag           = "situation-monitor"
)

var (
	insightsPlaceholderTitle   = regexp.MustCompile(`(?i)^(?:no\s*title|untitled|title\s*unavailable|headline\s*unavailable|n/a|na|null|undefined|暂无标题|无标题|未命名(?:标题)?)$`)
	insightsTrailingTitlePunct = regexp.MustCompile(`[。.!?！？]+$`)
)

var insightsAlertKeywords = []string{
	"war", "invasion", "military", "nuclear", "sanctions", "missile", "attack",
	"troops", "conflict", "strike", "bomb", "casualties", "ceasefire", "treaty",
	"nato", "coup", "martial law", "emergency", "assassination", "terrorist",
	"hostage", "evacuation",
}

var insightsCriticalKeywords = map[string]bool{
	"nuclear": true, "invasion": true, "missile": true, "attack": true,
	"assassination": true, "terrorist": true, "hostage": true, "martial law": true,
}

type insightsResultDoc struct {
	Title              bson.RawValue `bson:"title"`
	Subtitle           bson.RawValue `bson:"subtitle"`
	Source             bson.RawValue `bson:"source"`
	Summary            bson.RawValue `bson:"summary"`
	KeyPoints          bson.RawValue `bson:"key_points"`
	Topics             bson.RawValue `bson:"topics"`
	Entities           bson.RawValue `bson:"entities"`
	Location           bson.RawValue `bson:"location"`
	Category           bson.RawValue `bson:"category"`
	CategoryPath       bson.RawValue `bson:"category_path"`
	CategoryConfidence bson.RawValue `bson:"category_confidence"`
	CategoryReason     bson.RawValue `bson:"category_reason"`
}

type insightsProcessedDoc struct {
	ID          bson.RawValue `bson:"_id"`
	RawItemID   bson.RawValue `bson:"rawItemId"`
	ItemMetaID  bson.RawValue `bson:"itemMetaId"`
	DuplicateOf bson.RawValue `bson:"duplicateOf"`
	Tags        bson.RawValue `bson:"tags"`
	SortAt      bson.RawValue `bson:"sortAt"`
	IngestedAt  bson.RawValue `bson:"ingestedAt"`
	CreatedAt   bson.RawValue `bson:"createdAt"`
	Result      bson.RawValue `bson:"result"`
}

type insightsRawDoc struct {
	ID      bson.RawValue `bson:"_id"`
	Payload bson.RawValue `bson:"payload"`
}

type insightsRawPayload struct {
	URL        bson.RawValue `bson:"url"`
	SourceName bson.RawValue `bson:"sourceName"`
	Tags       bson.RawValue `bson:"tags"`
}

// buildHeadlinesByCategory mirrors the ProcessedItem read and normalization.
func (s *insightsService) buildHeadlinesByCategory(ctx context.Context, orgID string, since time.Time, maxItems, maxPerCategory int, scope string, debug bool) (analysis.HeadlinesByCategory, error) {
	byCategory := analysis.HeadlinesByCategory{
		Politics: []analysis.Headline{}, Tech: []analysis.Headline{}, Finance: []analysis.Headline{},
		Gov: []analysis.Headline{}, AI: []analysis.Headline{}, Intel: []analysis.Headline{},
	}
	if s.mongo == nil {
		return byCategory, errNoDatabase
	}
	maxCandidates := minInt(2000, maxInt(maxItems, maxPerCategory*len(analysis.Categories)*4))
	filter := insightsProcessedSinceFilter(orgID, since, scope)
	projection := bson.D{
		{Key: "_id", Value: 1}, {Key: "rawItemId", Value: 1}, {Key: "itemMetaId", Value: 1},
		{Key: "duplicateOf", Value: 1}, {Key: "tags", Value: 1}, {Key: "sortAt", Value: 1},
		{Key: "ingestedAt", Value: 1}, {Key: "createdAt", Value: 1},
		{Key: "result.title", Value: 1}, {Key: "result.subtitle", Value: 1},
		{Key: "result.source", Value: 1}, {Key: "result.summary", Value: 1},
		{Key: "result.key_points", Value: 1}, {Key: "result.topics", Value: 1},
		{Key: "result.entities", Value: 1}, {Key: "result.location", Value: 1},
		{Key: "result.category", Value: 1}, {Key: "result.category_path", Value: 1},
		{Key: "result.category_confidence", Value: 1}, {Key: "result.category_reason", Value: 1},
	}
	cursor, err := s.mongo.Collection(insightsProcessedCollection).Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "sortAt", Value: -1}, {Key: "ingestedAt", Value: -1}, {Key: "createdAt", Value: -1}}).
		SetLimit(int64(maxCandidates)).
		SetProjection(projection))
	if err != nil {
		return byCategory, err
	}
	defer cursor.Close(ctx)
	var processed []insightsProcessedDoc
	if err := cursor.All(ctx, &processed); err != nil {
		return byCategory, err
	}
	rawByID := s.loadRawItems(ctx, processed)
	now := s.now()

	for _, item := range processed {
		raw := rawByID[insightsObjectIDString(item.RawItemID)]
		payload := insightsRawPayload{}
		if raw != nil && raw.Payload.Type == bson.TypeEmbeddedDocument {
			_ = raw.Payload.Unmarshal(&payload)
		}
		link := ""
		if value, ok := insightsRawString(payload.URL); ok {
			link = strings.TrimSpace(value)
		}
		result, resultOK := insightsDecodeResult(item.Result)
		title := ""
		if resultOK {
			if value, ok := insightsRawString(result.Title); ok {
				title = strings.TrimSpace(value)
			}
		}
		if title == "" || insightsIsPlaceholderTitle(title) || link == "" {
			continue
		}

		subtitle := ""
		if resultOK {
			if value, ok := insightsRawString(result.Subtitle); ok {
				subtitle = strings.TrimSpace(value)
			}
		}
		rawSummary := subtitle
		if resultOK {
			if value, ok := insightsRawString(result.Summary); ok {
				rawSummary = strings.TrimSpace(value)
			}
		}
		summary := insightsNormalizeSummary(rawSummary)
		keyPoints := insightsNormalizeKeyPoints(result.KeyPoints)
		topics := insightsNormalizeTopics(result.Topics)
		entities := insightsNormalizeEntities(result.Entities)
		location := ""
		if resultOK {
			if value, ok := insightsRawString(result.Location); ok {
				location = strings.TrimSpace(value)
			}
		}

		rawSource := ""
		if value, ok := insightsRawString(payload.SourceName); ok {
			rawSource = value
		}
		extracted := ""
		if resultOK {
			if value, ok := insightsRawString(result.Source); ok {
				extracted = value
			}
		}
		source := ""
		if strings.TrimSpace(extracted) != "" {
			source = extracted
		} else if strings.TrimSpace(rawSource) != "" {
			source = rawSource
		} else if domain := insightsTryDomain(link); domain != "" {
			source = domain
		} else {
			source = "Unknown"
		}

		classification := analysis.ClassificationResult{}
		if scope == "tagged" {
			if tags, ok := insightsRawStringArray(item.Tags); ok {
				if category, found := insightsExtractCategory(tags); found {
					classification = analysis.ClassificationResult{Category: category, Source: analysis.ClassificationSourceTag}
				}
			}
		} else {
			input := analysis.ClassificationInput{
				Tags:    insightsRawStringArrayOrEmpty(item.Tags),
				Title:   title,
				Summary: insightsStringOrEmpty(summary),
				Source:  source,
			}
			if resultOK {
				input.ResultCategory = insightsRawStringOrEmpty(result.Category)
				input.CategoryPath = insightsRawStringOrEmpty(result.CategoryPath)
				input.CategoryReason = strings.TrimSpace(insightsRawStringOrEmpty(result.CategoryReason))
				input.ResultTopics = insightsRawStringArrayOrEmpty(result.Topics)
				if confidence, ok := insightsRawNumber(result.CategoryConfidence); ok && !math.IsNaN(confidence) && !math.IsInf(confidence, 0) {
					clamped := math.Max(0, math.Min(1, confidence))
					input.CategoryConfidence = &clamped
				}
			}
			if rawTags, ok := insightsRawStringArray(payload.Tags); ok {
				input.RawTags = rawTags
			}
			classification = analysis.ClassifySituationMonitorCategory(input)
		}
		if classification.Category == "" {
			continue
		}
		bucket := byCategory.Bucket(classification.Category)
		if bucket == nil || len(*bucket) >= maxPerCategory {
			continue
		}
		timestamp := insightsDocTimestamp(item, now)
		alertKeyword := insightsFindAlertKeyword(strings.TrimSpace(title + " " + insightsStringOrEmpty(summary)))
		itemMetaID := insightsStringOrEmptyFromBSON(item.ItemMetaID)
		duplicateOf := insightsLooseString(item.DuplicateOf)
		id := insightsObjectIDString(item.ID)
		if id == "" {
			id = link
		}
		headline := analysis.Headline{
			ID: id, Title: title, Link: link, Source: source, Timestamp: timestamp,
			Category: classification.Category, Origin: "items",
			IsAlert: alertKeyword != "",
		}
		if itemMetaID != "" {
			headline.ItemMetaID = itemMetaID
		}
		if duplicateOf != "" {
			headline.DuplicateOf = duplicateOf
		}
		if alertKeyword != "" {
			headline.AlertKeyword = alertKeyword
		}
		if summary != nil {
			headline.Summary = *summary
		}
		if len(keyPoints) > 0 {
			headline.KeyPoints = keyPoints
		}
		if len(topics) > 0 {
			headline.Topics = topics
		}
		if len(entities) > 0 {
			headline.Entities = entities
		}
		if location != "" {
			headline.Location = location
		}
		if debug {
			headline.ClassificationSource = classification.Source
			headline.ClassificationConfidence = classification.Confidence
			headline.ClassificationReason = classification.Reason
		}
		*bucket = append(*bucket, headline)
	}
	return byCategory, nil
}

func (s *insightsService) loadRawItems(ctx context.Context, processed []insightsProcessedDoc) map[string]*insightsRawDoc {
	out := map[string]*insightsRawDoc{}
	ids := make([]bson.ObjectID, 0)
	seen := map[string]bool{}
	for _, item := range processed {
		if item.RawItemID.Type != bson.TypeObjectID {
			continue
		}
		id := item.RawItemID.ObjectID()
		hex := id.Hex()
		if seen[hex] {
			continue
		}
		seen[hex] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return out
	}
	cursor, err := s.mongo.Collection(insightsRawCollection).Find(ctx,
		bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}},
		options.Find().SetProjection(bson.D{
			{Key: "_id", Value: 1}, {Key: "payload.url", Value: 1},
			{Key: "payload.sourceName", Value: 1}, {Key: "payload.tags", Value: 1},
		}))
	if err != nil {
		log.Printf("situationsignals: raw item lookup failed: %v", err)
		return out
	}
	defer cursor.Close(ctx)
	var rows []insightsRawDoc
	if err := cursor.All(ctx, &rows); err != nil {
		log.Printf("situationsignals: raw item decode failed: %v", err)
		return out
	}
	for index := range rows {
		if id := insightsObjectIDString(rows[index].ID); id != "" {
			out[id] = &rows[index]
		}
	}
	return out
}

// hasInternalCoverageOutsideWindow mirrors the one-row ProcessedItem probe.
func (s *insightsService) hasInternalCoverageOutsideWindow(ctx context.Context, orgID string, since time.Time, scope string) (bool, error) {
	oldest := s.now().Add(-168 * time.Hour)
	if !since.After(oldest) {
		return false, nil
	}
	if s.mongo == nil {
		return false, errNoDatabase
	}
	cursor, err := s.mongo.Collection(insightsProcessedCollection).Find(ctx,
		insightsProcessedBeforeFilter(orgID, since, oldest, scope),
		options.Find().SetSort(bson.D{{Key: "sortAt", Value: -1}, {Key: "ingestedAt", Value: -1}, {Key: "createdAt", Value: -1}}).
			SetLimit(1).SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return false, err
	}
	defer cursor.Close(ctx)
	var rows []bson.Raw
	if err := cursor.All(ctx, &rows); err != nil {
		return false, err
	}
	return len(rows) > 0, nil
}

func insightsProcessedSinceFilter(orgID string, since time.Time, scope string) bson.D {
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "duplicateOf", Value: nil},
		{Key: "$or", Value: bson.A{
			bson.D{{Key: "sortAt", Value: bson.D{{Key: "$gte", Value: since}}}},
			bson.D{{Key: "sortAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "ingestedAt", Value: bson.D{{Key: "$gte", Value: since}}}},
			bson.D{{Key: "sortAt", Value: nil}, {Key: "ingestedAt", Value: bson.D{{Key: "$gte", Value: since}}}},
			bson.D{{Key: "sortAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "ingestedAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}}},
			bson.D{{Key: "sortAt", Value: nil}, {Key: "ingestedAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "createdAt", Value: bson.D{{Key: "$gte", Value: since}}}},
		}},
	}
	if scope == "tagged" {
		filter = append(filter, bson.E{Key: "tags", Value: insightsSourceTag})
	}
	return filter
}

func insightsProcessedBeforeFilter(orgID string, since, floor time.Time, scope string) bson.D {
	filter := bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "duplicateOf", Value: nil},
		{Key: "$or", Value: bson.A{
			bson.D{{Key: "sortAt", Value: bson.D{{Key: "$lt", Value: since}, {Key: "$gte", Value: floor}}}},
			bson.D{{Key: "sortAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "ingestedAt", Value: bson.D{{Key: "$lt", Value: since}, {Key: "$gte", Value: floor}}}},
			bson.D{{Key: "sortAt", Value: nil}, {Key: "ingestedAt", Value: bson.D{{Key: "$lt", Value: since}, {Key: "$gte", Value: floor}}}},
			bson.D{{Key: "sortAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "ingestedAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "createdAt", Value: bson.D{{Key: "$lt", Value: since}, {Key: "$gte", Value: floor}}}},
			bson.D{{Key: "sortAt", Value: nil}, {Key: "ingestedAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "createdAt", Value: bson.D{{Key: "$lt", Value: since}, {Key: "$gte", Value: floor}}}},
		}},
	}
	if scope == "tagged" {
		filter = append(filter, bson.E{Key: "tags", Value: insightsSourceTag})
	}
	return filter
}

func insightsDecodeResult(value bson.RawValue) (insightsResultDoc, bool) {
	var result insightsResultDoc
	if value.Type != bson.TypeEmbeddedDocument {
		return result, false
	}
	if err := value.Unmarshal(&result); err != nil {
		return insightsResultDoc{}, false
	}
	return result, true
}

func insightsDocTimestamp(item insightsProcessedDoc, now time.Time) int64 {
	for _, value := range []bson.RawValue{item.SortAt, item.IngestedAt, item.CreatedAt} {
		if value.Type != bson.TypeDateTime {
			continue
		}
		var parsed time.Time
		if err := value.Unmarshal(&parsed); err == nil {
			return parsed.UnixMilli()
		}
	}
	return now.UnixMilli()
}

func insightsObjectIDString(value bson.RawValue) string {
	if value.Type == bson.TypeObjectID {
		id := value.ObjectID()
		return id.Hex()
	}
	if text, ok := insightsRawString(value); ok {
		return text
	}
	return ""
}

func insightsLooseString(value bson.RawValue) string {
	if text, ok := insightsRawString(value); ok {
		return strings.TrimSpace(text)
	}
	if value.Type == bson.TypeObjectID {
		return value.ObjectID().Hex()
	}
	return ""
}

func insightsStringOrEmptyFromBSON(value bson.RawValue) string {
	text, ok := insightsRawString(value)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func insightsRawString(value bson.RawValue) (string, bool) {
	if value.Type != bson.TypeString {
		return "", false
	}
	var text string
	if err := value.Unmarshal(&text); err != nil {
		return "", false
	}
	return text, true
}

func insightsRawStringOrEmpty(value bson.RawValue) string {
	text, _ := insightsRawString(value)
	return text
}

func insightsRawStringArray(value bson.RawValue) ([]string, bool) {
	if value.Type != bson.TypeArray {
		return nil, false
	}
	values, err := value.Array().Values()
	if err != nil {
		return []string{}, true
	}
	out := make([]string, 0, len(values))
	for _, entry := range values {
		if entry.Type != bson.TypeString {
			continue
		}
		var text string
		if err := entry.Unmarshal(&text); err != nil {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out, true
}

func insightsRawStringArrayOrEmpty(value bson.RawValue) []string {
	items, _ := insightsRawStringArray(value)
	return items
}

func insightsRawNumber(value bson.RawValue) (float64, bool) {
	switch value.Type {
	case bson.TypeDouble:
		return value.Double(), true
	case bson.TypeInt32:
		return float64(value.Int32()), true
	case bson.TypeInt64:
		return float64(value.Int64()), true
	case bson.TypeDecimal128:
		parsed, err := strconv.ParseFloat(value.Decimal128().String(), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func insightsExtractCategory(tags []string) (analysis.Category, bool) {
	for _, tag := range tags {
		if !strings.HasPrefix(tag, "sm:") {
			continue
		}
		category := analysis.Category(strings.ToLower(strings.TrimSpace(strings.TrimPrefix(tag, "sm:"))))
		for _, candidate := range analysis.Categories {
			if candidate == category {
				return category, true
			}
		}
	}
	return "", false
}

func insightsIsPlaceholderTitle(title string) bool {
	normalized := strings.TrimSpace(insightsTrailingTitlePunct.ReplaceAllString(strings.TrimSpace(title), ""))
	if normalized == "" {
		return true
	}
	return insightsPlaceholderTitle.MatchString(normalized)
}

func insightsFindAlertKeyword(text string) string {
	haystack := strings.ToLower(text)
	for _, keyword := range insightsAlertKeywords {
		if strings.Contains(haystack, keyword) {
			return keyword
		}
	}
	return ""
}

func insightsNormalizeSummary(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	normalized := insightsCollapseWhitespace(trimmed)
	if normalized == "" {
		return nil
	}
	if utf16Length(normalized) <= 240 {
		return &normalized
	}
	clipped := truncateUTF16(normalized, 239)
	clipped = strings.TrimRightFunc(clipped, unicode.IsSpace)
	clipped += "…"
	return &clipped
}

func insightsNormalizeKeyPoints(value bson.RawValue) []string {
	items, ok := insightsRawStringArray(value)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, 3)
	for _, entry := range items {
		normalized := insightsCollapseWhitespace(entry)
		if normalized == "" || containsString(out, normalized) {
			continue
		}
		if utf16Length(normalized) > 180 {
			clipped := strings.TrimRightFunc(truncateUTF16(normalized, 179), unicode.IsSpace) + "…"
			out = append(out, clipped)
		} else {
			out = append(out, normalized)
		}
		if len(out) >= 3 {
			break
		}
	}
	return out
}

func insightsNormalizeTopics(value bson.RawValue) []string {
	items, ok := insightsRawStringArray(value)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, 6)
	for _, entry := range items {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" || containsString(out, trimmed) {
			continue
		}
		out = append(out, trimmed)
		if len(out) >= 6 {
			break
		}
	}
	return out
}

func insightsNormalizeEntities(value bson.RawValue) []string {
	if value.Type != bson.TypeArray {
		return []string{}
	}
	values, err := value.Array().Values()
	if err != nil {
		return []string{}
	}
	out := make([]string, 0, 8)
	for _, entry := range values {
		if entry.Type != bson.TypeEmbeddedDocument {
			continue
		}
		document := entry.Document()
		nameValue := document.Lookup("name")
		name, ok := insightsRawString(nameValue)
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" || containsString(out, name) {
			continue
		}
		out = append(out, name)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

func insightsCollapseWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func insightsTryDomain(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func insightsStringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func firstInsightsNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// truncateUTF16 returns at most limit UTF-16 code units. A surrogate pair that
// would be split is dropped whole: JavaScript slice(0, limit) can produce a
// lone surrogate, but emitting one from Go would require invalid UTF-8. The
// difference only appears when an emoji straddles the boundary.
func truncateUTF16(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	var builder strings.Builder
	units := 0
	for _, r := range value {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > limit {
			break
		}
		builder.WriteRune(r)
		units += width
	}
	return builder.String()
}
