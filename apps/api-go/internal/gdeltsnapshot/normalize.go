package gdeltsnapshot

import (
	"encoding/json"
	"regexp"
	"strings"
)

// placeholderTitlePattern is SNAPSHOT_PLACEHOLDER_TITLE_PATTERN: a headline
// whose title is a placeholder is dropped before it enters the snapshot.
var placeholderTitlePattern = regexp.MustCompile(
	`(?i)^(?:no\s*title|untitled|title\s*unavailable|headline\s*unavailable|n/a|na|null|undefined|暂无标题|无标题|未命名(?:标题)?)$`,
)

// trailingTitlePunctuation is the `[。.!?！？]+$` strip applied before the
// placeholder test, so "Untitled." is treated like "Untitled".
var trailingTitlePunctuation = regexp.MustCompile(`[。.!?！？]+$`)

// rawPayload is the tolerant projection of a stored snapshot document. Every
// member is raw so a document written by an older revision (or a hand-edited
// row) cannot fail the whole decode; NestJS normalizes the same shapes with
// optional chaining and typeof guards.
type rawPayload struct {
	Status              json.RawMessage `json:"status"`
	GeneratedAt         json.RawMessage `json:"generatedAt"`
	ExpiresAt           json.RawMessage `json:"expiresAt"`
	Partial             json.RawMessage `json:"partial"`
	Warnings            json.RawMessage `json:"warnings"`
	Diagnostics         json.RawMessage `json:"diagnostics"`
	CategoryStates      json.RawMessage `json:"categoryStates"`
	HeadlinesByCategory json.RawMessage `json:"headlinesByCategory"`
}

// rawCategoryState is one categoryStates entry.
type rawCategoryState struct {
	Status             json.RawMessage `json:"status"`
	ArticleCount       json.RawMessage `json:"articleCount"`
	ContentGeneratedAt json.RawMessage `json:"contentGeneratedAt"`
	ReasonCode         json.RawMessage `json:"reasonCode"`
}

// rawCategoryStates is the fixed-shape projection of payload.categoryStates.
type rawCategoryStates struct {
	Politics rawCategoryState `json:"politics"`
	Tech     rawCategoryState `json:"tech"`
	Finance  rawCategoryState `json:"finance"`
	Gov      rawCategoryState `json:"gov"`
	AI       rawCategoryState `json:"ai"`
	Intel    rawCategoryState `json:"intel"`
}

// rawHeadlinesByCategory is the fixed-shape projection of
// payload.headlinesByCategory; each member stays raw until it is filtered.
type rawHeadlinesByCategory struct {
	Politics json.RawMessage `json:"politics"`
	Tech     json.RawMessage `json:"tech"`
	Finance  json.RawMessage `json:"finance"`
	Gov      json.RawMessage `json:"gov"`
	AI       json.RawMessage `json:"ai"`
	Intel    json.RawMessage `json:"intel"`
}

// rawDiagnostics is the tolerant projection of payload.diagnostics.
type rawDiagnostics struct {
	RequestedCategories json.RawMessage `json:"requestedCategories"`
	FetchedCategories   json.RawMessage `json:"fetchedCategories"`
	ReusedCategories    json.RawMessage `json:"reusedCategories"`
	FailedCategories    json.RawMessage `json:"failedCategories"`
	TotalHeadlines      json.RawMessage `json:"totalHeadlines"`
}

// normalizePayload mirrors the private normalizePayload of the NestJS service:
// it rejects a document without string timestamps and rebuilds every derived
// member so a caller never sees a partially shaped payload. A nil return means
// "no snapshot".
func normalizePayload(raw []byte) *Payload {
	if len(raw) == 0 || !jsonObject(raw) {
		return nil
	}
	var source rawPayload
	if err := json.Unmarshal(raw, &source); err != nil {
		return nil
	}

	generatedAt, _ := jsonString(source.GeneratedAt)
	expiresAt, _ := jsonString(source.ExpiresAt)
	if generatedAt == "" || expiresAt == "" {
		return nil
	}

	headlinesByCategory := emptyHeadlinesByCategory()
	var rawHeadlines rawHeadlinesByCategory
	if jsonObject(source.HeadlinesByCategory) {
		if err := json.Unmarshal(source.HeadlinesByCategory, &rawHeadlines); err != nil {
			rawHeadlines = rawHeadlinesByCategory{}
		}
	}
	for _, category := range Categories {
		headlinesByCategory.setHeadlines(category, normalizeStoredHeadlines(
			categoryHeadlinesRaw(&rawHeadlines, category), category))
	}

	diagnosticsRaw := rawDiagnosticsOf(source)
	reusedCategories := categorySet(knownCategories(diagnosticsRaw.ReusedCategories))
	categoryStates := emptyCategoryStates()
	var rawStates rawCategoryStates
	if jsonObject(source.CategoryStates) {
		if err := json.Unmarshal(source.CategoryStates, &rawStates); err != nil {
			rawStates = rawCategoryStates{}
		}
	}
	for _, category := range Categories {
		categoryStates.setState(category, normalizeCategoryState(
			categoryStateRaw(&rawStates, category),
			category,
			headlinesByCategory.headlines(category),
			reusedCategories,
			generatedAt,
		))
	}

	return &Payload{
		Source:              sourceName,
		Scope:               scope,
		VariantKey:          variantKey,
		Status:              normalizeStatus(source.Status),
		GeneratedAt:         generatedAt,
		ExpiresAt:           expiresAt,
		Partial:             jsTruthy(source.Partial),
		Warnings:            normalizeWarnings(source.Warnings),
		CategoryStates:      categoryStates,
		Diagnostics:         normalizeDiagnostics(diagnosticsRaw, headlinesByCategory),
		HeadlinesByCategory: headlinesByCategory,
	}
}

