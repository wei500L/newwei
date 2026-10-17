package situationsignals

import (
	"context"
	"math"
	"sort"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

// localeCollator sorts monitor names the way localeCompare("en") does. The
// collator is not safe for concurrent use, so every comparison is serialized;
// the package-level mutex and the helper below follow the dashboardcharts
// precedent.
var (
	localeCollator = collate.New(language.English)
	localeMu       sync.Mutex
)

// matchReason is one SituationMonitorMatchReason. matchedValues and score are
// conditional: they are omitted when the matcher did not set them.
type matchReason struct {
	Code          string   `json:"code"`
	Label         string   `json:"label"`
	MatchedValues []string `json:"matchedValues,omitempty"`
	Score         *float64 `json:"score,omitempty"`
}

// matchResult is one SituationMonitorMatchResult.
//
// Key order follows the NestJS object literal. `link` and `title` are always
// present (an empty string when the candidate had none); the conditional keys
// are omitted when falsy.
type matchResult struct {
	ItemKey      string         `json:"itemKey"`
	ItemType     string         `json:"itemType"`
	ItemMetaID   string         `json:"itemMetaId,omitempty"`
	MonitorID    string         `json:"monitorId"`
	MonitorKind  string         `json:"monitorKind"`
	MonitorName  string         `json:"monitorName"`
	MonitorColor string         `json:"monitorColor,omitempty"`
	Score        float64        `json:"score"`
	GeoStatus    matchGeoStatus `json:"geoStatus"`
	MatchedTerms []string       `json:"matchedTerms"`
	Reasons      []matchReason  `json:"reasons"`
	Link         string         `json:"link"`
	Title        string         `json:"title"`
	TitleZh      string         `json:"titleZh,omitempty"`
	Summary      string         `json:"summary,omitempty"`
	SummaryZh    string         `json:"summaryZh,omitempty"`
	Category     string         `json:"category,omitempty"`
	Source       string         `json:"source"`
	Timestamp    float64        `json:"timestamp"`
}

// explicitSignals is the result of computeExplicitCandidateSignals.
type explicitSignals struct {
	reasons      []matchReason
	matchedTerms []string
	geoStatus    matchGeoStatus
	baseScore    float64
}

// matchCandidates mirrors matchCandidates.
func (s *Service) matchCandidates(ctx context.Context, orgID, userID string, candidates []monitorCandidate) ([]matchResult, error) {
	if len(candidates) == 0 {
		return []matchResult{}, nil
	}
	if s.loadMonitors == nil {
		return nil, errNoDatabase
	}
	monitors, err := s.loadMonitors(ctx, orgID, userID)
	if err != nil {
		return nil, err
	}
	if len(monitors) == 0 {
		return []matchResult{}, nil
	}
	embeddings := s.embedCandidateBatch(ctx, orgID, monitors, candidates)
	return s.matchCandidatesWithPreparedData(ctx, orgID, monitors, candidates, embeddings), nil
}

// matchCandidatesWithPreparedData mirrors matchCandidatesWithPreparedData.
func (s *Service) matchCandidatesWithPreparedData(ctx context.Context, orgID string, monitors []monitorRecord, candidates []monitorCandidate, candidateEmbeddings map[string][]float64) []matchResult {
	results := make([]matchResult, 0)
	for _, monitor := range monitors {
		explicitScores := make([]explicitSignals, 0, len(candidates))
		for _, candidate := range candidates {
			explicitScores = append(explicitScores, computeExplicitCandidateSignals(monitor, candidate))
		}

		type semanticEntry struct {
			index int
			score float64
		}
		shortlist := make([]semanticEntry, 0, len(candidates))
		for index, candidate := range candidates {
			vector, ok := candidateEmbeddings[candidate.ItemKey]
			if !ok || len(vector) == 0 || len(monitor.QueryEmbeddingVector) == 0 {
				continue
			}
			if len(vector) != len(monitor.QueryEmbeddingVector) {
				continue
			}
			shortlist = append(shortlist, semanticEntry{index: index, score: dot(monitor.QueryEmbeddingVector, vector)})
		}
		sort.SliceStable(shortlist, func(left, right int) bool {
			return shortlist[left].score > shortlist[right].score
		})
		trimmed := make([]semanticEntry, 0, len(shortlist))
		for _, entry := range shortlist {
			if entry.score < semanticShortlistThreshold {
				continue
			}
			trimmed = append(trimmed, entry)
			if len(trimmed) >= rerankShortlistLimit {
				break
			}
		}
		semanticScoreByIndex := make(map[int]float64, len(trimmed))
		rerankInputs := make([]monitorCandidate, 0, len(trimmed))
		for _, entry := range trimmed {
			semanticScoreByIndex[entry.index] = entry.score
			rerankInputs = append(rerankInputs, candidates[entry.index])
		}

		rerankScores := s.tryRerankCandidates(ctx, orgID, monitor, rerankInputs)

		for index, candidate := range candidates {
			explicit := explicitScores[index]
			// A conflicting country is a hard exclusion: the candidate is
			// about somewhere else.
			if explicit.geoStatus == geoStatusConflict {
				continue
			}
			semanticScore, hasSemantic := semanticScoreByIndex[index]
			rerankScore, hasRerank := rerankScores[candidate.ItemKey]
			include := len(explicit.reasons) > 0 ||
				(hasRerank && rerankScore >= rerankIncludeThreshold) ||
				(!hasRerank && hasSemantic && semanticScore >= semanticIncludeThreshold)
			if !include {
				continue
			}

			reasons := make([]matchReason, 0, len(explicit.reasons)+3)
			reasons = append(reasons, explicit.reasons...)
			if hasSemantic {
				score := roundScore(semanticScore)
				reasons = append(reasons, matchReason{Code: "semantic", Label: "Semantic recall", Score: &score})
			}
			if hasRerank {
				score := roundScore(rerankScore)
				reasons = append(reasons, matchReason{Code: "rerank", Label: "Rerank accepted", Score: &score})
			}
			if explicit.geoStatus == geoStatusMatched || explicit.geoStatus == geoStatusCountryMatch {
				label := "Location matched"
				if explicit.geoStatus == geoStatusCountryMatch {
					label = "Country matched"
				}
				reasons = append(reasons, matchReason{Code: "geo", Label: label})
			}

			finalScore := explicit.baseScore
			if hasSemantic {
				finalScore += semanticScore * 0.15
			}
			if hasRerank {
				finalScore += rerankScore * 0.2
			}
			finalScore = clamp01(finalScore)

			matchedTerms := dedupeStrings(explicit.matchedTerms)
			if len(matchedTerms) > matchedTermLimit {
				matchedTerms = matchedTerms[:matchedTermLimit]
			}
			results = append(results, matchResult{
				ItemKey:      candidate.ItemKey,
				ItemType:     candidate.ItemType,
				ItemMetaID:   candidate.ItemMetaID,
				MonitorID:    monitor.ID,
				MonitorKind:  monitor.Kind,
				MonitorName:  monitor.Name,
				MonitorColor: monitor.Color,
				Score:        roundScore(finalScore),
				GeoStatus:    explicit.geoStatus,
				MatchedTerms: matchedTerms,
				Reasons:      reasons,
				// link and title are unconditional: a falsy value becomes "".
				Link:      candidate.Link,
				Title:     candidate.Title,
				TitleZh:   candidate.TitleZh,
				Summary:   candidate.Summary,
				SummaryZh: candidate.SummaryZh,
				Category:  candidate.Category,
				Source:    candidate.Source,
				Timestamp: candidate.Timestamp,
			})
		}
	}
	sortMatchResults(results)
	return results
}

// sortMatchResults mirrors the three-level ordering: timestamp descending, then
// score descending, then monitorName ascending via localeCompare.
func sortMatchResults(results []matchResult) {
	sort.SliceStable(results, func(left, right int) bool {
		a, b := results[left], results[right]
		if a.Timestamp != b.Timestamp {
			return a.Timestamp > b.Timestamp
		}
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		localeMu.Lock()
		defer localeMu.Unlock()
		return localeCollator.CompareString(a.MonitorName, b.MonitorName) < 0
	})
}

// tryRerankCandidates mirrors tryRerankCandidates: min-max normalized scores
// keyed by itemKey, and an empty map on any failure.
func (s *Service) tryRerankCandidates(ctx context.Context, orgID string, monitor monitorRecord, candidates []monitorCandidate) map[string]float64 {
	if len(candidates) == 0 || s.embed == nil {
		return map[string]float64{}
	}
	documents := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		documents = append(documents, candidateEmbeddingText(candidate))
	}
	rerankCtx := llmembed.ContextWithMeta(ctx, matchEmbeddingSource, monitorRerankStage)
	hits, err := s.embed.Rerank(rerankCtx, orgID, buildQueryText(monitor), documents)
	if err != nil {
		// Rerank failure is not fatal: the caller falls back to the explicit and
		// semantic rules.
		return map[string]float64{}
	}

	type scored struct {
		itemKey string
		score   float64
	}
	collected := make([]scored, 0, len(hits))
	for _, hit := range hits {
		if hit.Index < 0 || hit.Index >= len(candidates) {
			continue
		}
		if math.IsNaN(hit.Score) || math.IsInf(hit.Score, 0) {
			continue
		}
		collected = append(collected, scored{itemKey: candidates[hit.Index].ItemKey, score: hit.Score})
	}
	if len(collected) == 0 {
		return map[string]float64{}
	}
	minimum := collected[0].score
	maximum := collected[0].score
	for _, entry := range collected[1:] {
		if entry.score < minimum {
			minimum = entry.score
		}
		if entry.score > maximum {
			maximum = entry.score
		}
	}
	out := make(map[string]float64, len(collected))
	for _, entry := range collected {
		if maximum == minimum {
			out[entry.itemKey] = 1
			continue
		}
		out[entry.itemKey] = (entry.score - minimum) / (maximum - minimum)
	}
	return out
}

