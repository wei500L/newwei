package newsnowhottest

import (
	"context"
	"sort"
	"time"
)

// H1 fix and O1 optimization live in this file.
//
// NestJS resolveMatches calls NewsAggregatorService.resolveByUrl, whose uncached
// path picks the newest rawitems row for a URL without an org predicate and then
// returns the itemMetaId/eventId of whichever organization owns that row. A
// NewsNow projection is built per organization, so that leaked another tenant's
// item and event (and prevented auto-bridge because matchedItemId was set).
//
// The matcher below keeps the five-stage priority of the original lookup but, in
// every stage, only accepts rows whose ItemMeta.orgId equals the caller's
// organization, newest first. Downstream ProcessedItem and NewsEventItem reads
// are scoped to the same organization. The public /resolve endpoint and
// newsnowclusteringops keep their global semantics.
//
// O1: the four comparable stages are resolved with one Mongo aggregation per
// stage using $topN (Mongo 7.0, already used by analysisruns) so each URL keeps
// its twenty newest candidates; ItemMeta ownership is checked with one MySQL
// IN query per stage; ProcessedItem and NewsEventItem reads are batched. The
// twenty-candidate cap matches the limit(20) of the ProcessedItem read and
// bounds the memory of one projection refresh to 96 URLs * 20 rows.

// MatchField is one rawitems field used by a comparable match stage.
type MatchField string

const (
	// MatchFieldFullHash is the level-1 urlComparableFullHash index.
	MatchFieldFullHash MatchField = "urlComparableFullHash"
	// MatchFieldFull is the level-2 urlComparableFull index.
	MatchFieldFull MatchField = "urlComparableFull"
	// MatchFieldPayloadURL is the level-3 legacy payload.url exact match.
	MatchFieldPayloadURL MatchField = "payload.url"
	// MatchFieldBase is the level-4 urlComparableBase index.
	MatchFieldBase MatchField = "urlComparableBase"
)

// RawItemRow is one rawitems projection of the matcher.
type RawItemRow struct {
	ItemMetaID string
	PayloadURL string
	FullHash   string
	Full       string
	Base       string
	CreatedAt  time.Time
}

// EventRow is one NewsEventItem link ordered by createdAt.
type EventRow struct {
	ProcessedItemID string
	EventID         string
	CreatedAt       time.Time
}

// MatchStore is the Mongo/MySQL read surface of the organization matcher.
type MatchStore interface {
	// FindTopRawItems returns up to maxResolveCandidatesPerStage newest rows per
	// key of the given field.
	FindTopRawItems(ctx context.Context, field MatchField, keys []string) ([]RawItemRow, error)
	// FindTopRawItemsByPayloadPattern returns the newest rows matching the
	// case-insensitive payload.url regex.
	FindTopRawItemsByPayloadPattern(ctx context.Context, pattern string) ([]RawItemRow, error)
	// FindItemMetaOrgs resolves the owning organization of the given ItemMeta
	// ids. Missing rows are absent from the result.
	FindItemMetaOrgs(ctx context.Context, itemMetaIDs []string) (map[string]string, error)
	// FindCompletedProcessedItemIDs returns the newest completed ProcessedItem
	// ids of one organization per itemMetaId, at most twenty each.
	FindCompletedProcessedItemIDs(ctx context.Context, orgID string, itemMetaIDs []string) (map[string][]string, error)
	// FindEventRows returns every NewsEventItem link of one organization whose
	// processedItemId is requested. The caller sorts and picks the newest.
	FindEventRows(ctx context.Context, orgID string, processedItemIDs []string) ([]EventRow, error)
}

type orgMatcher struct {
	store MatchStore
}

// NewOrgMatcher builds the organization-scoped matcher.
func NewOrgMatcher(store MatchStore) OrgMatcher { return &orgMatcher{store: store} }

// matchTarget is one URL being resolved.
type matchTarget struct {
	url        string
	full       string
	fullHash   string
	base       string
	matched    bool
	itemMetaID string
}

