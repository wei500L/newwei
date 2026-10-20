package gdeltsnapshot

import "time"

// Snapshot identity. The snapshot is global: it carries no organization or
// tenant dimension, exactly like the NestJS constants.
const (
	scope      = "gdelt_global"
	variantKey = "default"
	sourceName = "scheduler"

	// refreshIntervalMinutes is the wall-clock cadence ("0 */15 * * * *").
	refreshIntervalMinutes = 15
	// historyRetentionDays is the prune window for SituationMonitorExternalSnapshot.
	historyRetentionDays = 7
	// categoryLimit caps one category's headlines per snapshot.
	categoryLimit = 20
	// categoryFetchDelay is the fixed pause between two category requests. The
	// last category is not followed by a pause.
	categoryFetchDelay = 5500 * time.Millisecond
	// fetchTimeout bounds one GDELT attempt.
	fetchTimeout = 20 * time.Second
	// freshTTL is the Redis TTL of the fresh cache entry (20 minutes).
	freshTTL = 20 * time.Minute
	// staleTTL is the Redis TTL of the stale cache entry (24 hours).
	staleTTL = 24 * time.Hour
	// lockTTL is the lease length of the shared rebuild lock (10 minutes).
	lockTTL = 10 * time.Minute
)

// Redis keys. The fresh/stale pairs are the NestJS CacheService keys verbatim;
// the lock key is the NestJS logical key (CacheService adds the "lock:" prefix
// when it acquires the lease).
const (
	freshCacheKey  = "situation-monitor:external-snapshot:gdelt:fresh:v1"
	staleCacheKey  = "situation-monitor:external-snapshot:gdelt:stale:v1"
	refreshLockKey = "cron:situation-monitor:external-snapshot:gdelt"
)

// Category is one situation-monitor headline bucket. The declaration order of
// Categories is the request order and the order of categoryStates /
// headlinesByCategory in the payload.
type Category string

const (
	CategoryPolitics Category = "politics"
	CategoryTech     Category = "tech"
	CategoryFinance  Category = "finance"
	CategoryGov      Category = "gov"
	CategoryAI       Category = "ai"
	CategoryIntel    Category = "intel"
)

// Categories mirrors SITUATION_MONITOR_CATEGORIES.
var Categories = []Category{
	CategoryPolitics,
	CategoryTech,
	CategoryFinance,
	CategoryGov,
	CategoryAI,
	CategoryIntel,
}

// Status is the situation-monitor external snapshot status enum.
type Status string

const (
	StatusCompleted Status = "completed"
	StatusPartial   Status = "partial"
	StatusFailed    Status = "failed"
)

// Category status values used by categoryStates[].status.
const (
	categoryStatusFresh  = "fresh"
	categoryStatusReused = "reused"
	categoryStatusEmpty  = "empty"
)

// Warning is one entry of payload.warnings. The NestJS type carries exactly
// these four members; detail is optional and omitted when empty, matching
// JSON.stringify dropping an undefined property.
type Warning struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Detail   string `json:"detail,omitempty"`
}

// Warning severities and codes. The codes are part of the API contract: they
// are returned in the status summary and are read by the insights chain.
const (
	severityInfo    = "info"
	severityWarning = "warning"

	codeRateLimited = "gdelt_rate_limited"
	codeHTTPError   = "gdelt_http_error"
	codeFetchFailed = "gdelt_fetch_failed"
	codeEmpty       = "gdelt_empty"
)

// Headline is one GDELT article stored in the snapshot. Field order is the
// NestJS construction order (id, title, link, source, timestamp, category,
// origin, isAlert) so a Go-written payload serializes like a NestJS one.
type Headline struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Link      string   `json:"link"`
	Source    string   `json:"source"`
	Timestamp int64    `json:"timestamp"`
	Category  Category `json:"category"`
	Origin    string   `json:"origin"`
	IsAlert   bool     `json:"isAlert"`
}

// headlineOrigin is the origin every GDELT headline carries.
const headlineOrigin = "gdelt"

// CategoryState is one entry of payload.categoryStates.
type CategoryState struct {
	Status             string  `json:"status"`
	ArticleCount       int     `json:"articleCount"`
	ContentGeneratedAt *string `json:"contentGeneratedAt"`
	ReasonCode         string  `json:"reasonCode,omitempty"`
}

// CategoryStates is a fixed-shape map keyed by Category. A struct is used
// instead of a map so the serialized key order is deterministic and matches the
// NestJS literal.
type CategoryStates struct {
	Politics CategoryState `json:"politics"`
	Tech     CategoryState `json:"tech"`
	Finance  CategoryState `json:"finance"`
	Gov      CategoryState `json:"gov"`
	AI       CategoryState `json:"ai"`
	Intel    CategoryState `json:"intel"`
}

// HeadlinesByCategory is the fixed-shape per-category headline list.
type HeadlinesByCategory struct {
	Politics []Headline `json:"politics"`
	Tech     []Headline `json:"tech"`
	Finance  []Headline `json:"finance"`
	Gov      []Headline `json:"gov"`
	AI       []Headline `json:"ai"`
	Intel    []Headline `json:"intel"`
}

// Diagnostics is payload.diagnostics.
type Diagnostics struct {
	RequestedCategories int        `json:"requestedCategories"`
	FetchedCategories   []Category `json:"fetchedCategories"`
	ReusedCategories    []Category `json:"reusedCategories"`
	FailedCategories    []Category `json:"failedCategories"`
	TotalHeadlines      int        `json:"totalHeadlines"`
}

