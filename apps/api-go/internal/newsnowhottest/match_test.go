package newsnowhottest

import (
	"context"
	"sort"
	"strings"
	"testing"
	"time"
)

// fakeMatchStore implements the matcher read surface in memory. The per-key topN
// behaviour mirrors the $topN aggregation: newest first, at most twenty per key.
type fakeMatchStore struct {
	rows        []RawItemRow
	patternRows map[string][]RawItemRow
	orgs        map[string]string
	processed   map[string][]string
	events      []EventRow
}

func (s *fakeMatchStore) topFor(field MatchField, key string) []RawItemRow {
	out := make([]RawItemRow, 0, 8)
	for _, row := range s.rows {
		if rowStageKey(field, row) != key {
			continue
		}
		out = append(out, row)
	}
	sort.SliceStable(out, func(left, right int) bool { return out[left].CreatedAt.After(out[right].CreatedAt) })
	if len(out) > maxResolveCandidatesPerStage {
		out = out[:maxResolveCandidatesPerStage]
	}
	return out
}

func (s *fakeMatchStore) FindTopRawItems(_ context.Context, field MatchField, keys []string) ([]RawItemRow, error) {
	out := make([]RawItemRow, 0, len(keys)*4)
	for _, key := range keys {
		out = append(out, s.topFor(field, key)...)
	}
	return out, nil
}

func (s *fakeMatchStore) FindTopRawItemsByPayloadPattern(_ context.Context, pattern string) ([]RawItemRow, error) {
	return s.patternRows[pattern], nil
}

func (s *fakeMatchStore) FindItemMetaOrgs(_ context.Context, itemMetaIDs []string) (map[string]string, error) {
	out := make(map[string]string, len(itemMetaIDs))
	for _, id := range itemMetaIDs {
		if org, ok := s.orgs[id]; ok {
			out[id] = org
		}
	}
	return out, nil
}

func (s *fakeMatchStore) FindCompletedProcessedItemIDs(_ context.Context, orgID string, itemMetaIDs []string) (map[string][]string, error) {
	out := make(map[string][]string, len(itemMetaIDs))
	for _, id := range itemMetaIDs {
		if s.orgs[id] != orgID {
			continue
		}
		if ids, ok := s.processed[id]; ok {
			out[id] = append([]string{}, ids...)
		}
	}
	return out, nil
}

func (s *fakeMatchStore) FindEventRows(_ context.Context, orgID string, processedItemIDs []string) ([]EventRow, error) {
	wanted := make(map[string]struct{}, len(processedItemIDs))
	for _, id := range processedItemIDs {
		wanted[id] = struct{}{}
	}
	out := make([]EventRow, 0, len(s.events))
	for _, row := range s.events {
		if _, ok := wanted[row.ProcessedItemID]; ok {
			out = append(out, row)
		}
	}
	return out, nil
}

