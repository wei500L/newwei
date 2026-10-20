package newssourcescheduler

import (
	"context"
	"time"
)

// This file ports findRecentArticleFingerprints and
// findActivePipelineFingerprints and fixes S1: a record that matched through the
// URL index also contributes the candidate's current fingerprint.
//
// Before the fix, a row whose stored urlFingerprint differed from the candidate's
// fingerprint (query-parameter allowlist change, fingerprint algorithm change)
// only contributed its own stale fingerprint, so the same URL was re-dispatched
// inside the dedupe window. Adding both fingerprints can only widen the matched
// set, never shrink it, so every previously deduped URL stays deduped.
//
// O5 is also implemented here: the two indexes are queried separately and merged
// in memory instead of one `urlFingerprint IN … OR url IN …` predicate MySQL may
// not optimize.

// fingerprintRecord is the (urlFingerprint, url) projection of both queries.
type fingerprintRecord struct {
	URLFingerprint *string
	URL            string
}

// fingerprintByURL maps each candidate URL to its current fingerprint.
func fingerprintByURL(candidates []canonicalSeedJob) map[string]string {
	out := make(map[string]string, len(candidates))
	for _, candidate := range candidates {
		out[candidate.URL] = candidate.URLFingerprint
	}
	return out
}

// uniqueStrings keeps the first occurrence order and drops empties.
func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// matchedFingerprints applies the S1 rule to the merged records.
func matchedFingerprints(records []fingerprintRecord, byURL map[string]string) map[string]bool {
	matched := map[string]bool{}
	for _, record := range records {
		if record.URLFingerprint != nil && *record.URLFingerprint != "" {
			matched[*record.URLFingerprint] = true
		}
		if candidateFingerprint, ok := byURL[record.URL]; ok && candidateFingerprint != "" {
			matched[candidateFingerprint] = true
		}
	}
	return matched
}

// findRecentArticleFingerprints is findRecentArticleFingerprints.
func (s *Service) findRecentArticleFingerprints(ctx context.Context, orgID string, candidates []canonicalSeedJob, windowHours int) (map[string]bool, error) {
	hours := windowHours
	if hours < 0 {
		hours = 0
	}
	if hours > 24*30 {
		hours = 24 * 30
	}
	if hours == 0 || len(candidates) == 0 {
		return map[string]bool{}, nil
	}
	since := s.now().Add(-time.Duration(hours) * time.Hour)
	fingerprints := make([]string, 0, len(candidates))
	urls := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		fingerprints = append(fingerprints, candidate.URLFingerprint)
		urls = append(urls, candidate.URL)
	}
	fingerprints = uniqueStrings(fingerprints)
	urls = uniqueStrings(urls)
	byURL := fingerprintByURL(candidates)

	byFingerprint, err := s.repo.FindArticleFingerprintsByFingerprint(ctx, orgID, fingerprints, since)
	if err != nil {
		return nil, err
	}
	byURLRecords, err := s.repo.FindArticleFingerprintsByURL(ctx, orgID, urls, since)
	if err != nil {
		return nil, err
	}
	records := make([]fingerprintRecord, 0, len(byFingerprint)+len(byURLRecords))
	records = append(records, byFingerprint...)
	records = append(records, byURLRecords...)
	return matchedFingerprints(records, byURL), nil
}

// findActivePipelineFingerprints is findActivePipelineFingerprints.
func (s *Service) findActivePipelineFingerprints(ctx context.Context, sourceID string, candidates []canonicalSeedJob, activeCutoff time.Time) (map[string]bool, error) {
	if len(candidates) == 0 {
		return map[string]bool{}, nil
	}
	fingerprints := make([]string, 0, len(candidates))
	urls := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		fingerprints = append(fingerprints, candidate.URLFingerprint)
		urls = append(urls, candidate.URL)
	}
	fingerprints = uniqueStrings(fingerprints)
	urls = uniqueStrings(urls)
	byURL := fingerprintByURL(candidates)

	byFingerprint, err := s.repo.FindActivePipelineFingerprintsByFingerprint(ctx, sourceID, fingerprints, activeCutoff)
	if err != nil {
		return nil, err
	}
	byURLRecords, err := s.repo.FindActivePipelineFingerprintsByURL(ctx, sourceID, urls, activeCutoff)
	if err != nil {
		return nil, err
	}
	records := make([]fingerprintRecord, 0, len(byFingerprint)+len(byURLRecords))
	records = append(records, byFingerprint...)
	records = append(records, byURLRecords...)
	return matchedFingerprints(records, byURL), nil
}