// ResolveOrgMatches resolves every URL against the caller's organization only.
func (m *orgMatcher) ResolveOrgMatches(ctx context.Context, orgID string, rawURLs []string) (map[string]OrgMatch, error) {
	targets := make([]*matchTarget, 0, len(rawURLs))
	seen := make(map[string]struct{}, len(rawURLs))
	for _, rawURL := range rawURLs {
		url := jsTrim(rawURL)
		variants, ok := comparableURLVariants(url)
		if !ok {
			// resolveByUrl returns matched:false without touching the database
			// when the URL is not a parseable http(s) URL.
			continue
		}
		if _, exists := seen[variants.Full]; exists {
			continue
		}
		seen[variants.Full] = struct{}{}
		targets = append(targets, &matchTarget{
			url:      url,
			full:     variants.Full,
			fullHash: variants.FullHash,
			base:     variants.Base,
		})
	}

	stages := []struct {
		field  MatchField
		keysOf func(*matchTarget) []string
		accept func(*matchTarget, RawItemRow) bool
	}{
		{
			field: MatchFieldFullHash,
			keysOf: func(target *matchTarget) []string {
				if target.fullHash == "" {
					return nil
				}
				return []string{target.fullHash}
			},
			// The NestJS filter requires the hash AND the comparable full URL, so
			// a hash collision must not produce a match.
			accept: func(target *matchTarget, row RawItemRow) bool {
				return row.Full == target.full
			},
		},
		{
			field:  MatchFieldFull,
			keysOf: func(target *matchTarget) []string { return []string{target.full} },
			accept: func(*matchTarget, RawItemRow) bool { return true },
		},
		{
			field: MatchFieldPayloadURL,
			keysOf: func(target *matchTarget) []string {
				values := make([]string, 0, 2)
				if target.url != "" {
					values = append(values, target.url)
				}
				if target.full != "" && target.full != target.url {
					values = append(values, target.full)
				}
				return values
			},
			accept: func(*matchTarget, RawItemRow) bool { return true },
		},
		{
			field:  MatchFieldBase,
			keysOf: func(target *matchTarget) []string { return []string{target.base} },
			accept: func(*matchTarget, RawItemRow) bool { return true },
		},
	}

	for _, stage := range stages {
		if err := m.runComparableStage(ctx, orgID, stage.field, stage.keysOf, stage.accept, targets); err != nil {
			return nil, err
		}
	}
	if err := m.runPatternStage(ctx, orgID, targets); err != nil {
		return nil, err
	}

	return m.loadEvents(ctx, orgID, targets)
}

