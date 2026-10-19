package archivereading

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

const (
	processedItemsCollection       = "processeditems"
	displaySignalCacheTTL          = 5 * time.Minute
	displaySignalCacheMax          = 200
	newsEventSourcePolicyKeyPrefix = "news_event_source_policy:"
)

// contentType is the closed news content-type set.
type contentType string

const (
	contentTypeNewsFact contentType = "news_fact"
	contentTypeOpinion  contentType = "opinion"
	contentTypeAnalysis contentType = "analysis"
	contentTypeMixed    contentType = "mixed"
)

// contentTypeAliases mirrors CONTENT_TYPE_ALIASES after sanitizeToken.
var contentTypeAliases = map[string]contentType{
	"news_fact": contentTypeNewsFact, "news-fact": contentTypeNewsFact, "newsfact": contentTypeNewsFact,
	"fact": contentTypeNewsFact, "factual": contentTypeNewsFact, "report": contentTypeNewsFact,
	"reporting": contentTypeNewsFact, "hard_news": contentTypeNewsFact, "straight_news": contentTypeNewsFact,
	"新闻事实": contentTypeNewsFact, "事实": contentTypeNewsFact, "事实报道": contentTypeNewsFact,
	"资讯": contentTypeNewsFact, "快讯": contentTypeNewsFact,
	"opinion": contentTypeOpinion, "op-ed": contentTypeOpinion, "oped": contentTypeOpinion,
	"editorial": contentTypeOpinion, "commentary": contentTypeOpinion, "观点": contentTypeOpinion,
	"评论": contentTypeOpinion, "社论": contentTypeOpinion, "专栏": contentTypeOpinion,
	"analysis": contentTypeAnalysis, "analytical": contentTypeAnalysis, "explainer": contentTypeAnalysis,
	"deep_dive": contentTypeAnalysis, "解读": contentTypeAnalysis, "分析": contentTypeAnalysis,
	"研判": contentTypeAnalysis, "复盘": contentTypeAnalysis,
	"mixed": contentTypeMixed, "hybrid": contentTypeMixed, "mixed_content": contentTypeMixed,
	"mixed-content": contentTypeMixed, "综合": contentTypeMixed, "混合": contentTypeMixed,
	"事实+观点": contentTypeMixed, "fact_and_opinion": contentTypeMixed,
}

var (
	opinionKeywords  = []string{"opinion", "op-ed", "editorial", "commentary", "column", "观点", "评论", "社论", "专栏"}
	analysisKeywords = []string{"analysis", "analytical", "explainer", "deep dive", "insight", "解读", "分析", "研判", "复盘", "观察"}
	factKeywords     = []string{"breaking", "report", "update", "announced", "statement", "disclosed", "发布", "通报", "公告", "快讯", "报道"}
	opinionURLHints  = []string{"/opinion", "/commentary", "/editorial", "/op-ed", "/column"}
	analysisURLHints = []string{"/analysis", "/explainer", "/insight", "/deep-dive"}
)

