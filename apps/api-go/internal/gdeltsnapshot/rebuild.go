package gdeltsnapshot

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"
)

// warningGroup is one aggregated warning: the first warning seen for a code plus
// the categories and the details collected afterwards. The NestJS
// implementation uses a Map of Sets; the insertion order of the groups and of
// the details is the same.
type warningGroup struct {
	warning    Warning
	categories []Category
	details    []string
	detailSet  map[string]struct{}
}

// warningGroups aggregates one rebuild's warnings by code.
type warningGroups struct {
	groups []*warningGroup
	byCode map[string]*warningGroup
}

// newWarningGroups returns an empty aggregation. The code set is tiny (at most
// four codes) but a map keeps the lookup O(1) like the NestJS Map.
func newWarningGroups() *warningGroups {
	return &warningGroups{byCode: make(map[string]*warningGroup, 4)}
}

// collect adds one category warning, de-duplicating the category and the detail
// the way the NestJS Sets do.
func (g *warningGroups) collect(category Category, warning Warning) {
	existing, ok := g.byCode[warning.Code]
	if !ok {
		existing = &warningGroup{warning: warning, detailSet: make(map[string]struct{})}
		g.byCode[warning.Code] = existing
		g.groups = append(g.groups, existing)
	}
	alreadyListed := false
	for _, candidate := range existing.categories {
		if candidate == category {
			alreadyListed = true
			break
		}
	}
	if !alreadyListed {
		existing.categories = append(existing.categories, category)
	}
	if warning.Detail == "" {
		return
	}
	if _, seen := existing.detailSet[warning.Detail]; seen {
		return
	}
	existing.detailSet[warning.Detail] = struct{}{}
	existing.details = append(existing.details, warning.Detail)
}

// warnings renders the aggregated groups in first-seen order with the merged
// detail.
func (g *warningGroups) warnings() []Warning {
	rendered := make([]Warning, 0, len(g.groups))
	for _, group := range g.groups {
		warning := group.warning
		warning.Detail = formatWarningDetail(group.categories, group.details)
		rendered = append(rendered, warning)
	}
	return rendered
}

// formatWarningDetail mirrors formatWarningDetail: the categories in canonical
// order, then the details joined by " | ", joined by ". ".
func formatWarningDetail(categories []Category, details []string) string {
	parts := make([]string, 0, 2)
	ordered := make([]string, 0, len(categories))
	for _, candidate := range Categories {
		for _, category := range categories {
			if category == candidate {
				ordered = append(ordered, string(candidate))
				break
			}
		}
	}
	if len(ordered) > 0 {
		parts = append(parts, "Categories: "+strings.Join(ordered, ", "))
	}
	if len(details) > 0 {
		parts = append(parts, strings.Join(details, " | "))
	}
	return strings.Join(parts, ". ")
}