// embedCandidateBatch mirrors embedCandidateBatch.
//
// When no monitor carries a query embedding vector the model is never called and
// the batch is empty, which is the lexical-only fallback. Any embedding failure
// also yields the empty map: a degraded model service must never be reported as
// a semantic match.
func (s *Service) embedCandidateBatch(ctx context.Context, orgID string, monitors []monitorRecord, candidates []monitorCandidate) map[string][]float64 {
	results := map[string][]float64{}
	if len(candidates) == 0 {
		return results
	}
	hasVector := false
	for _, monitor := range monitors {
		if len(monitor.QueryEmbeddingVector) > 0 {
			hasVector = true
			break
		}
	}
	if !hasVector || s.embed == nil {
		return results
	}

	for _, chunk := range chunkCandidates(candidates, matchEmbeddingBatchSize) {
		texts := make([]string, 0, len(chunk))
		for _, candidate := range chunk {
			texts = append(texts, candidateEmbeddingText(candidate))
		}
		embedCtx := llmembed.ContextWithMeta(ctx, matchEmbeddingSource, matchEmbeddingStage)
		vectors, _, err := s.embed.Embed(embedCtx, orgID, texts)
		if err != nil {
			return map[string][]float64{}
		}
		for index, candidate := range chunk {
			if index >= len(vectors) {
				continue
			}
			vector := vectors[index]
			if len(vector) == 0 {
				continue
			}
			results[candidate.ItemKey] = normalizeVector(vector)
		}
	}
	return results
}