func sanitizeContentTypeToken(value string) string {
	lower := strings.ToLower(strings.TrimSpace(value))
	lower = strings.Join(strings.Fields(lower), "_")
	var builder strings.Builder
	for _, r := range lower {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '+' ||
			(r >= '\u4e00' && r <= '\u9fff') {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func normalizeNewsContentType(value *string) *contentType {
	if value == nil {
		return nil
	}
	normalized := sanitizeContentTypeToken(*value)
	if normalized == "" {
		return nil
	}
	content, ok := contentTypeAliases[normalized]
	if !ok {
		return nil
	}
	return &content
}

// inferNewsContentType ports inferNewsContentType, including the URL hints,
// keyword scores and source bonuses. A score of two is required before a type
// wins; otherwise the item is news_fact.
func inferNewsContentType(title, summary, source, url string, topics, tags []string) contentType {
	title = normalizeLower(title)
	summary = normalizeLower(summary)
	source = normalizeLower(source)
	url = normalizeLower(url)
	normalizedTopics := normalizeTextList(topics)
	normalizedTags := normalizeTextList(tags)
	combined := strings.Join(append(append([]string{title, summary, source}, normalizedTopics...), normalizedTags...), " ")

	opinionScore, analysisScore, factScore := 0, 0, 0
	if includesAny(url, opinionURLHints) {
		opinionScore += 3
	}
	if includesAny(url, analysisURLHints) {
		analysisScore += 3
	}
	opinionScore += countKeywordHits(combined, opinionKeywords)
	analysisScore += countKeywordHits(combined, analysisKeywords)
	factScore += countKeywordHits(combined, factKeywords)
	if includesAny(source, opinionKeywords) {
		opinionScore++
	}
	if includesAny(source, analysisKeywords) {
		analysisScore++
	}

	hasOpinion := opinionScore >= 2
	hasAnalysis := analysisScore >= 2
	hasFact := factScore >= 2
	if (hasOpinion && hasAnalysis) || ((hasOpinion || hasAnalysis) && hasFact) {
		return contentTypeMixed
	}
	if hasOpinion {
		return contentTypeOpinion
	}
	if hasAnalysis {
		return contentTypeAnalysis
	}
	return contentTypeNewsFact
}

func normalizeLower(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func normalizeTextList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := normalizeLower(value)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func includesAny(text string, keywords []string) bool {
	for _, keyword := range keywords {
		if strings.Contains(text, strings.ToLower(keyword)) {
			return true
		}
	}
	return false
}

func countKeywordHits(text string, keywords []string) int {
	hits := 0
	for _, keyword := range keywords {
		if strings.Contains(text, strings.ToLower(keyword)) {
			hits++
		}
	}
	return hits
}

// displaySignals is the ProcessedItem projection used by display eligibility.
type displaySignals struct {
	Exists         bool
	ContentType    *contentType
	CategoryPath   string
	CategoryMethod string
}

type displaySignalEntry struct {
	value     displaySignals
	expiresAt time.Time
}

// displaySignalCache is the 5-minute/200-entry in-memory cache. The key carries
// the organization so two tenants can never share a document's signals.
type displaySignalCache struct {
	mu      sync.Mutex
	entries map[string]displaySignalEntry
	now     func() time.Time
}

func newDisplaySignalCache() *displaySignalCache {
	return &displaySignalCache{entries: map[string]displaySignalEntry{}, now: time.Now}
}

func cacheKey(orgID, processedItemID string) string {
	return orgID + "\x00" + processedItemID
}

func (c *displaySignalCache) get(orgID, processedItemID string) (displaySignals, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[cacheKey(orgID, processedItemID)]
	if !ok {
		return displaySignals{}, false
	}
	if !entry.expiresAt.After(c.now()) {
		delete(c.entries, cacheKey(orgID, processedItemID))
		return displaySignals{}, false
	}
	return entry.value, true
}

func (c *displaySignalCache) put(orgID, processedItemID string, value displaySignals) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= displaySignalCacheMax {
		now := c.now()
		for key, entry := range c.entries {
			if !entry.expiresAt.After(now) {
				delete(c.entries, key)
			}
		}
		if len(c.entries) >= displaySignalCacheMax {
			var oldestKey string
			var oldest time.Time
			for key, entry := range c.entries {
				if oldestKey == "" || entry.expiresAt.Before(oldest) {
					oldestKey = key
					oldest = entry.expiresAt
				}
			}
			if oldestKey != "" {
				delete(c.entries, oldestKey)
			}
		}
	}
	c.entries[cacheKey(orgID, processedItemID)] = displaySignalEntry{
		value:     value,
		expiresAt: c.now().Add(displaySignalCacheTTL),
	}
}

func (c *displaySignalCache) delete(orgID, processedItemID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, cacheKey(orgID, processedItemID))
}

// displayEligibility is one row's display decision plus backfill need.
type displayEligibility struct {
	ShouldDisplay bool
	NeedsBackfill bool
}

// displayStore reads ProcessedItem display signals and the org source policy.
type displayStore struct {
	mongo  *mongo.Database
	policy *policyReader
	cache  *displaySignalCache
}

func newDisplayStore(database *mongo.Database, db *sql.DB) *displayStore {
	return &displayStore{mongo: database, policy: &policyReader{db: db}, cache: newDisplaySignalCache()}
}

// loadSignals fetches the requested ids, conserving the exists/missing
// distinction: an absent document is not a backfill target, while an existing
// document with missing result members is.
func (s *displayStore) loadSignals(ctx context.Context, orgID string, processedItemIDs []string) map[string]displaySignals {
	out := make(map[string]displaySignals, len(processedItemIDs))
	pending := make([]string, 0, len(processedItemIDs))
	seen := make(map[string]struct{}, len(processedItemIDs))
	for _, id := range processedItemIDs {
		if strings.TrimSpace(id) == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		if cached, ok := s.cache.get(orgID, id); ok {
			out[id] = cached
			continue
		}
		pending = append(pending, id)
	}
	if len(pending) == 0 || s.mongo == nil {
		return out
	}

	collection := s.mongo.Collection(processedItemsCollection)
	filter := bson.D{
		{Key: "_id", Value: bson.D{{Key: "$in", Value: pending}}},
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
	}
	cursor, err := collection.Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "result", Value: 1}}))
	found := make(map[string]struct{}, len(pending))
	if err == nil {
		defer cursor.Close(ctx)
		for cursor.Next(ctx) {
			var doc struct {
				ID     any `bson:"_id"`
				Result any `bson:"result"`
			}
			if cursor.Decode(&doc) != nil {
				continue
			}
			id := strings.TrimSpace(toStringValue(doc.ID))
			if id == "" {
				continue
			}
			found[id] = struct{}{}
			signals := extractDisplaySignals(doc.Result)
			out[id] = signals
			s.cache.put(orgID, id, signals)
		}
	}
	missing := displaySignals{Exists: false}
	for _, id := range pending {
		if _, ok := found[id]; ok {
			continue
		}
		out[id] = missing
		s.cache.put(orgID, id, missing)
	}
	return out
}