// rebuild is the Go counterpart of rebuildSnapshot. It reads the previous
// snapshot (cache layers and database), fetches the six categories in order,
// normalizes every category into fresh/reused/empty, aggregates the warnings and
// derives the snapshot status, then persists the history row and both cache
// layers before pruning the retention window.
func (s *Service) rebuild(ctx context.Context) (*Payload, error) {
	previous, err := s.readSnapshot(ctx)
	if err != nil {
		return nil, err
	}

	headlinesByCategory := emptyHeadlinesByCategory()
	categoryStates := emptyCategoryStates()
	groups := newWarningGroups()
	fetchedCategories := make([]Category, 0, len(Categories))
	reusedCategories := make([]Category, 0, len(Categories))
	failedCategories := make([]Category, 0, len(Categories))

	for index, category := range Categories {
		outcome := s.fetch.fetchCategory(ctx, category, categoryLimit)
		if outcome.warning != nil {
			groups.collect(category, *outcome.warning)
		}

		nextHeadlines := normalizeSnapshotHeadlines(outcome.headlines, category)
		if len(nextHeadlines) > 0 {
			headlinesByCategory.setHeadlines(category, nextHeadlines)
			fetchedCategories = append(fetchedCategories, category)
			categoryStates.setState(category, CategoryState{
				Status:       categoryStatusFresh,
				ArticleCount: len(nextHeadlines),
			})
		} else {
			previousHeadlines := previous.headlines(category)
			if outcome.warning != nil && len(previousHeadlines) > 0 {
				headlinesByCategory.setHeadlines(category, cloneHeadlines(previousHeadlines))
				reusedCategories = append(reusedCategories, category)
				categoryStates.setState(category, CategoryState{
					Status:             categoryStatusReused,
					ArticleCount:       len(previousHeadlines),
					ContentGeneratedAt: previousContentGeneratedAt(previous.payload, category),
					ReasonCode:         outcome.warning.Code,
				})
			} else {
				if outcome.warning != nil {
					failedCategories = append(failedCategories, category)
				}
				state := CategoryState{Status: categoryStatusEmpty, ArticleCount: 0}
				if outcome.warning != nil {
					state.ReasonCode = outcome.warning.Code
				}
				categoryStates.setState(category, state)
			}
		}

		// The pause follows every category except the last one, and it never
		// makes the request rate higher than the NestJS implementation's.
		if index < len(Categories)-1 {
			if err := s.sleep(ctx, categoryFetchDelay); err != nil {
				return nil, err
			}
		}
	}

	warnings := groups.warnings()
	totalHeadlines := 0
	for _, category := range Categories {
		totalHeadlines += len(headlinesByCategory.headlines(category))
	}

	status := StatusCompleted
	switch {
	case totalHeadlines == 0 && len(fetchedCategories) == 0 && len(reusedCategories) == 0:
		status = StatusFailed
	case len(warnings) > 0 || len(reusedCategories) > 0 || len(failedCategories) > 0:
		status = StatusPartial
	}

	// Truncate to milliseconds: the payload timestamp is an ISO string with
	// millisecond precision and the MySQL column is DATETIME(3), so both stores
	// keep exactly the value the NestJS Date carries.
	generatedAt := s.now().UTC().Truncate(time.Millisecond)
	generatedAtISO := isoTime(generatedAt)
	for _, category := range Categories {
		state := categoryStates.state(category)
		if state.Status == categoryStatusFresh {
			state.ContentGeneratedAt = &generatedAtISO
			categoryStates.setState(category, state)
		}
	}
	expiresAt := generatedAt.Add(freshTTL)

	payload := &Payload{
		Source:      sourceName,
		Scope:       scope,
		VariantKey:  variantKey,
		Status:      status,
		GeneratedAt: generatedAtISO,
		ExpiresAt:   isoTime(expiresAt),
		Partial:     status != StatusCompleted,
		Warnings:    warnings,
		Diagnostics: Diagnostics{
			RequestedCategories: len(Categories),
			FetchedCategories:   fetchedCategories,
			ReusedCategories:    reusedCategories,
			FailedCategories:    failedCategories,
			TotalHeadlines:      totalHeadlines,
		},
		CategoryStates:      categoryStates,
		HeadlinesByCategory: headlinesByCategory,
	}

	if err := s.persist(ctx, payload, generatedAt, expiresAt); err != nil {
		return nil, err
	}

	log.Printf("gdeltsnapshot: refresh completed status=%s headlines=%d fresh=%d reused=%d failed=%d warnings=%d",
		status, totalHeadlines, len(fetchedCategories), len(reusedCategories), len(failedCategories), len(warnings))
	return payload, nil
}

// previousContentGeneratedAt mirrors the previous snapshot lookup: the category
// timestamp when present, otherwise the previous snapshot timestamp, otherwise
// null.
func previousContentGeneratedAt(previous *Payload, category Category) *string {
	if previous == nil {
		return nil
	}
	state := previous.CategoryStates.state(category)
	if state.ContentGeneratedAt != nil {
		return state.ContentGeneratedAt
	}
	if previous.GeneratedAt == "" {
		return nil
	}
	generatedAt := previous.GeneratedAt
	return &generatedAt
}

// persist writes one history row and both cache layers, then prunes the
// retention window.
//
// The payload is marshalled once and those bytes feed MySQL and both Redis keys,
// so the history row and the two cache values can never drift. NestJS issues the
// insert and the two cache writes with Promise.all; the same two operations run
// concurrently here, and the prune still waits for both.
func (s *Service) persist(ctx context.Context, payload *Payload, generatedAt, expiresAt time.Time) error {
	payloadBytes, err := marshalJSON(payload)
	if err != nil {
		return err
	}
	warningsBytes, err := marshalJSON(payload.Warnings)
	if err != nil {
		return err
	}
	diagnosticsBytes, err := marshalJSON(payload.Diagnostics)
	if err != nil {
		return err
	}
	rowID, err := newRowID()
	if err != nil {
		return err
	}
	row := snapshotRow{
		ID:          rowID,
		Scope:       scope,
		VariantKey:  variantKey,
		Status:      payload.Status,
		Source:      sourceName,
		Payload:     payloadBytes,
		Warnings:    warningsBytes,
		Diagnostics: diagnosticsBytes,
		GeneratedAt: generatedAt,
		ExpiresAt:   expiresAt,
	}

	var insertErr, cacheErr error
	var writes sync.WaitGroup
	writes.Add(2)
	go func() {
		defer writes.Done()
		insertErr = s.store.Insert(ctx, row)
	}()
	go func() {
		defer writes.Done()
		cacheErr = s.cache.SetMany(ctx,
			cacheEntry{key: freshCacheKey, value: payloadBytes, ttl: freshTTL},
			cacheEntry{key: staleCacheKey, value: payloadBytes, ttl: staleTTL},
		)
	}()
	writes.Wait()
	if insertErr != nil {
		return insertErr
	}
	if cacheErr != nil {
		return cacheErr
	}

	cutoff := s.now().UTC().Add(-historyRetentionDays * 24 * time.Hour)
	if _, err := s.store.Prune(ctx, cutoff); err != nil {
		return err
	}
	return nil
}
