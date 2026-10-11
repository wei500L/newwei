package contentcatalog

import "time"

const (
	day = 24 * time.Hour

	catalogWindowDays     = 90
	catalogMinCount       = 2
	catalogSyncTTL        = 6 * time.Hour
	catalogLockTTL        = 15 * time.Minute
	catalogLockRetry      = 250 * time.Millisecond
	catalogMaxPerKind     = 240
	catalogPersistBatch   = 64
	catalogListLimit      = 200
	keywordDocLimit       = catalogMaxPerKind * 40
	keywordMaxTermsPerDoc = 24
	uncategorizedFilter   = "__uncategorized__"
	embeddingBatchSize    = 64
	recommendationLimit   = 12
	recommendationPool    = 48
	relatedTopicLimit     = 8
	relatedTopicPool      = 36

	processedItemsCollection = "processeditems"
	catalogSyncKeyPrefix     = "content-subscription:catalog-sync:"
	taxonomyCachePrefix      = "newsClassification:settings:"
	taxonomySettingPrefix    = "news_classification_settings:"
	taxonomyCacheTTL         = 60 * time.Second
	defaultTaxonomyVersion   = "news-taxonomy-v1"
)

var keywordStopWords = map[string]struct{}{
	"about": {}, "across": {}, "after": {}, "amid": {}, "and": {}, "are": {},
	"before": {}, "been": {}, "but": {}, "for": {}, "from": {}, "has": {},
	"have": {}, "her": {}, "his": {}, "into": {}, "its": {}, "less": {},
	"more": {}, "new": {}, "not": {}, "our": {}, "over": {}, "said": {},
	"says": {}, "that": {}, "the": {}, "their": {}, "they": {}, "this": {},
	"under": {}, "via": {}, "was": {}, "were": {}, "will": {}, "with": {},
	"you": {}, "your": {}, "报道": {}, "新闻": {},
}

var catalogKinds = []string{"topic", "entity", "source", "keyword", "geo"}
