package itemsreading

import "math"

// Constants mirrored from apps/api/src/modules/items/items.shared.ts. Names
// and values must stay in sync with the NestJS source of truth.
const (
	// MaxCursorPageSize is the interactive REST page-size cap.
	MaxCursorPageSize = 50
	// FullTextMinTokenLength is the MySQL FULLTEXT token floor.
	FullTextMinTokenLength = 3
	// MongoMinTokenLength is the Mongo full-text token floor.
	MongoMinTokenLength = 2
	// MaxSearchMatches caps one recall source.
	MaxSearchMatches = 5000
	// LatestProcessedSnapshotBatchSize is the facet snapshot page size.
	LatestProcessedSnapshotBatchSize = 500
	// ItemReadModelHydrateBatchSize is the hydration batch size.
	ItemReadModelHydrateBatchSize = 500
	// DayMs is one day in milliseconds.
	DayMs = 24 * 60 * 60 * 1000
	// MaxFacetOptions caps one facet group.
	MaxFacetOptions = 50
	// ItemsVectorSearchPrefix is the vector candidate cache prefix.
	ItemsVectorSearchPrefix = "__items_vector_search__:"
	// ItemsSearchSuggestionsPrefix is the merged suggestion cache prefix.
	ItemsSearchSuggestionsPrefix = "__items_search_suggestions__:"
	// ItemsSourceSuggestionsPrefix is the source-count snapshot cache prefix.
	ItemsSourceSuggestionsPrefix = "__items_source_suggestions__:"
	// VectorSearchCacheTTLSeconds is the vector candidate cache TTL.
	VectorSearchCacheTTLSeconds = 300
	// VectorSearchMinSimilarity is the cosine similarity floor.
	VectorSearchMinSimilarity = 0.78
	// VectorSearchMaxResults caps returned vector matches.
	VectorSearchMaxResults = 300
	// VectorSearchMaxCandidates caps the Mongo fallback scan.
	VectorSearchMaxCandidates = 1200
	// VectorSearchLookbackDays is the vector recall window.
	VectorSearchLookbackDays = 30
	// SearchSuggestionsCacheTTLSeconds is the merged suggestion TTL.
	SearchSuggestionsCacheTTLSeconds = 60
	// SourceSuggestionsCacheTTLSeconds is the source snapshot TTL.
	SourceSuggestionsCacheTTLSeconds = 180
	// SearchSuggestionsMaxSemanticIDs caps the semantic recall fan-out.
	SearchSuggestionsMaxSemanticIDs = 120
	// SearchSuggestionsMaxSourceScan caps the source-count scan.
	SearchSuggestionsMaxSourceScan = 1000
	// SearchSuggestionsMinSemanticChars is the single-token length that still
	// triggers a semantic recall.
	SearchSuggestionsMinSemanticChars = 6
	// SearchSuggestionsMaxLimit caps the clamped suggestion limit.
	SearchSuggestionsMaxLimit = 25
	// CacheLockTTLMs is the distributed cache lock lease.
	CacheLockTTLMs = 5000
	// CacheLockRetryDelayMs is the lock retry delay.
	CacheLockRetryDelayMs = 50
	// CacheLockMaxWaitMs is the lock acquisition budget.
	CacheLockMaxWaitMs = 2000
	// RssSourceWindowDaysDefault is the rssSources default window.
	RssSourceWindowDaysDefault = 7
	// RssSourceWindowDaysMin is the rssSources lower clamp.
	RssSourceWindowDaysMin = 1
	// RssSourceWindowDaysMax is the rssSources upper clamp.
	RssSourceWindowDaysMax = 30
	// DefaultTargetLanguage is the rssTranslationStatus default.
	DefaultTargetLanguage = "zh-CN"
	// DefaultSuggestionLimit is the searchSuggestions default limit.
	DefaultSuggestionLimit = 10
)

// isNaN reports whether a float is NaN.
func isNaN(value float64) bool { return math.IsNaN(value) }

// isInf reports whether a float is infinite.
func isInf(value float64) bool { return math.IsInf(value, 0) }

// truncate mirrors Math.trunc for finite values.
func truncate(value float64) float64 { return math.Trunc(value) }

// ClampInt clamps an integer to [min,max].
func ClampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