// referenceResolve is the per-URL NestJS stage order with the H1 organization
// filter applied inside every stage. It is the equivalence oracle for the batched
// matcher.
func referenceResolve(store *fakeMatchStore, orgID, rawURL string) (OrgMatch, bool) {
	variants, ok := comparableURLVariants(rawURL)
	if !ok {
		return OrgMatch{}, false
	}
	pick := func(rows []RawItemRow) (RawItemRow, bool) {
		sort.SliceStable(rows, func(left, right int) bool { return rows[left].CreatedAt.After(rows[right].CreatedAt) })
		for _, row := range rows {
			if store.orgs[row.ItemMetaID] == orgID {
				return row, true
			}
		}
		return RawItemRow{}, false
	}
	stage1 := make([]RawItemRow, 0, 4)
	for _, row := range store.topFor(MatchFieldFullHash, variants.FullHash) {
		if row.Full == variants.Full {
			stage1 = append(stage1, row)
		}
	}
	if row, ok := pick(stage1); ok {
		return referenceWithEvents(store, orgID, rawURL, row)
	}
	if row, ok := pick(store.topFor(MatchFieldFull, variants.Full)); ok {
		return referenceWithEvents(store, orgID, rawURL, row)
	}
	payload := make([]RawItemRow, 0, 8)
	seen := map[string]struct{}{}
	for _, candidate := range []string{rawURL, variants.Full} {
		if candidate == "" {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		payload = append(payload, store.topFor(MatchFieldPayloadURL, candidate)...)
	}
	if row, ok := pick(payload); ok {
		return referenceWithEvents(store, orgID, rawURL, row)
	}
	if row, ok := pick(store.topFor(MatchFieldBase, variants.Base)); ok {
		return referenceWithEvents(store, orgID, rawURL, row)
	}
	pattern := resolveFallbackPattern(variants.Base)
	// The fake keys the pattern rows by the exact pattern; the fallback matcher
	// keeps the same set for the equivalence check.
	if row, ok := pick(store.patternRows[pattern]); ok {
		return referenceWithEvents(store, orgID, rawURL, row)
	}
	return OrgMatch{}, false
}

func referenceWithEvents(store *fakeMatchStore, orgID, rawURL string, row RawItemRow) (OrgMatch, bool) {
	match := OrgMatch{ItemID: row.ItemMetaID}
	bestEvent := ""
	var bestAt time.Time
	for _, processedID := range store.processed[row.ItemMetaID] {
		for _, event := range store.events {
			if event.ProcessedItemID != processedID || event.EventID == "" {
				continue
			}
			if bestEvent == "" || event.CreatedAt.After(bestAt) {
				bestEvent = event.EventID
				bestAt = event.CreatedAt
			}
		}
	}
	if bestEvent != "" {
		match.EventID = bestEvent
	}
	return match, true
}

func TestOrgMatcherMatchesReferenceAcrossStagesAndOrgs(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	row := func(itemMetaID, payload, hash, full, base string, age time.Duration) RawItemRow {
		return RawItemRow{
			ItemMetaID: itemMetaID,
			PayloadURL: payload,
			FullHash:   hash,
			Full:       full,
			Base:       base,
			CreatedAt:  now.Add(-age),
		}
	}
	variantsA, _ := comparableURLVariants("https://news.example/a")
	variantsB, _ := comparableURLVariants("https://news.example/b")
	variantsD, _ := comparableURLVariants("https://news.example/d")
	variantsE, _ := comparableURLVariants("https://news.example/e")
	variantsG, _ := comparableURLVariants("https://news.example/g")
	variantsH, _ := comparableURLVariants("https://news.example/h")
	store := &fakeMatchStore{
		rows: []RawItemRow{
			// a: the other organization owns the newest full match.
			row("meta-b-a", variantsA.Full, variantsA.FullHash, variantsA.Full, variantsA.Base, time.Minute),
			row("meta-a-a", variantsA.Full, variantsA.FullHash, variantsA.Full, variantsA.Base, 2*time.Minute),
			// b: only the other organization has a full match; the caller has a
			// base match that must be used instead of the other tenant's item.
			row("meta-b-b", variantsB.Full, variantsB.FullHash, variantsB.Full, variantsB.Base, time.Minute),
			row("meta-a-b-base", "https://news.example/b?utm=1", "", "", variantsB.Base, 3*time.Minute),
			// c: legacy payload.url exact match only.
			row("meta-a-c", "https://news.example/c", "", "", "", 5*time.Minute),
			// d: newest base row belongs to the other organization.
			row("meta-b-d", "https://news.example/d?x=1", "", "", variantsD.Base, time.Minute),
			row("meta-a-d", "https://news.example/d?x=2", "", "", variantsD.Base, 4*time.Minute),
			// e: regex fallback only.
			row("meta-a-e", "https://news.example/e/deep/path", "", "", "", 6*time.Minute),
			// g: two caller rows in the same stage; newest wins.
			row("meta-a-g-old", variantsG.Full, variantsG.FullHash, variantsG.Full, variantsG.Base, 8*time.Minute),
			row("meta-a-g-new", variantsG.Full, variantsG.FullHash, variantsG.Full, variantsG.Base, 7*time.Minute),
			// h: an older full match must win over a newer base match.
			row("meta-a-h-full", variantsH.Full, variantsH.FullHash, variantsH.Full, variantsH.Base, 9*time.Minute),
			row("meta-a-h-base", "https://news.example/h?later=1", "", "", variantsH.Base, 30*time.Second),
		},
		patternRows: map[string][]RawItemRow{
			resolveFallbackPattern(variantsE.Base): {row("meta-a-e", "https://news.example/e/deep/path", "", "", "", 6*time.Minute)},
		},
		orgs: map[string]string{
			"meta-a-a":      "org-a",
			"meta-b-a":      "org-b",
			"meta-b-b":      "org-b",
			"meta-a-b-base": "org-a",
			"meta-a-c":      "org-a",
			"meta-b-d":      "org-b",
			"meta-a-d":      "org-a",
			"meta-a-e":      "org-a",
			"meta-a-g-old":  "org-a",
			"meta-a-g-new":  "org-a",
			"meta-a-h-full": "org-a",
			"meta-a-h-base": "org-a",
		},
		processed: map[string][]string{
			"meta-a-a":     {"p-a-a"},
			"meta-b-b":     {"p-b-b"},
			"meta-a-g-new": {"p-a-g"},
		},
		events: []EventRow{
			{ProcessedItemID: "p-a-a", EventID: "event-a-a", CreatedAt: now.Add(-time.Minute)},
			{ProcessedItemID: "p-b-b", EventID: "event-b-b", CreatedAt: now},
			{ProcessedItemID: "p-a-g", EventID: "event-a-g", CreatedAt: now},
		},
	}
	urls := []string{
		"https://news.example/a",
		"https://news.example/b",
		"https://news.example/c",
		"https://news.example/d",
		"https://news.example/e",
		"https://news.example/f",
		"https://news.example/g",
		"https://news.example/h",
	}
	matcher := NewOrgMatcher(store)
	got, err := matcher.ResolveOrgMatches(context.Background(), "org-a", urls)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	for _, rawURL := range urls {
		want, matched := referenceResolve(store, "org-a", rawURL)
		actual, ok := got[rawURL]
		if matched != ok {
			t.Fatalf("%s: matched=%v, want %v (got %+v)", rawURL, ok, matched, actual)
		}
		if matched && actual != want {
			t.Fatalf("%s: got %+v, want %+v", rawURL, actual, want)
		}
	}
	if got["https://news.example/a"].EventID != "event-a-a" {
		t.Fatalf("a event = %q", got["https://news.example/a"].EventID)
	}
	if got["https://news.example/b"].ItemID != "meta-a-b-base" {
		t.Fatalf("b must fall back inside the caller organization: %+v", got["https://news.example/b"])
	}
	if got["https://news.example/f"] != (OrgMatch{}) {
		t.Fatalf("f must be unmatched: %+v", got["https://news.example/f"])
	}
	if got["https://news.example/g"].ItemID != "meta-a-g-new" {
		t.Fatalf("g newest = %+v", got["https://news.example/g"])
	}
	if got["https://news.example/h"].ItemID != "meta-a-h-full" {
		t.Fatalf("h stage priority = %+v", got["https://news.example/h"])
	}
}

func TestOrgMatcherDeduplicatesComparableURLs(t *testing.T) {
	now := time.Now().UTC()
	variants, _ := comparableURLVariants("https://news.example/a")
	store := &fakeMatchStore{
		rows: []RawItemRow{{
			ItemMetaID: "meta-a",
			PayloadURL: variants.Full,
			FullHash:   variants.FullHash,
			Full:       variants.Full,
			Base:       variants.Base,
			CreatedAt:  now,
		}},
		orgs: map[string]string{"meta-a": "org-a"},
	}
	got, err := NewOrgMatcher(store).ResolveOrgMatches(context.Background(), "org-a",
		[]string{"https://news.example/a", "https://news.example/a#fragment"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected one deduped URL, got %+v", got)
	}
	for rawURL, match := range got {
		if !strings.HasPrefix(rawURL, "https://news.example/a") || match.ItemID != "meta-a" {
			t.Fatalf("match = %q %+v", rawURL, match)
		}
	}
}