// computeExplicitCandidateSignals mirrors computeExplicitCandidateSignals.
func computeExplicitCandidateSignals(monitor monitorRecord, candidate monitorCandidate) explicitSignals {
	haystack := buildHaystack(candidate)
	matchedTerms := []string{}
	reasons := []matchReason{}

	keywordTerms := make([]string, 0, len(monitor.RawKeywords)+len(monitor.ApprovedLexicalTerms))
	keywordTerms = append(keywordTerms, monitor.RawKeywords...)
	keywordTerms = append(keywordTerms, monitor.ApprovedLexicalTerms...)
	keywordHits := collectLexicalHits(keywordTerms, haystack)
	if len(keywordHits) > 0 {
		matchedTerms = append(matchedTerms, keywordHits...)
		reasons = append(reasons, matchReason{Code: "keyword", Label: "Keyword matched", MatchedValues: keywordHits})
	}

	topicValues := make([]string, 0, len(candidate.Topics)+len(candidate.ExtraTexts))
	topicValues = append(topicValues, candidate.Topics...)
	topicValues = append(topicValues, candidate.ExtraTexts...)
	topicHits := collectSetHits(monitor.ApprovedTopics, topicValues)
	if len(topicHits) > 0 {
		matchedTerms = append(matchedTerms, topicHits...)
		reasons = append(reasons, matchReason{Code: "topic", Label: "Topic matched", MatchedValues: topicHits})
	}

	entityValues := make([]string, 0, len(candidate.Entities)+2+len(candidate.ExtraTexts))
	entityValues = append(entityValues, candidate.Entities...)
	entityValues = append(entityValues, candidate.Title, candidate.Summary)
	entityValues = append(entityValues, candidate.ExtraTexts...)
	entityHits := collectSetHits(monitor.ApprovedEntities, entityValues)
	if len(entityHits) > 0 {
		matchedTerms = append(matchedTerms, entityHits...)
		reasons = append(reasons, matchReason{Code: "entity", Label: "Entity matched", MatchedValues: entityHits})
	}

	sourceHits := collectSetHits(monitor.ApprovedSources, []string{candidate.Source})
	if len(sourceHits) > 0 {
		matchedTerms = append(matchedTerms, sourceHits...)
		reasons = append(reasons, matchReason{Code: "source", Label: "Source matched", MatchedValues: sourceHits})
	}

	geoHits := collectGeoHits(monitor.ApprovedGeos, candidate.GeoTexts)
	if len(geoHits) > 0 {
		matchedTerms = append(matchedTerms, geoHits...)
		reasons = append(reasons, matchReason{Code: "geo", Label: "Geo subscription matched", MatchedValues: geoHits})
	}

	geoStatus := resolveGeoStatus(monitor, candidate)
	baseScore := 0.0
	if len(keywordHits) > 0 {
		baseScore += 0.42
	}
	if len(topicHits) > 0 {
		baseScore += 0.18
	}
	if len(entityHits) > 0 {
		baseScore += 0.18
	}
	if len(sourceHits) > 0 {
		baseScore += 0.18
	}
	if len(geoHits) > 0 {
		baseScore += 0.12
	}
	if geoStatus == geoStatusMatched {
		baseScore += 0.08
	}
	if geoStatus == geoStatusCountryMatch {
		baseScore += 0.04
	}

	return explicitSignals{
		reasons:      reasons,
		matchedTerms: matchedTerms,
		geoStatus:    geoStatus,
		baseScore:    clamp01(baseScore),
	}
}

