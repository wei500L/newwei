package auditoutbox

import "sort"

// mergeCandidates mirrors the NestJS mergeRetryEntries step: the three groups
// are flattened with the first occurrence per id winning (pending, failed,
// stale processing, in that order), then sorted globally by createdAt asc, id
// asc and cut to the batch size.
//
// The NestJS tie-breaker is String.prototype.localeCompare. The persisted ids
// are cuid strings over [0-9a-z], for which the ICU root collation and byte
// comparison agree, so `ID <` is the equivalent key. A payload never
// participates in the selection.
func mergeCandidates(groups [][]Candidate, limit int) []Candidate {
	total := 0
	for _, group := range groups {
		total += len(group)
	}
	merged := make([]Candidate, 0, total)
	seen := make(map[string]struct{}, total)
	for _, group := range groups {
		for _, candidate := range group {
			if _, ok := seen[candidate.ID]; ok {
				continue
			}
			seen[candidate.ID] = struct{}{}
			merged = append(merged, candidate)
		}
	}

	sort.Slice(merged, func(left, right int) bool {
		if !merged[left].CreatedAt.Equal(merged[right].CreatedAt) {
			return merged[left].CreatedAt.Before(merged[right].CreatedAt)
		}
		return merged[left].ID < merged[right].ID
	})

	if limit >= 0 && len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}