// rawDiagnosticsOf decodes the diagnostics member, returning a zero value when
// the document does not carry an object.
func rawDiagnosticsOf(source rawPayload) rawDiagnostics {
	if !jsonObject(source.Diagnostics) {
		return rawDiagnostics{}
	}
	var diagnostics rawDiagnostics
	if err := json.Unmarshal(source.Diagnostics, &diagnostics); err != nil {
		return rawDiagnostics{}
	}
	return diagnostics
}

// categoryHeadlinesRaw returns the raw member of one category.
func categoryHeadlinesRaw(raw *rawHeadlinesByCategory, category Category) json.RawMessage {
	switch category {
	case CategoryPolitics:
		return raw.Politics
	case CategoryTech:
		return raw.Tech
	case CategoryFinance:
		return raw.Finance
	case CategoryGov:
		return raw.Gov
	case CategoryAI:
		return raw.AI
	case CategoryIntel:
		return raw.Intel
	default:
		return nil
	}
}

// categoryStateRaw returns the raw state of one category.
func categoryStateRaw(raw *rawCategoryStates, category Category) rawCategoryState {
	switch category {
	case CategoryPolitics:
		return raw.Politics
	case CategoryTech:
		return raw.Tech
	case CategoryFinance:
		return raw.Finance
	case CategoryGov:
		return raw.Gov
	case CategoryAI:
		return raw.AI
	case CategoryIntel:
		return raw.Intel
	default:
		return rawCategoryState{}
	}
}

// normalizeStoredHeadlines keeps the object entries of one stored category
// list, forces their category and drops entries that cannot be decoded as a
// headline. NestJS spreads the stored object and overwrites only the category,
// so the seven other fields keep their stored values.
func normalizeStoredHeadlines(raw json.RawMessage, category Category) []Headline {
	elements, ok := jsonArray(raw)
	headlines := make([]Headline, 0, len(elements))
	if !ok {
		return headlines
	}
	for _, element := range elements {
		if !jsonObject(element) {
			continue
		}
		var headline Headline
		if err := json.Unmarshal(element, &headline); err != nil {
			continue
		}
		headline.Category = category
		headlines = append(headlines, headline)
	}
	return headlines
}

// normalizeCategoryState rebuilds one category state exactly like the NestJS
// normalization: an unknown status falls back to fresh/reused/empty from the
// headlines and diagnostics, a missing content timestamp falls back to the
// snapshot timestamp (null for an empty category) and the reason code is
// trimmed.
func normalizeCategoryState(
	raw rawCategoryState,
	category Category,
	headlines []Headline,
	reusedCategories map[Category]bool,
	generatedAt string,
) CategoryState {
	status := ""
	if value, ok := jsonString(raw.Status); ok {
		status = value
	}
	normalizedStatus := status
	switch status {
	case categoryStatusFresh, categoryStatusReused, categoryStatusEmpty:
	default:
		if len(headlines) > 0 {
			if reusedCategories[category] {
				normalizedStatus = categoryStatusReused
			} else {
				normalizedStatus = categoryStatusFresh
			}
		} else {
			normalizedStatus = categoryStatusEmpty
		}
	}

	var contentGeneratedAt *string
	if normalizedStatus != categoryStatusEmpty {
		if value, ok := jsonString(raw.ContentGeneratedAt); ok && value != "" {
			contentGeneratedAt = &value
		} else {
			contentGeneratedAt = &generatedAt
		}
	}

	articleCount := len(headlines)
	if value, ok := jsonNumber(raw.ArticleCount); ok {
		articleCount = int(value)
		if articleCount < 0 {
			articleCount = 0
		}
	}

	state := CategoryState{
		Status:             normalizedStatus,
		ArticleCount:       articleCount,
		ContentGeneratedAt: contentGeneratedAt,
	}
	if reasonCode, ok := jsonString(raw.ReasonCode); ok {
		if trimmed := strings.TrimSpace(reasonCode); trimmed != "" {
			state.ReasonCode = trimmed
		}
	}
	return state
}