// resolveGeoStatus mirrors resolveGeoStatus.
func resolveGeoStatus(monitor monitorRecord, candidate monitorCandidate) matchGeoStatus {
	if monitor.Location == nil {
		return geoStatusNotConfigured
	}
	if len(collectGeoHits([]string{monitor.Location.Name}, candidate.GeoTexts)) > 0 {
		return geoStatusMatched
	}
	candidateCountry := ""
	for _, entry := range candidate.GeoTexts {
		if alpha2, ok := extractGeoCountryAlpha2(entry); ok {
			candidateCountry = alpha2
			break
		}
	}
	configuredCountry := monitor.Location.CountryCodeAlpha2
	if candidateCountry != "" && configuredCountry != "" && candidateCountry != configuredCountry {
		return geoStatusConflict
	}
	if candidateCountry != "" && configuredCountry != "" && candidateCountry == configuredCountry {
		return geoStatusCountryMatch
	}
	return geoStatusUnresolved
}

// collectLexicalHits mirrors collectLexicalHits: short ASCII terms need a word
// boundary, longer terms are substring matches.
func collectLexicalHits(terms []string, haystack string) []string {
	hits := make([]string, 0, lexicalHitLimit)
	for _, display := range normalizeStringList(terms, maxApprovedTerms) {
		normalized := strings.ToLower(display)
		matched := false
		if isShortAscii(normalized) {
			matched = hasWordBoundaryMatch(haystack, normalized)
		} else {
			matched = strings.Contains(haystack, normalized)
		}
		if !matched {
			continue
		}
		hits = append(hits, display)
		if len(hits) >= lexicalHitLimit {
			break
		}
	}
	return hits
}

// collectSetHits mirrors collectSetHits.
func collectSetHits(expected []string, values []string) []string {
	haystack := make([]string, 0, len(values))
	for _, value := range values {
		if normalized := normalizeTerm(value); normalized != "" {
			haystack = append(haystack, normalized)
		}
	}
	hits := make([]string, 0, lexicalHitLimit)
	for _, entry := range normalizeStringList(expected, maxApprovedTerms) {
		normalized := normalizeTerm(entry)
		if normalized == "" {
			continue
		}
		matched := false
		for _, value := range haystack {
			if value == normalized || strings.Contains(value, normalized) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		hits = append(hits, entry)
		if len(hits) >= lexicalHitLimit {
			break
		}
	}
	return hits
}

// buildQueryText mirrors buildQueryText.
func buildQueryText(monitor monitorRecord) string {
	parts := []string{"name=" + monitor.Name}
	if len(monitor.RawKeywords) > 0 {
		parts = append(parts, "keywords="+strings.Join(monitor.RawKeywords, ", "))
	}
	if len(monitor.ApprovedTopics) > 0 {
		parts = append(parts, "topics="+strings.Join(monitor.ApprovedTopics, ", "))
	}
	if len(monitor.ApprovedEntities) > 0 {
		parts = append(parts, "entities="+strings.Join(monitor.ApprovedEntities, ", "))
	}
	if len(monitor.ApprovedSources) > 0 {
		parts = append(parts, "sources="+strings.Join(monitor.ApprovedSources, ", "))
	}
	if len(monitor.ApprovedGeos) > 0 {
		parts = append(parts, "geos="+strings.Join(monitor.ApprovedGeos, ", "))
	}
	if len(monitor.ApprovedLexicalTerms) > 0 {
		parts = append(parts, "lexical="+strings.Join(monitor.ApprovedLexicalTerms, ", "))
	}
	if monitor.Location != nil && monitor.Location.Name != "" {
		parts = append(parts, "location="+monitor.Location.Name)
	}
	if monitor.Location != nil && monitor.Location.CountryCodeAlpha2 != "" {
		country := contentsubscriptions.CountryEnglishName(monitor.Location.CountryCodeAlpha2)
		if country == "" {
			country = monitor.Location.CountryCodeAlpha2
		}
		parts = append(parts, "country="+country)
	}
	return strings.Join(parts, "\n")
}