func extractDisplaySignals(value any) displaySignals {
	var record bson.D
	switch typed := value.(type) {
	case bson.D:
		record = typed
	case bson.M:
		record = make(bson.D, 0, len(typed))
		for key, entry := range typed {
			record = append(record, bson.E{Key: key, Value: entry})
		}
	default:
		return displaySignals{Exists: true}
	}
	get := func(key string) any {
		for _, item := range record {
			if item.Key == key {
				return item.Value
			}
		}
		return nil
	}
	textValue := func(value any) *string {
		text, ok := value.(string)
		if !ok {
			return nil
		}
		return &text
	}
	signals := displaySignals{Exists: true}
	if content, ok := textValue(get("content_type")); ok {
		signals.ContentType = normalizeNewsContentType(content)
	} else if content, ok := textValue(get("contentType")); ok {
		signals.ContentType = normalizeNewsContentType(content)
	}
	signals.CategoryPath = normalizeCategoryPathValue(get("category_path"))
	if signals.CategoryPath == "" {
		signals.CategoryPath = normalizeCategoryPathValue(get("categoryPath"))
	}
	signals.CategoryMethod = normalizeOptionalValue(get("category_method"))
	if signals.CategoryMethod == "" {
		signals.CategoryMethod = normalizeOptionalValue(get("categoryMethod"))
	}
	return signals
}

func normalizeCategoryPathValue(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	normalized := strings.ToLower(strings.TrimSpace(text))
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	normalized = strings.Trim(normalized, "/")
	return normalized
}

func normalizeOptionalValue(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func toStringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

// needsBackfill reports the exact condition: the document exists but has no
// content type, or neither a category path nor a category method.
func needsBackfill(signals displaySignals) bool {
	if !signals.Exists {
		return false
	}
	return signals.ContentType == nil || (signals.CategoryPath == "" && signals.CategoryMethod == "")
}

// resolveEligibilityBatch computes display eligibility for rows using one
// org-scoped source policy and one batched Mongo read.
func (s *displayStore) resolveEligibilityBatch(ctx context.Context, orgID string, rows []*ArchiveRow) map[string]displayEligibility {
	result := make(map[string]displayEligibility, len(rows))
	if len(rows) == 0 {
		return result
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if id := strings.TrimSpace(row.CleanedMarkdownRef); id != "" {
			ids = append(ids, id)
		}
	}
	policyJSON := s.policy.read(ctx, orgID)
	signals := s.loadSignals(ctx, orgID, ids)

	for _, row := range rows {
		sourceLabel := firstNonEmpty(row.Source, row.ArticleSourceLabel)
		sourceURL := row.ArticleURL
		sourceType, _ := publicportal.ClassifyEventSource(sourceLabel, sourceURL, policyJSON)
		processedItemID := strings.TrimSpace(row.CleanedMarkdownRef)
		var signal displaySignals
		if processedItemID != "" {
			signal = signals[processedItemID]
		}
		content := contentTypeNewsFact
		if signal.ContentType != nil {
			content = *signal.ContentType
		} else {
			content = inferNewsContentType(row.Title, row.Summary, sourceLabel, sourceURL, decodeStringArray(row.TopicsJSON), nil)
		}
		result[row.ID] = displayEligibility{
			ShouldDisplay: shouldDisplay(sourceType, content, signal.CategoryPath),
			NeedsBackfill: needsBackfill(signal),
		}
	}
	return result
}

// shouldDisplay excludes blogs and opinion pieces first, then allows the intel
// and politics/geopolitics category trees, and otherwise only news_fact/mixed.
func shouldDisplay(sourceType string, content contentType, categoryPath string) bool {
	if sourceType == "blog" {
		return false
	}
	if content == contentTypeOpinion {
		return false
	}
	if isIntelligenceCategoryPath(categoryPath) {
		return true
	}
	return content == contentTypeNewsFact || content == contentTypeMixed
}

func isIntelligenceCategoryPath(path string) bool {
	if path == "" {
		return false
	}
	return path == "intel" || strings.HasPrefix(path, "intel/") ||
		path == "politics/geopolitics" || strings.HasPrefix(path, "politics/geopolitics/")
}

// policyReader reads one organization's source policy JSON. A read failure or a
// missing row passes nil so publicportal falls back to the Nest default policy.
type policyReader struct {
	db *sql.DB
}

func (r *policyReader) read(ctx context.Context, orgID string) []byte {
	if r == nil || r.db == nil || strings.TrimSpace(orgID) == "" {
		return nil
	}
	var raw []byte
	err := r.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", newsEventSourcePolicyKeyPrefix+orgID).Scan(&raw)
	if err != nil {
		return nil
	}
	return raw
}