// Payload is the stored snapshot document. The field order is the NestJS object
// literal order in rebuildSnapshot and is part of the cache/history contract.
type Payload struct {
	Source              string              `json:"source"`
	Scope               string              `json:"scope"`
	VariantKey          string              `json:"variantKey"`
	Status              Status              `json:"status"`
	GeneratedAt         string              `json:"generatedAt"`
	ExpiresAt           string              `json:"expiresAt"`
	Partial             bool                `json:"partial"`
	Warnings            []Warning           `json:"warnings"`
	Diagnostics         Diagnostics         `json:"diagnostics"`
	CategoryStates      CategoryStates      `json:"categoryStates"`
	HeadlinesByCategory HeadlinesByCategory `json:"headlinesByCategory"`
}

// Summary is SituationMonitorExternalSnapshotStatusSummary. The field order and
// the nullable fields match the NestJS return type; numbers are pointers so a
// null rolling metric stays null instead of becoming zero.
type Summary struct {
	Enabled                                 bool      `json:"enabled"`
	IntervalMinutes                         int       `json:"intervalMinutes"`
	HistoryRetentionDays                    int       `json:"historyRetentionDays"`
	Status                                  string    `json:"status"`
	Stale                                   bool      `json:"stale"`
	Partial                                 bool      `json:"partial"`
	GeneratedAt                             *string   `json:"generatedAt"`
	ExpiresAt                               *string   `json:"expiresAt"`
	LastFullSuccessAt                       *string   `json:"lastFullSuccessAt"`
	LastNonSuccessAt                        *string   `json:"lastNonSuccessAt"`
	NextScheduledAt                         *string   `json:"nextScheduledAt"`
	WarningCount                            int       `json:"warningCount"`
	AvailableCategoryCount                  int       `json:"availableCategoryCount"`
	Rolling24hSuccessRate                   *float64  `json:"rolling24hSuccessRate"`
	Rolling24hRateLimitedCount              int       `json:"rolling24hRateLimitedCount"`
	Rolling24hAverageAvailableCategoryCount *float64  `json:"rolling24hAverageAvailableCategoryCount"`
	Warnings                                []Warning `json:"warnings"`
}

// readResult is the payload + staleness pair readSnapshot returns.
type readResult struct {
	payload *Payload
	stale   bool
}

// headlines returns the stored headlines of one category, or nil when there is
// no previous snapshot. It replaces the NestJS optional chain
// `previous.payload?.headlinesByCategory[category] ?? []`.
func (r readResult) headlines(category Category) []Headline {
	if r.payload == nil {
		return nil
	}
	return r.payload.HeadlinesByCategory.headlines(category)
}

// emptyHeadlinesByCategory builds the all-empty headline map. Slices are
// allocated so the payload serializes [] instead of null.
func emptyHeadlinesByCategory() HeadlinesByCategory {
	return HeadlinesByCategory{
		Politics: make([]Headline, 0),
		Tech:     make([]Headline, 0),
		Finance:  make([]Headline, 0),
		Gov:      make([]Headline, 0),
		AI:       make([]Headline, 0),
		Intel:    make([]Headline, 0),
	}
}

// emptyCategoryStates builds the all-empty state map (status empty, zero
// articles, null content timestamp).
func emptyCategoryStates() CategoryStates {
	empty := CategoryState{Status: categoryStatusEmpty, ArticleCount: 0}
	return CategoryStates{
		Politics: empty,
		Tech:     empty,
		Finance:  empty,
		Gov:      empty,
		AI:       empty,
		Intel:    empty,
	}
}

// headlines returns the headline slice of one category.
func (h *HeadlinesByCategory) headlines(category Category) []Headline {
	switch category {
	case CategoryPolitics:
		return h.Politics
	case CategoryTech:
		return h.Tech
	case CategoryFinance:
		return h.Finance
	case CategoryGov:
		return h.Gov
	case CategoryAI:
		return h.AI
	case CategoryIntel:
		return h.Intel
	default:
		return nil
	}
}

// setHeadlines replaces the headline slice of one category.
func (h *HeadlinesByCategory) setHeadlines(category Category, headlines []Headline) {
	switch category {
	case CategoryPolitics:
		h.Politics = headlines
	case CategoryTech:
		h.Tech = headlines
	case CategoryFinance:
		h.Finance = headlines
	case CategoryGov:
		h.Gov = headlines
	case CategoryAI:
		h.AI = headlines
	case CategoryIntel:
		h.Intel = headlines
	}
}

// state returns one category state.
func (s *CategoryStates) state(category Category) CategoryState {
	switch category {
	case CategoryPolitics:
		return s.Politics
	case CategoryTech:
		return s.Tech
	case CategoryFinance:
		return s.Finance
	case CategoryGov:
		return s.Gov
	case CategoryAI:
		return s.AI
	case CategoryIntel:
		return s.Intel
	default:
		return CategoryState{}
	}
}

// setState replaces one category state.
func (s *CategoryStates) setState(category Category, state CategoryState) {
	switch category {
	case CategoryPolitics:
		s.Politics = state
	case CategoryTech:
		s.Tech = state
	case CategoryFinance:
		s.Finance = state
	case CategoryGov:
		s.Gov = state
	case CategoryAI:
		s.AI = state
	case CategoryIntel:
		s.Intel = state
	}
}
