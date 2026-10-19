package crawlstrategyruns

import "sort"

// sortCandidates applies a stable comparator, matching the source's
// Array.prototype.sort on engines with a stable sort (Node/V8).
func sortCandidates(candidates []*Candidate, compare func(left, right *Candidate) int) {
	sort.SliceStable(candidates, func(i, j int) bool {
		return compare(candidates[i], candidates[j]) < 0
	})
}