// runComparableStage resolves one comparable stage for every still-unmatched
// target, then records the newest organization-owned candidate per target.
func (m *orgMatcher) runComparableStage(
	ctx context.Context,
	orgID string,
	field MatchField,
	keysOf func(*matchTarget) []string,
	accept func(*matchTarget, RawItemRow) bool,
	targets []*matchTarget,
) error {
	keyTargets := make(map[string][]int, len(targets))
	keys := make([]string, 0, len(targets))
	for index, target := range targets {
		if target.matched {
			continue
		}
		for _, key := range uniqueStrings(keysOf(target)) {
			if key == "" {
				continue
			}
			if _, exists := keyTargets[key]; !exists {
				keys = append(keys, key)
			}
			keyTargets[key] = append(keyTargets[key], index)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	rows, err := m.store.FindTopRawItems(ctx, field, keys)
	if err != nil {
		return err
	}
	candidates := make([][]RawItemRow, len(targets))
	for _, row := range rows {
		stageKey := rowStageKey(field, row)
		for _, targetIndex := range keyTargets[stageKey] {
			target := targets[targetIndex]
			if target.matched || !accept(target, row) {
				continue
			}
			if len(candidates[targetIndex]) >= maxResolveCandidatesPerStage {
				continue
			}
			candidates[targetIndex] = append(candidates[targetIndex], row)
		}
	}
	return m.recordStageHits(ctx, orgID, targets, candidates)
}

// recordStageHits checks ItemMeta ownership in one query and records the newest
// owned candidate of each target.
func (m *orgMatcher) recordStageHits(ctx context.Context, orgID string, targets []*matchTarget, candidates [][]RawItemRow) error {
	itemMetaIDs := make([]string, 0, len(targets))
	seenIDs := make(map[string]struct{}, len(targets))
	needsLookup := false
	for index, rows := range candidates {
		if targets[index].matched || len(rows) == 0 {
			continue
		}
		needsLookup = true
		sortRawRowsNewestFirst(rows)
		for _, row := range rows {
			if row.ItemMetaID == "" {
				continue
			}
			if _, exists := seenIDs[row.ItemMetaID]; exists {
				continue
			}
			seenIDs[row.ItemMetaID] = struct{}{}
			itemMetaIDs = append(itemMetaIDs, row.ItemMetaID)
		}
	}
	if !needsLookup || len(itemMetaIDs) == 0 {
		return nil
	}
	orgs, err := m.store.FindItemMetaOrgs(ctx, itemMetaIDs)
	if err != nil {
		return err
	}
	for index, rows := range candidates {
		if targets[index].matched {
			continue
		}
		for _, row := range rows {
			if orgs[row.ItemMetaID] != orgID {
				continue
			}
			targets[index].matched = true
			targets[index].itemMetaID = row.ItemMetaID
			break
		}
	}
	return nil
}

// runPatternStage performs the level-5 regex lookup per URL and records the hits.
// Only targets still unmatched after the four comparable stages execute.
func (m *orgMatcher) runPatternStage(ctx context.Context, orgID string, targets []*matchTarget) error {
	candidates := make([][]RawItemRow, len(targets))
	needsLookup := false
	for index, target := range targets {
		if target.matched {
			continue
		}
		rows, err := m.store.FindTopRawItemsByPayloadPattern(ctx, resolveFallbackPattern(target.base))
		if err != nil {
			// NestJS catches a resolve failure per signal and records a miss; keep
			// the same best-effort behaviour for this stage.
			continue
		}
		if len(rows) > maxResolveCandidatesPerStage {
			rows = rows[:maxResolveCandidatesPerStage]
		}
		sortRawRowsNewestFirst(rows)
		candidates[index] = rows
		if len(rows) > 0 {
			needsLookup = true
		}
	}
	if !needsLookup {
		return nil
	}
	return m.recordStageHits(ctx, orgID, targets, candidates)
}

// loadEvents attaches the organization's ProcessedItem and NewsEventItem data to
// every matched target (batched reads).
func (m *orgMatcher) loadEvents(ctx context.Context, orgID string, targets []*matchTarget) (map[string]OrgMatch, error) {
	resolved := make(map[string]OrgMatch, len(targets))
	itemMetaIDs := make([]string, 0, len(targets))
	for _, target := range targets {
		if !target.matched || target.itemMetaID == "" {
			continue
		}
		resolved[target.url] = OrgMatch{ItemID: target.itemMetaID}
		itemMetaIDs = append(itemMetaIDs, target.itemMetaID)
	}
	if len(itemMetaIDs) == 0 {
		return resolved, nil
	}
	processedByItem, err := m.store.FindCompletedProcessedItemIDs(ctx, orgID, uniqueStrings(itemMetaIDs))
	if err != nil {
		return nil, err
	}
	processedIDs := make([]string, 0, len(processedByItem)*maxResolveCandidatesPerStage)
	for _, ids := range processedByItem {
		processedIDs = append(processedIDs, ids...)
	}
	if len(processedIDs) == 0 {
		return resolved, nil
	}
	processedOwner := make(map[string]string, len(processedIDs))
	for itemMetaID, ids := range processedByItem {
		for _, processedID := range ids {
			processedOwner[processedID] = itemMetaID
		}
	}
	rows, err := m.store.FindEventRows(ctx, orgID, processedIDs)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(rows, func(left, right int) bool {
		return rows[left].CreatedAt.After(rows[right].CreatedAt)
	})
	eventByItem := make(map[string]string, len(processedByItem))
	for _, row := range rows {
		itemMetaID := processedOwner[row.ProcessedItemID]
		if itemMetaID == "" {
			continue
		}
		if _, exists := eventByItem[itemMetaID]; exists {
			continue
		}
		if row.EventID == "" {
			continue
		}
		eventByItem[itemMetaID] = row.EventID
	}
	for _, target := range targets {
		if !target.matched {
			continue
		}
		match := resolved[target.url]
		match.ItemID = target.itemMetaID
		if eventID := eventByItem[target.itemMetaID]; eventID != "" {
			match.EventID = eventID
		}
		resolved[target.url] = match
	}
	return resolved, nil
}

// rowStageKey is the value of the stage field on one row.
func rowStageKey(field MatchField, row RawItemRow) string {
	switch field {
	case MatchFieldFullHash:
		return row.FullHash
	case MatchFieldFull:
		return row.Full
	case MatchFieldPayloadURL:
		return row.PayloadURL
	case MatchFieldBase:
		return row.Base
	default:
		return ""
	}
}

// sortRawRowsNewestFirst is the createdAt descending order of every lookup.
func sortRawRowsNewestFirst(rows []RawItemRow) {
	sort.SliceStable(rows, func(left, right int) bool {
		return rows[left].CreatedAt.After(rows[right].CreatedAt)
	})
}