// normalizeStatus maps an unknown stored status to completed, matching the
// NestJS default branch.
func normalizeStatus(raw json.RawMessage) Status {
	status, _ := jsonString(raw)
	switch status {
	case string(StatusFailed):
		return StatusFailed
	case string(StatusPartial):
		return StatusPartial
	default:
		return StatusCompleted
	}
}

// normalizeWarnings keeps the object entries of the stored warnings array.
func normalizeWarnings(raw json.RawMessage) []Warning {
	elements, ok := jsonArray(raw)
	warnings := make([]Warning, 0, len(elements))
	if !ok {
		return warnings
	}
	for _, element := range elements {
		if !jsonObject(element) {
			continue
		}
		var warning Warning
		if err := json.Unmarshal(element, &warning); err != nil {
			continue
		}
		warnings = append(warnings, warning)
	}
	return warnings
}

// categorySet turns a category list into a membership set for the state
// fallback.
func categorySet(categories []Category) map[Category]bool {
	members := make(map[Category]bool, len(categories))
	for _, category := range categories {
		members[category] = true
	}
	return members
}

// knownCategories keeps the entries that name a known category, preserving
// duplicates and stored order. It mirrors the NestJS filter over an
// Array.isArray-guarded member.
func knownCategories(raw json.RawMessage) []Category {
	elements, ok := jsonArray(raw)
	known := make([]Category, 0, len(elements))
	if !ok {
		return known
	}
	for _, element := range elements {
		name, isString := jsonString(element)
		if !isString {
			continue
		}
		category := Category(name)
		for _, candidate := range Categories {
			if category == candidate {
				known = append(known, category)
				break
			}
		}
	}
	return known
}

// normalizeDiagnostics rebuilds payload.diagnostics: unknown category names are
// dropped, duplicates and their order are preserved (the NestJS filter does the
// same), and the counts fall back to the derived values.
func normalizeDiagnostics(metadata rawDiagnostics, headlinesByCategory HeadlinesByCategory) Diagnostics {
	requestedCategories := len(Categories)
	if value, ok := jsonNumber(metadata.RequestedCategories); ok {
		requestedCategories = int(value)
	}
	totalHeadlines := 0
	for _, category := range Categories {
		totalHeadlines += len(headlinesByCategory.headlines(category))
	}
	if value, ok := jsonNumber(metadata.TotalHeadlines); ok {
		totalHeadlines = int(value)
	}

	return Diagnostics{
		RequestedCategories: requestedCategories,
		FetchedCategories:   knownCategories(metadata.FetchedCategories),
		ReusedCategories:    knownCategories(metadata.ReusedCategories),
		FailedCategories:    knownCategories(metadata.FailedCategories),
		TotalHeadlines:      totalHeadlines,
	}
}

// normalizeSnapshotHeadlines mirrors normalizeSnapshotHeadlines: drop blank
// titles and links, drop placeholder titles, de-duplicate by link in arrival
// order and cap the list at the per-category limit.
func normalizeSnapshotHeadlines(headlines []Headline, category Category) []Headline {
	seen := make(map[string]struct{}, len(headlines))
	normalized := make([]Headline, 0, len(headlines))
	for _, headline := range headlines {
		title := strings.TrimSpace(headline.Title)
		link := strings.TrimSpace(headline.Link)
		if title == "" || link == "" {
			continue
		}
		stripped := strings.TrimSpace(trailingTitlePunctuation.ReplaceAllString(title, ""))
		if placeholderTitlePattern.MatchString(stripped) {
			continue
		}
		if _, duplicate := seen[link]; duplicate {
			continue
		}
		seen[link] = struct{}{}
		headline.Title = title
		headline.Link = link
		headline.Category = category
		normalized = append(normalized, headline)
		if len(normalized) >= categoryLimit {
			break
		}
	}
	return normalized
}

// cloneHeadlines copies a previous category list so the reused headlines do not
// alias the snapshot that was read.
func cloneHeadlines(headlines []Headline) []Headline {
	cloned := make([]Headline, len(headlines))
	copy(cloned, headlines)
	return cloned
}
