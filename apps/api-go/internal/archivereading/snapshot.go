package archivereading

import (
	"context"
	"log"
	"strings"
)

// ExportGroups is the request-scoped headlines export snapshot: the full,
// already-filtered and sorted items of each vertical. It is built once per CSV
// request so a worker update cannot change the file halfway through and the
// classification/display/model chain runs only once.
type ExportGroups map[Vertical][]DigestItem

// BuildExportGroups scans once to the existing 12000 candidate budget (or data
// exhaustion for non-search exports), freezes the classification/display/search
// results and then applies the same region/weight/anchor/group ordering as the
// interactive digest. Search still keeps the 500-recall/180-rerank budget
// because it reuses searchCandidates unchanged.
func (s *Service) BuildExportGroups(ctx context.Context, orgID string, input DigestInput) (ExportGroups, error) {
	anchor := utcDayEnd(input.AnchorDate)
	search := strings.TrimSpace(input.Search)
	rows, result, err := s.loadCandidates(ctx, orgID, anchor, search, maxBaseScan)
	if err != nil {
		return nil, err
	}
	fresh, err := s.loadFreshClassifications(ctx, orgID, rows)
	if err != nil {
		return nil, err
	}
	eligibility := s.display.resolveEligibilityBatch(ctx, orgID, rows)
	missing := 0
	for _, row := range rows {
		if _, ok := fresh[row.ID]; !ok {
			missing++
			continue
		}
		if eligibility[row.ID].NeedsBackfill {
			missing++
		}
	}
	if missing > 0 {
		// The snapshot checks the same candidate set at most once. An enqueue
		// failure is diagnostic only: the already-prepared rows still export.
		if err := s.ensureDigest(ctx, orgID, dateKey(anchor)); err != nil {
			log.Printf("api-go: archive export enqueue failed org=%s anchor=%s: %v", orgID, dateKey(anchor), err)
		}
	}
	groups, _ := s.projectGroups(rows, fresh, eligibility, input.Region, input.Weights, anchor, search, result, maxBaseScan, nil)
	out := make(ExportGroups, len(groups))
	for _, group := range groups {
		out[group.Vertical] = group.Items
	}
	return out, nil
}

// RoundRobinItems emits the snapshot in the source export order: each round
// yields up to 100 items per vertical in fixed vertical order, with duplicate
// processedArticleIds dropped across rounds. The CSV output cap is applied by
// the caller, so this method never truncates below the snapshot length.
func (g ExportGroups) RoundRobinItems(limit int) []DigestItem {
	if limit <= 0 {
		return []DigestItem{}
	}
	seen := make(map[string]struct{}, limit)
	out := make([]DigestItem, 0, limit)
	for round := 0; len(out) < limit; round++ {
		progressed := false
		for _, vertical := range VerticalOrder {
			items := g[vertical]
			start := round * 100
			if start >= len(items) {
				continue
			}
			end := start + 100
			if end > len(items) {
				end = len(items)
			}
			progressed = true
			for _, item := range items[start:end] {
				if _, ok := seen[item.ProcessedArticleID]; ok {
					continue
				}
				seen[item.ProcessedArticleID] = struct{}{}
				out = append(out, item)
				if len(out) >= limit {
					return out
				}
			}
		}
		if !progressed {
			break
		}
	}
	return out
}
