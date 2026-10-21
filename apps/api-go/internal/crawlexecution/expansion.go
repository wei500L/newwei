package crawlexecution

// This file ports the detail-expansion branch runTask calls
// (CrawlDetailExpansionService.expandListLikeResultsIfNeeded) for both the
// pipeline and the BullMQ worker path: page-signal assessment, auto-expand
// decision, the primary and link-fallback candidate pools, publish-signal
// enrichment, batched expansion crawls, improvement selection and the merge back
// into the crawl results.
//
// The page signals themselves (publish time, media density, DOM list risk) live
// in quality.go and the candidate probes in quality_http.go. Every input reaches
// the four decisions the way NestJS does: publish time and media density can
// veto a low-signal/ list-like verdict, and the DOM list risk feeds both
// isListLike and isLowSignal.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// expansionInput is expandListLikeResultsIfNeeded's option object.
type expansionInput struct {
	Task                *taskRow
	OrgID               string
	Keywords            []string
	CrawlOptions        normalizedOptions
	Successes           []crawl4ai.PipelineArticle
	SeededFromLowSignal bool
	RequestTimeoutMs    int
}

// expansionResult is the non-nil expansion outcome.
type expansionResult struct {
	Successes []crawl4ai.PipelineArticle
	Failures  []Failure
	RunID     *string
}

// articleSignal is CrawlArticleSignal: the markdown metrics plus the three
// inputs the detail-expansion decision reads (publish time, media density, DOM
// list risk).
type articleSignal struct {
	WordCount             int
	ParagraphCount        int
	HeadingCount          int
	LinkCount             int
	LinkDensity           float64
	BulletLines           int
	PublishTimeConfidence float64
	PublishTimeSource     string
	MediaDensity          float64
	DomListRisk           float64
	Score                 float64
	IsListLike            bool
}

// detailExpansionOptions is Required<CrawlDetailExpansionOptions>.
type detailExpansionOptions struct {
	MaxDetailUrls        int
	MinRelevanceScore    float64
	RequireSameDomain    bool
	AllowExternalLinks   bool
	IncludeURLPatterns   []string
	ExcludeURLPatterns   []string
	MinPublishConfidence float64
	PreferFitMarkdown    bool
}

var defaultDetailExpansionOptions = detailExpansionOptions{
	MaxDetailUrls:        12,
	MinRelevanceScore:    0.35,
	RequireSameDomain:    true,
	AllowExternalLinks:   true,
	IncludeURLPatterns:   nil,
	ExcludeURLPatterns:   []string{"/tag/", "/tags/", "/topic/", "/topics/", "/archive/", "/category/", "/categories/", "/author/", "/authors/", "/section/", "/sections/", "/latest"},
	MinPublishConfidence: 0.55,
	PreferFitMarkdown:    true,
}

var (
	dateSuffixPattern    = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)
	articleDateSlash     = regexp.MustCompile(`/(20\d{2})/([01]\d)/([0-3]\d)(?:/|$)`)
	articleDateDashed    = regexp.MustCompile(`(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)`)
	slugSeparatorPattern = regexp.MustCompile(`(?i)[a-z0-9]-[a-z0-9]`)
)

// resolveDetailExpansionOptions is CrawlQualityStrategyService.resolveDetailExpansion.
func resolveDetailExpansionOptions(options normalizedOptions) detailExpansionOptions {
	resolved := defaultDetailExpansionOptions
	resolved.ExcludeURLPatterns = append([]string(nil), defaultDetailExpansionOptions.ExcludeURLPatterns...)
	input := options.DetailExpansion
	if input == nil {
		return resolved
	}
	if input.MaxDetailUrls != nil {
		value := *input.MaxDetailUrls
		if value < 1 {
			value = 1
		}
		if value > 30 {
			value = 30
		}
		resolved.MaxDetailUrls = value
	}
	if input.MinRelevanceScore != nil {
		value := *input.MinRelevanceScore
		if value < 0 {
			value = 0
		}
		if value > 1 {
			value = 1
		}
		resolved.MinRelevanceScore = roundTo(value, 3)
	}
	if input.RequireSameDomain != nil {
		resolved.RequireSameDomain = *input.RequireSameDomain
		resolved.AllowExternalLinks = !resolved.RequireSameDomain
	}
	if input.AllowExternalLinks != nil {
		resolved.AllowExternalLinks = *input.AllowExternalLinks
	}
	if patterns := normalizePatternList(input.IncludeURLPatterns); patterns != nil {
		resolved.IncludeURLPatterns = patterns
	}
	if patterns := normalizePatternList(input.ExcludeURLPatterns); patterns != nil {
		resolved.ExcludeURLPatterns = patterns
	}
	if input.MinPublishTimeConfidence != nil {
		value := *input.MinPublishTimeConfidence
		if value < 0 {
			value = 0
		}
		if value > 1 {
			value = 1
		}
		resolved.MinPublishConfidence = roundTo(value, 3)
	}
	if input.PreferFitMarkdownForQuality != nil {
		resolved.PreferFitMarkdown = *input.PreferFitMarkdownForQuality
	}
	return resolved
}

// normalizePatternList is normalizePatternList.
func normalizePatternList(patterns []string) []string {
	if len(patterns) == 0 {
		return nil
	}
	unique := make([]string, 0, len(patterns))
	for _, raw := range patterns {
		normalized := strings.TrimSpace(raw)
		if normalized == "" {
			continue
		}
		duplicate := false
		for _, existing := range unique {
			if existing == normalized {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		unique = append(unique, normalized)
		if len(unique) >= 25 {
			break
		}
	}
	if len(unique) == 0 {
		return nil
	}
	return unique
}

func minIntValue(left, right int) int {
	if left < right {
		return left
	}
	return right
}

// countArticleLinks counts every link bucket entry.
func countArticleLinks(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	var buckets map[string][]json.RawMessage
	if err := json.Unmarshal(raw, &buckets); err != nil {
		return 0
	}
	total := 0
	for _, entries := range buckets {
		total += len(entries)
	}
	return total
}

// classifyPageKind is classifyPageKind.
func classifyPageKind(assessments, lowSignal []articleSignal, hint string) string {
	if len(assessments) == 0 {
		return "blocked"
	}
	if hint == "detail" {
		return "detail"
	}
	if hint == "list" {
		return "list"
	}
	ratio := float64(len(lowSignal)) / float64(len(assessments))
	if ratio >= 0.75 {
		return "list"
	}
	if ratio >= 0.35 {
		return "mixed"
	}
	return "detail"
}

// shouldAutoExpand is shouldAutoExpand.
func shouldAutoExpand(options normalizedOptions, hint, pageKind string, allLowSignal bool, lowSignalCount int) bool {
	if !options.AutoExpandDetails {
		return false
	}
	if lowSignalCount == 0 {
		return false
	}
	if hint == "detail" {
		return allLowSignal
	}
	if hint == "list" {
		return true
	}
	return pageKind == "list" || pageKind == "mixed" || allLowSignal
}

// isSignificantDetailImprovement is isSignificantDetailImprovement.
func isSignificantDetailImprovement(quality articleSignal, baseScore float64, baseWords int, baseLinkDensity float64) bool {
	if quality.WordCount <= 0 {
		return false
	}
	densityTarget := math.Max(baseLinkDensity*0.65, 0.08)
	if quality.IsListLike && quality.WordCount < maxIntValue(baseWords+80, 180) &&
		quality.LinkDensity >= math.Max(densityTarget*0.9, 0.12) {
		return false
	}
	if !quality.IsListLike && quality.ParagraphCount >= 3 && quality.WordCount >= 120 &&
		quality.LinkDensity <= densityTarget {
		return true
	}
	if quality.Score >= baseScore+120 && quality.LinkDensity <= math.Max(baseLinkDensity*0.8, 0.2) {
		return true
	}
	if quality.WordCount >= baseWords+100 && quality.LinkDensity <= math.Max(baseLinkDensity*0.85, 0.22) {
		return true
	}
	if !quality.IsListLike && quality.WordCount >= maxIntValue(int(math.Floor(float64(baseWords)*0.6)), 140) &&
		quality.LinkCount <= maxIntValue(int(math.Floor(float64(quality.WordCount)*0.12)), 35) {
		return true
	}
	return !quality.IsListLike && quality.WordCount >= 180 && quality.HeadingCount >= 1 && quality.LinkDensity <= 0.12
}

func maxIntValue(left, right int) int {
	if left > right {
		return left
	}
	return right
}

// expandListLikeResultsIfNeeded is expandListLikeResultsIfNeeded.
func (s *Service) expandListLikeResultsIfNeeded(ctx context.Context, input expansionInput) (*expansionResult, error) {
	if len(input.Successes) == 0 {
		return nil, nil
	}
	pageTypeHint := "auto"
	if input.CrawlOptions.PageTypeHint != nil {
		pageTypeHint = *input.CrawlOptions.PageTypeHint
	}
	qualityProfile := input.CrawlOptions.QualityProfile
	if qualityProfile == "" {
		qualityProfile = "quality_first"
	}
	detailOptions := resolveDetailExpansionOptions(input.CrawlOptions)
	now := s.now()

	assessments := make([]articleSignal, 0, len(input.Successes))
	lowSignal := make([]articleSignal, 0, len(input.Successes))
	lowSignalIndexes := map[int]struct{}{}
	for index, article := range input.Successes {
		signal := assessArticleMarkdownSignal(article, detailOptions.PreferFitMarkdown, now)
		assessments = append(assessments, signal)
		if isLowSignal(signal, countArticleLinks(article.Links)) {
			lowSignal = append(lowSignal, signal)
			lowSignalIndexes[index] = struct{}{}
		}
	}
	allLowSignal := len(assessments) > 0 && len(lowSignal) == len(assessments)
	pageKind := classifyPageKind(assessments, lowSignal, pageTypeHint)
	autoExpand := shouldAutoExpand(input.CrawlOptions, pageTypeHint, pageKind, allLowSignal, len(lowSignal))
	forceFromSeed := input.SeededFromLowSignal && input.CrawlOptions.AutoExpandDetails && pageTypeHint != "detail"
	if !autoExpand && !forceFromSeed {
		return nil, nil
	}
	effectiveLowSignal := lowSignal
	if len(effectiveLowSignal) == 0 && forceFromSeed {
		effectiveLowSignal = assessments
	}
	effectiveAllLowSignal := len(effectiveLowSignal) > 0 && len(effectiveLowSignal) == len(assessments)

	// Low-signal aggregates feed the detail-improvement gate exactly like the
	// page assessment does in NestJS.
	baseScore := math.Inf(-1)
	baseWords := 0
	maxLinkDensity := 0.0
	minLowSignalWords := math.Inf(1)
	meanLowSignalWords := 0.0
	meanLowSignalLinkDensity := 0.0
	for _, signal := range lowSignal {
		if signal.Score > baseScore {
			baseScore = signal.Score
		}
		if signal.WordCount > baseWords {
			baseWords = signal.WordCount
		}
		if signal.LinkDensity > maxLinkDensity {
			maxLinkDensity = signal.LinkDensity
		}
		if float64(signal.WordCount) < minLowSignalWords {
			minLowSignalWords = float64(signal.WordCount)
		}
		meanLowSignalWords += float64(signal.WordCount)
		meanLowSignalLinkDensity += signal.LinkDensity
	}
	if len(lowSignal) > 0 {
		meanLowSignalWords /= float64(len(lowSignal))
		meanLowSignalLinkDensity /= float64(len(lowSignal))
	} else {
		minLowSignalWords = 0
	}

	existingURLs := map[string]struct{}{}
	for _, entry := range input.Successes {
		if normalized := normalizeComparableURL(entry.URL); normalized != "" {
			existingURLs[normalized] = struct{}{}
		}
	}
	// The primary and fallback candidate pools keep insertion order so the
	// ranking is deterministic (Go map iteration is not).
	primaryOrder := make([]string, 0, 16)
	fallbackOrder := make([]string, 0, 16)
	primaryScores := map[string]float64{}
	fallbackScores := map[string]float64{}
	existingURLSkipped := 0
	fallbackMinPublishConfidence := math.Max(0, detailOptions.MinPublishConfidence-0.2)
	for index, article := range input.Successes {
		if _, isLow := lowSignalIndexes[index]; !isLow && !forceFromSeed {
			continue
		}
		baseURL := resolveArticleBaseURL(article)
		if baseURL == "" {
			baseURL = input.Task.TargetURL
		}
		for _, candidate := range extractDetailLinkCandidates(article, baseURL, detailOptions) {
			if _, exists := existingURLs[candidate]; exists {
				existingURLSkipped++
				continue
			}
			score, ok := scorePrimaryDetailCandidate(candidate, baseURL, detailOptions.MinPublishConfidence)
			if !ok {
				continue
			}
			current, seen := primaryScores[candidate]
			if !seen {
				primaryOrder = append(primaryOrder, candidate)
			}
			if !seen || score > current {
				primaryScores[candidate] = score
			}
		}
		for _, candidate := range extractFallbackDetailLinkCandidates(article, baseURL, detailOptions, fallbackMinPublishConfidence) {
			if _, exists := existingURLs[candidate]; exists {
				existingURLSkipped++
				continue
			}
			score, ok := scoreFallbackDetailCandidate(candidate, baseURL, fallbackMinPublishConfidence)
			if !ok {
				continue
			}
			current, seen := fallbackScores[candidate]
			if !seen {
				fallbackOrder = append(fallbackOrder, candidate)
			}
			if !seen || score > current {
				fallbackScores[candidate] = score
			}
		}
	}

	profileMultiplier := 1.0
	if qualityProfile == "quality_first" {
		profileMultiplier = 1.25
	} else if qualityProfile == "speed_first" {
		profileMultiplier = 0.8
	}
	baseLimit := detailOptions.MaxDetailUrls
	if effectiveAllLowSignal {
		baseLimit += 2
	}
	candidateLimit := int(math.Round(float64(baseLimit) * profileMultiplier))
	if candidateLimit < 1 {
		candidateLimit = 1
	}
	if candidateLimit > 30 {
		candidateLimit = 30
	}
	minCandidateScore := detailRelevanceToScore(detailOptions.MinRelevanceScore)

	// One pool, best score per URL, ordered by score (stable over the
	// primary-then-fallback insertion order).
	poolScores := map[string]float64{}
	poolOrder := make([]string, 0, len(primaryOrder)+len(fallbackOrder))
	for _, candidate := range primaryOrder {
		score := primaryScores[candidate]
		if !isFiniteNumber(score) {
			continue
		}
		if current, seen := poolScores[candidate]; !seen || score > current {
			poolScores[candidate] = score
			if !seen {
				poolOrder = append(poolOrder, candidate)
			}
		}
	}
	for _, candidate := range fallbackOrder {
		score := fallbackScores[candidate]
		if !isFiniteNumber(score) {
			continue
		}
		if current, seen := poolScores[candidate]; !seen || score > current {
			poolScores[candidate] = score
			if !seen {
				poolOrder = append(poolOrder, candidate)
			}
		}
	}
	pool := make([]candidateEntry, 0, len(poolOrder))
	for _, candidate := range poolOrder {
		pool = append(pool, candidateEntry{URL: candidate, Score: poolScores[candidate]})
	}
	sort.SliceStable(pool, func(left, right int) bool {
		return pool[left].Score > pool[right].Score
	})

	// The strongest candidates are probed once for a publish date; a probe
	// failure keeps the URL-path confidence (soft failure).
	topK := resolvePublishSignalTopK(candidateLimit, detailOptions.MaxDetailUrls, len(pool))
	topURLs := make([]string, 0, topK)
	for index := 0; index < topK && index < len(pool); index++ {
		topURLs = append(topURLs, pool[index].URL)
	}
	enrichmentSettings := s.publishSignalEnrichmentSettings()
	enrichment := s.enrichCandidatePublishSignals(ctx, topURLs, input.RequestTimeoutMs, enrichmentSettings)
	candidateSignals := make(map[string]publishCandidateSignal, len(pool))
	for _, entry := range pool {
		var enriched *publishCandidateSignal
		if value, ok := enrichment.Signals[entry.URL]; ok {
			copied := value
			enriched = &copied
		}
		candidateSignals[entry.URL] = resolveCandidatePublishSignal(entry.URL, enriched)
	}
	publishConfidenceThreshold := clampUnitInterval(detailOptions.MinPublishConfidence)
	fallbackPublishConfidenceThreshold := math.Max(0, publishConfidenceThreshold-0.15)
	primaryEntries := make([]candidateEntry, 0, len(primaryOrder))
	for _, candidate := range primaryOrder {
		score, seen := primaryScores[candidate]
		if !seen || !isFiniteNumber(score) {
			continue
		}
		if candidateSignals[candidate].Confidence >= publishConfidenceThreshold {
			primaryEntries = append(primaryEntries, candidateEntry{URL: candidate, Score: score})
		}
	}
	fallbackEntries := make([]candidateEntry, 0, len(fallbackOrder))
	for _, candidate := range fallbackOrder {
		score, seen := fallbackScores[candidate]
		if !seen || !isFiniteNumber(score) {
			continue
		}
		if candidateSignals[candidate].Confidence >= fallbackPublishConfidenceThreshold {
			fallbackEntries = append(fallbackEntries, candidateEntry{URL: candidate, Score: score})
		}
	}
	sort.SliceStable(primaryEntries, func(left, right int) bool {
		return primaryEntries[left].Score > primaryEntries[right].Score
	})
	sort.SliceStable(fallbackEntries, func(left, right int) bool {
		return fallbackEntries[left].Score > fallbackEntries[right].Score
	})
	publishConfidenceBuckets := buildDetailCandidateConfidenceBuckets(candidateSignals, poolOrder)

	minimumCandidateCount := resolveMinimumDetailExpansionCandidates(
		detailOptions.MaxDetailUrls, candidateLimit, effectiveAllLowSignal, qualityProfile)
	selectedSet := make(map[string]struct{}, candidateLimit)
	selectedOrder := make([]string, 0, candidateLimit)
	pushCandidates := func(entries []candidateEntry, threshold float64, targetSize int) int {
		if targetSize <= 0 {
			return 0
		}
		added := 0
		for _, entry := range entries {
			if !isFiniteNumber(entry.Score) || entry.Score < threshold {
				continue
			}
			if _, exists := selectedSet[entry.URL]; exists {
				continue
			}
			selectedSet[entry.URL] = struct{}{}
			selectedOrder = append(selectedOrder, entry.URL)
			added++
			if len(selectedSet) >= targetSize {
				break
			}
		}
		return added
	}
	strictCandidateCount := pushCandidates(primaryEntries, minCandidateScore, candidateLimit)
	relaxedCandidateCount := 0
	if len(selectedSet) < minimumCandidateCount {
		relaxedCandidateCount = pushCandidates(primaryEntries, minCandidateScore-80, minimumCandidateCount)
	}
	linkFallbackCandidateCount := 0
	if len(selectedSet) < minimumCandidateCount {
		linkFallbackCandidateCount = pushCandidates(fallbackEntries, minCandidateScore-140, minimumCandidateCount)
	}
	if len(selectedSet) == 0 && effectiveAllLowSignal && len(fallbackEntries) > 0 {
		pushCandidates(fallbackEntries, math.Inf(-1), 1)
	}
	candidates := selectedOrder
	if len(candidates) > candidateLimit {
		candidates = candidates[:candidateLimit]
	}

	if len(candidates) == 0 {
		if effectiveAllLowSignal {
			return nil, fmt.Errorf("crawl markdown is low-signal/list-like and no detail candidate URLs were extracted from the page content")
		}
		return nil, nil
	}

	detailCrawlOptions := s.buildDetailExpansionOptions(input.CrawlOptions, qualityProfile)
	batchSize := 3
	if qualityProfile == "quality_first" {
		batchSize = 2
	} else if qualityProfile == "speed_first" {
		batchSize = 4
	}
	expansionSuccesses := make([]crawl4ai.PipelineArticle, 0, 8)
	expansionFailures := make([]Failure, 0, 4)
	var expansionRunID *string
	for start := 0; start < len(candidates); start += batchSize {
		end := start + batchSize
		if end > len(candidates) {
			end = len(candidates)
		}
		batchURLs := candidates[start:end]
		payload := s.buildRequestPayload(input.Task, s.normalizer(), detailCrawlOptions)
		payload.URLs = batchURLs
		run, err := s.runCrawlWithHeadedFallback(ctx, crawlCall{
			Request:          payload,
			Options:          payload.Options,
			RequestTimeoutMs: input.RequestTimeoutMs,
			TaskID:           input.Task.ID,
			OrgID:            input.OrgID,
			Stage:            "expansion",
			Reason:           fmt.Sprintf("detail_batch_%d", start/batchSize+1),
		})
		if err != nil {
			message := extractCrawlErrorMessage(err)
			if message == "" {
				message = "detail expansion batch failed"
			}
			for _, candidateURL := range batchURLs {
				expansionFailures = append(expansionFailures, Failure{
					URL:       candidateURL,
					Message:   message,
					Retryable: isRetryableStatus(nil, message),
				})
			}
			continue
		}
		if expansionRunID == nil && run.Response.RunID != "" {
			runID := run.Response.RunID
			expansionRunID = &runID
		}
		expansionSuccesses = append(expansionSuccesses, run.Successes...)
		expansionFailures = append(expansionFailures, run.Failures...)
	}

	type improvedEntry struct {
		article crawl4ai.PipelineArticle
		quality articleSignal
	}
	improvedByURL := map[string]improvedEntry{}
	for _, article := range expansionSuccesses {
		if !isLikelyDetailArticleURL(article.URL, input.Task.TargetURL, detailOptions.RequireSameDomain, detailOptions.AllowExternalLinks) {
			continue
		}
		quality := assessArticleMarkdownSignal(article, true, now)
		if !isSignificantDetailImprovement(quality, baseScore, baseWords, maxLinkDensity) {
			continue
		}
		normalized := normalizeComparableURL(article.URL)
		selectedByExpansionCandidates := false
		if normalized != "" {
			_, selectedByExpansionCandidates = selectedSet[normalized]
		}
		if !selectedByExpansionCandidates {
			detailScore := scoreDetailCandidateURL(article.URL, input.Task.TargetURL)
			if isFiniteNumber(detailScore) && detailScore < minCandidateScore {
				continue
			}
		}
		key := normalized
		if key == "" {
			key = article.URL
		}
		current, exists := improvedByURL[key]
		if !exists || quality.Score > current.quality.Score {
			improvedByURL[key] = improvedEntry{article: article, quality: quality}
		}
	}
	improved := make([]improvedEntry, 0, len(improvedByURL))
	for _, entry := range improvedByURL {
		improved = append(improved, entry)
	}
	sort.SliceStable(improved, func(left, right int) bool {
		if improved[left].quality.Score != improved[right].quality.Score {
			return improved[left].quality.Score > improved[right].quality.Score
		}
		if improved[left].quality.WordCount != improved[right].quality.WordCount {
			return improved[left].quality.WordCount > improved[right].quality.WordCount
		}
		return improved[left].quality.LinkDensity < improved[right].quality.LinkDensity
	})
	preferredSegment := extractPrimaryPathSegment(input.Task.TargetURL)
	if preferredSegment != "" {
		preferred := make([]improvedEntry, 0, len(improved))
		nonPreferred := make([]improvedEntry, 0, len(improved))
		for _, entry := range improved {
			if urlMatchesPrimaryPathSegment(entry.article.URL, preferredSegment) {
				preferred = append(preferred, entry)
			} else {
				nonPreferred = append(nonPreferred, entry)
			}
		}
		if len(preferred) >= minIntValue(3, len(improved)) && len(preferred) > 0 {
			improved = preferred
		} else if len(preferred) > 0 {
			improved = append(preferred, nonPreferred...)
		}
	}
	profileBoost := 0
	if qualityProfile == "quality_first" {
		profileBoost = 2
	} else if qualityProfile == "speed_first" {
		profileBoost = -1
	}
	baseImproved := 5
	if effectiveAllLowSignal {
		baseImproved = 8
	}
	maxImproved := baseImproved + profileBoost
	if maxImproved < 1 {
		maxImproved = 1
	}
	if maxImproved > detailOptions.MaxDetailUrls {
		maxImproved = detailOptions.MaxDetailUrls
	}
	if maxImproved > len(improved) {
		maxImproved = len(improved)
	}
	improvedArticles := make([]crawl4ai.PipelineArticle, 0, maxImproved)
	for _, entry := range improved[:maxImproved] {
		improvedArticles = append(improvedArticles, entry.article)
	}

	improvedSampleRows := make([]map[string]any, 0, minIntValue(5, len(improved)))
	for index, entry := range improved {
		if index >= 5 {
			break
		}
		improvedSampleRows = append(improvedSampleRows, map[string]any{
			"url":                   nullableStringValue(stringPtrOrNil(entry.article.URL)),
			"wordCount":             entry.quality.WordCount,
			"linkCount":             entry.quality.LinkCount,
			"linkDensity":           roundTo(entry.quality.LinkDensity, 3),
			"publishTimeConfidence": roundTo(entry.quality.PublishTimeConfidence, 3),
			"publishTimeSource":     entry.quality.PublishTimeSource,
			"mediaDensity":          roundTo(entry.quality.MediaDensity, 4),
			"domListRisk":           roundTo(entry.quality.DomListRisk, 3),
			"score":                 roundTo(entry.quality.Score, 2),
			"isListLike":            entry.quality.IsListLike,
		})
	}

	s.writeTaskLog(ctx, taskLogEntry{
		Queue:   crawlQueueName,
		JobID:   input.Task.ID,
		OrgID:   input.OrgID,
		Stage:   "expansion",
		Status:  "completed",
		Message: stringPtr(expansionLogMessage(len(improvedArticles))),
		Data: map[string]any{
			"qualityProfile":        qualityProfile,
			"pageTypeHint":          pageTypeHint,
			"pageKind":              pageKind,
			"detailExpansion":       detailOptions,
			"allLowSignal":          effectiveAllLowSignal,
			"forcedByLowSignalSeed": forceFromSeed,
			"totalSuccesses":        len(assessments),
			"lowSignalResults":      len(effectiveLowSignal),
			"lowSignalWords": map[string]any{
				"min": minLowSignalWords,
				"max": baseWords,
				"avg": roundTo(meanLowSignalWords, 1),
			},
			"lowSignalLinkDensity": map[string]any{
				"max": roundTo(maxLinkDensity, 3),
				"avg": roundTo(meanLowSignalLinkDensity, 3),
			},
			"qualitySamples":                             qualitySamples(effectiveLowSignal),
			"improvedSamples":                            improvedSampleRows,
			"minimumCandidateCount":                      minimumCandidateCount,
			"primaryCandidatePool":                       len(primaryOrder),
			"fallbackCandidatePool":                      len(fallbackOrder),
			"primaryCandidatePoolAfterConfidenceFilter":  len(primaryEntries),
			"fallbackCandidatePoolAfterConfidenceFilter": len(fallbackEntries),
			"strictCandidateCount":                       strictCandidateCount,
			"relaxedCandidateCount":                      relaxedCandidateCount,
			"linkFallbackCandidateCount":                 linkFallbackCandidateCount,
			"existingUrlSkipped":                         existingURLSkipped,
			"publishConfidenceThreshold":                 publishConfidenceThreshold,
			"fallbackPublishConfidenceThreshold":         fallbackPublishConfidenceThreshold,
			"publishConfidenceBuckets": map[string]any{
				"lt04":       publishConfidenceBuckets.LT04,
				"from04To06": publishConfidenceBuckets.From04To06,
				"from06To08": publishConfidenceBuckets.From06To08,
				"gte08":      publishConfidenceBuckets.GTE08,
			},
			"headSignalEnrichment": map[string]any{
				"attempted":              enrichment.Attempted,
				"succeeded":              enrichment.Succeeded,
				"failed":                 enrichment.Failed,
				"topK":                   topK,
				"skipped":                enrichment.Skipped,
				"configuredTimeoutMs":    enrichmentSettings.TimeoutMs,
				"configuredConcurrency":  enrichmentSettings.Concurrency,
				"configuredMaxReadBytes": enrichmentSettings.MaxReadBytes,
				"effectiveTimeoutMs":     enrichment.EffectiveTimeoutMs,
				"effectiveConcurrency":   enrichment.EffectiveConcurrency,
				"maxReadBytes":           enrichment.MaxReadBytes,
				"truncatedResponses":     enrichment.TruncatedResponses,
				"earlyStoppedResponses":  enrichment.EarlyStoppedResponses,
				"softFailures": map[string]any{
					"httpStatus":       enrichment.SoftFailures.HTTPStatus,
					"nonHtml":          enrichment.SoftFailures.NonHTML,
					"emptyHtml":        enrichment.SoftFailures.EmptyHTML,
					"networkOrTimeout": enrichment.SoftFailures.NetworkOrTimeout,
					"noPublishSignal":  enrichment.SoftFailures.NoPublishSignal,
				},
				"softFailureCount": enrichment.softFailureCount(),
			},
			"candidateCount":       len(candidates),
			"candidateTotalPool":   len(pool),
			"runId":                nullableStringValue(expansionRunID),
			"expansionSuccesses":   len(expansionSuccesses),
			"expansionFailures":    len(expansionFailures),
			"improvedSuccesses":    len(improvedArticles),
			"preferredPathSegment": nullableStringValue(stringPtrOrNil(preferredSegment)),
			"failureSamples":       failureSamples(expansionFailures, 5),
		},
	})
	if len(improvedArticles) == 0 {
		if effectiveAllLowSignal {
			return nil, fmt.Errorf("crawl markdown is low-signal/list-like and detail expansion did not produce richer article content (candidates=%d, expansionSuccesses=%d, expansionFailures=%d)",
				len(candidates), len(expansionSuccesses), len(expansionFailures))
		}
		return nil, nil
	}

	retained := make([]crawl4ai.PipelineArticle, 0, len(input.Successes))
	for index, article := range input.Successes {
		if _, low := lowSignalIndexes[index]; low {
			continue
		}
		retained = append(retained, article)
	}
	retainedURLs := map[string]struct{}{}
	for _, article := range retained {
		if normalized := normalizeComparableURL(article.URL); normalized != "" {
			retainedURLs[normalized] = struct{}{}
		}
	}
	dedupedImproved := make([]crawl4ai.PipelineArticle, 0, len(improvedArticles))
	for _, article := range improvedArticles {
		normalized := normalizeComparableURL(article.URL)
		if normalized == "" {
			dedupedImproved = append(dedupedImproved, article)
			continue
		}
		if _, exists := retainedURLs[normalized]; exists {
			continue
		}
		retainedURLs[normalized] = struct{}{}
		dedupedImproved = append(dedupedImproved, article)
	}
	return &expansionResult{
		Successes: append(retained, dedupedImproved...),
		Failures:  expansionFailures,
		RunID:     expansionRunID,
	}, nil
}

// candidateEntry is one candidate URL with its relevance score.
type candidateEntry struct {
	URL   string
	Score float64
}

// isFiniteNumber is Number.isFinite.
func isFiniteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// resolveArticleBaseURL is resolveArticleBaseUrl: the article URL, else the
// metadata url/sourceUrl.
func resolveArticleBaseURL(article crawl4ai.PipelineArticle) string {
	if trimmed := strings.TrimSpace(article.URL); trimmed != "" {
		return trimmed
	}
	if metadata := decodeMetadataMap(article.Metadata); metadata != nil {
		if value := pickRawString(metadata, "url", "sourceUrl", "source_url"); value != nil {
			return *value
		}
	}
	return ""
}

// scorePrimaryDetailCandidate is the primary-pool scoring step: the publish
// prefilter of extractDetailLinkCandidatesFromArticle, then the URL score.
func scorePrimaryDetailCandidate(candidate, baseURL string, minPublishConfidence float64) (float64, bool) {
	if minPublishConfidence > 0 {
		confidence := estimatePublishTimeConfidenceFromCandidateURL(candidate)
		if confidence < math.Max(0, minPublishConfidence-0.25) {
			return 0, false
		}
	}
	return scoreDetailCandidateURL(candidate, baseURL), true
}

// scoreFallbackDetailCandidate is the link-fallback caller scoring step: the
// publish prefilter with the relaxed threshold, then the URL score minus the
// fixed fallback penalty.
func scoreFallbackDetailCandidate(candidate, baseURL string, minPublishConfidence float64) (float64, bool) {
	if minPublishConfidence > 0 {
		confidence := estimatePublishTimeConfidenceFromCandidateURL(candidate)
		if confidence < math.Max(0, minPublishConfidence-0.25) {
			return 0, false
		}
	}
	return scoreDetailCandidateURL(candidate, baseURL) - 120, true
}

// resolveMinimumDetailExpansionCandidates is
// resolveMinimumDetailExpansionCandidates.
func resolveMinimumDetailExpansionCandidates(maxDetailUrls, candidateLimit int, allLowSignal bool, qualityProfile string) int {
	profileBoost := 0
	if qualityProfile == "quality_first" {
		profileBoost = 2
	} else if qualityProfile == "balanced" {
		profileBoost = 1
	}
	baseMinimum := 2
	if allLowSignal {
		baseMinimum = 3
	}
	desired := baseMinimum + profileBoost
	return maxIntValue(1, minIntValue(minIntValue(maxDetailUrls, candidateLimit), desired))
}

// extractFallbackDetailLinkCandidates is
// extractFallbackDetailLinkCandidatesFromArticle: the link buckets only, with
// the relaxed fallback URL shape and the publish prefilter.
func extractFallbackDetailLinkCandidates(
	article crawl4ai.PipelineArticle,
	baseURL string,
	options detailExpansionOptions,
	minPublishConfidence float64,
) []string {
	hrefs := articleLinkHrefs(article)
	if len(hrefs) == 0 {
		return nil
	}
	base, baseErr := url.Parse(baseURL)
	scores := map[string]float64{}
	order := make([]string, 0, len(hrefs))
	for _, href := range hrefs {
		resolved := resolveDetailCandidateURL(href, base, baseErr)
		if resolved == "" {
			continue
		}
		if !isLikelyFallbackDetailArticleURL(resolved, baseURL, options) {
			continue
		}
		if !detailCandidateAllowedByPattern(resolved, options) {
			continue
		}
		if minPublishConfidence > 0 {
			confidence := estimatePublishTimeConfidenceFromCandidateURL(resolved)
			if confidence < math.Max(0, minPublishConfidence-0.25) {
				continue
			}
		}
		score := scoreDetailCandidateURL(resolved, baseURL)
		if current, seen := scores[resolved]; !seen || score > current {
			scores[resolved] = score
			if !seen {
				order = append(order, resolved)
			}
		}
	}
	fallback := make([]candidateEntry, 0, len(order))
	for _, candidate := range order {
		fallback = append(fallback, candidateEntry{URL: candidate, Score: scores[candidate]})
	}
	sort.SliceStable(fallback, func(left, right int) bool {
		return fallback[left].Score > fallback[right].Score
	})
	if len(fallback) > 40 {
		fallback = fallback[:40]
	}
	candidates := make([]string, 0, len(fallback))
	for _, entry := range fallback {
		candidates = append(candidates, entry.URL)
	}
	return candidates
}

// detailCandidateAllowedByPattern applies the include/exclude URL patterns.
func detailCandidateAllowedByPattern(candidate string, options detailExpansionOptions) bool {
	if urlMatchesAnyPattern(candidate, options.ExcludeURLPatterns) {
		return false
	}
	if len(options.IncludeURLPatterns) > 0 && !urlMatchesAnyPattern(candidate, options.IncludeURLPatterns) {
		return false
	}
	return true
}

// fallbackBlockedPathPattern is the fallback URL-shape blocklist.
var fallbackBlockedPathPattern = regexp.MustCompile(
	`(^|/)(video|videos|photo|photos|gallery|podcast|tag|tags|topic|topics|section|sections|author|authors|archive|latest|live|newsletter|country|special-report|poll-of-polls)(/|$)`)

// isLikelyFallbackDetailArticleURL is isLikelyFallbackDetailArticleUrl: a looser
// shape than isLikelyDetailArticleUrl, used only to backfill candidates when the
// strict pool is empty.
func isLikelyFallbackDetailArticleURL(candidate, baseURL string, options detailExpansionOptions) bool {
	if isLikelyDetailArticleURL(candidate, baseURL, options.RequireSameDomain, options.AllowExternalLinks) {
		return true
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return false
	}
	base, baseErr := url.Parse(baseURL)
	if baseErr != nil {
		return false
	}
	sameRootDomain := getRootDomain(parsed.Hostname()) == getRootDomain(base.Hostname())
	if options.RequireSameDomain && !sameRootDomain {
		return false
	}
	if !options.AllowExternalLinks && !sameRootDomain {
		return false
	}
	segments := splitPathSegments(strings.TrimRight(parsed.Path, "/"))
	if len(segments) < 2 {
		return false
	}
	segmentsLower := make([]string, len(segments))
	for index, segment := range segments {
		segmentsLower[index] = strings.ToLower(segment)
	}
	if hasBlockedDetailPathSegments(segmentsLower) {
		return false
	}
	joined := strings.ToLower(strings.Join(segments, "/"))
	if fallbackBlockedPathPattern.MatchString(joined) {
		return false
	}
	lastSegment := segments[len(segments)-1]
	lastSegmentLower := strings.ToLower(lastSegment)
	if len(lastSegment) >= 16 && slugSeparatorPattern.MatchString(lastSegment) &&
		!isLikelyPathCategoryToken(lastSegmentLower) {
		return true
	}
	if len(segments) >= 2 && len(lastSegment) >= 12 && slugSeparatorPattern.MatchString(lastSegment) &&
		!isLikelyPathCategoryToken(lastSegmentLower) {
		return true
	}
	return false
}

// qualitySamples projects up to five low-signal signals for the task log.
func qualitySamples(signals []articleSignal) []map[string]any {
	limit := minIntValue(5, len(signals))
	samples := make([]map[string]any, 0, limit)
	for _, signal := range signals[:limit] {
		samples = append(samples, map[string]any{
			"wordCount":             signal.WordCount,
			"linkCount":             signal.LinkCount,
			"linkDensity":           roundTo(signal.LinkDensity, 3),
			"publishTimeConfidence": roundTo(signal.PublishTimeConfidence, 3),
			"publishTimeSource":     signal.PublishTimeSource,
			"mediaDensity":          roundTo(signal.MediaDensity, 4),
			"domListRisk":           roundTo(signal.DomListRisk, 3),
			"bulletLines":           signal.BulletLines,
			"score":                 roundTo(signal.Score, 2),
		})
	}
	return samples
}

func expansionLogMessage(improved int) string {
	if improved > 0 {
		return fmt.Sprintf("Detail expansion selected %d richer article result(s)", improved)
	}
	return "Detail expansion did not produce richer markdown"
}

// buildDetailExpansionOptions is buildDetailExpansionOptions.
func (s *Service) buildDetailExpansionOptions(options normalizedOptions, qualityProfile string) normalizedOptions {
	qualityWordCountThreshold := minIntPtrValue(options.WordCountThreshold, 80, 40)
	contentSource := "raw_html"
	if qualityProfile == "quality_first" {
		qualityWordCountThreshold = minIntPtrValue(options.WordCountThreshold, 80, 30)
		contentSource = "cleaned_html"
	} else if qualityProfile == "speed_first" {
		qualityWordCountThreshold = minIntPtrValue(options.WordCountThreshold, 80, 50)
		if options.MarkdownOptions != nil && options.MarkdownOptions.ContentSource != nil {
			contentSource = *options.MarkdownOptions.ContentSource
		}
	}
	citations := true
	if options.MarkdownOptions != nil && options.MarkdownOptions.Citations != nil {
		citations = *options.MarkdownOptions.Citations
	}
	input := optionsToInput(options)
	input.AdditionalURLs = nil
	input.MultiURLConfigs = nil
	input.ScanFullPage = boolPtr(false)
	input.ScrollDelayMs = nil
	input.VirtualScroll = nil
	input.MarkdownFilter = nil
	input.ExtractLinks = boolPtr(false)
	input.WordCountThreshold = intPtrOf(qualityWordCountThreshold)
	input.MarkdownOptions = fallbackMarkdownOptionsInput(options.MarkdownOptions, contentSource, citations)
	if options.CleanMarkdown != nil {
		wordCount := 20
		if options.CleanMarkdown.WordCountThreshold != nil && *options.CleanMarkdown.WordCountThreshold < 40 {
			wordCount = *options.CleanMarkdown.WordCountThreshold
		}
		input.CleanMarkdown = &crawloptions.CleanMarkdownInput{
			TargetElements:        options.CleanMarkdown.TargetElements,
			ExcludedTags:          options.CleanMarkdown.ExcludedTags,
			RemoveOverlayElements: options.CleanMarkdown.RemoveOverlayElements,
			WordCountThreshold:    intPtrOf(wordCount),
		}
	} else {
		input.CleanMarkdown = &crawloptions.CleanMarkdownInput{
			RemoveOverlayElements: boolPtr(true),
			WordCountThreshold:    intPtrOf(20),
		}
	}
	input.DetailExpansion = nil
	input.AutoExpandDetails = boolPtr(false)
	return s.normalizer().Normalize(input)
}

// extractDetailLinkCandidates is extractDetailLinkCandidatesFromArticle: link
// objects are resolved against the article URL, filtered by the same-domain,
// detail-URL shape and include/exclude pattern rules, then de-duplicated.
func extractDetailLinkCandidates(article crawl4ai.PipelineArticle, baseURL string, options detailExpansionOptions) []string {
	hrefs := articleLinkHrefs(article)
	if len(hrefs) == 0 {
		return nil
	}
	base, baseErr := url.Parse(baseURL)
	candidates := make([]string, 0, len(hrefs))
	seen := map[string]struct{}{}
	for _, href := range hrefs {
		resolved := resolveDetailCandidateURL(href, base, baseErr)
		if resolved == "" {
			continue
		}
		if _, exists := seen[resolved]; exists {
			continue
		}
		if !detailCandidateAllowed(resolved, baseURL, options) {
			continue
		}
		seen[resolved] = struct{}{}
		candidates = append(candidates, resolved)
	}
	return candidates
}

// articleLinkHrefs flattens every link bucket into hrefs.
func articleLinkHrefs(article crawl4ai.PipelineArticle) []string {
	if len(article.Links) == 0 {
		return nil
	}
	var buckets map[string][]map[string]any
	if err := json.Unmarshal(article.Links, &buckets); err != nil {
		return nil
	}
	kinds := make([]string, 0, len(buckets))
	for kind := range buckets {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	hrefs := make([]string, 0, 32)
	for _, kind := range kinds {
		for _, entry := range buckets[kind] {
			href := pickMapString(entry, "href", "url")
			if href == "" {
				continue
			}
			hrefs = append(hrefs, href)
		}
	}
	return hrefs
}

// resolveDetailCandidateURL is normalizeDetailCandidateUrl's resolution step.
func resolveDetailCandidateURL(href string, base *url.URL, baseErr error) string {
	trimmed := strings.TrimSpace(href)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "" && parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	if parsed.Scheme == "" {
		if baseErr != nil || base == nil {
			return ""
		}
		parsed = base.ResolveReference(parsed)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	if parsed.Hostname() == "" {
		return ""
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return normalizeComparableURL(parsed.String())
}

// detailCandidateAllowed applies the URL-shape, same-domain and include/exclude
// pattern rules.
func detailCandidateAllowed(candidate, baseURL string, options detailExpansionOptions) bool {
	if !isLikelyDetailArticleURL(candidate, baseURL, options.RequireSameDomain, options.AllowExternalLinks) {
		return false
	}
	if urlMatchesAnyPattern(candidate, options.ExcludeURLPatterns) {
		return false
	}
	if len(options.IncludeURLPatterns) > 0 && !urlMatchesAnyPattern(candidate, options.IncludeURLPatterns) {
		return false
	}
	return true
}

// scoreDetailCandidateURL is CrawlPublishSignalService.scoreDetailCandidateUrl
// without the HEAD enrichment.
func scoreDetailCandidateURL(candidate, baseURL string) float64 {
	parsed, err := url.Parse(candidate)
	if err != nil {
		return math.Inf(-1)
	}
	pathname := strings.TrimRight(parsed.Path, "/")
	segments := splitPathSegments(pathname)
	if len(segments) == 0 {
		return math.Inf(-1)
	}
	segmentsLower := make([]string, len(segments))
	for index, segment := range segments {
		segmentsLower[index] = strings.ToLower(segment)
	}
	lastSegment := segments[len(segments)-1]
	lastSegmentLower := strings.ToLower(lastSegment)
	confidence := estimatePublishTimeConfidenceFromCandidateURL(candidate)
	score := math.Round(confidence * 80)
	if hasBlockedDetailPathSegments(segmentsLower) {
		score -= 400
	}
	if dateSuffixPattern.MatchString(lastSegment) {
		score += 220
	}
	if regexp.MustCompile(`[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$`).MatchString(lastSegment) {
		score += 150
	}
	if regexp.MustCompile(`(?i)(?:^|-)id[a-z0-9]{7,}$`).MatchString(lastSegment) {
		score += 130
	}
	hasArticleSegment := false
	for _, segment := range segments {
		if segment == "article" || segment == "articles" {
			hasArticleSegment = true
			break
		}
	}
	if hasArticleSegment {
		score += 100
	}
	if hasArticleLeadPathSegment(segmentsLower) {
		score += 30
	}
	if len(segments) >= 4 && slugSeparatorPattern.MatchString(lastSegment) {
		score += 80
	}
	if len(segments) >= 2 && len(lastSegment) >= 18 && slugSeparatorPattern.MatchString(lastSegment) &&
		!isLikelyPathCategoryToken(lastSegmentLower) {
		score += 65
	}
	if len(segments) >= 2 && regexp.MustCompile(`^\d{7,}$`).MatchString(lastSegment) {
		score += 95
	}
	if len(segments) >= 2 && regexp.MustCompile(`^[a-z0-9]{8,}$`).MatchString(lastSegmentLower) &&
		!isLikelyPathCategoryToken(lastSegmentLower) {
		score += 35
	}
	if len(segments) >= 3 {
		score += 18
	}
	if strings.Contains(strings.ToLower(parsed.Path), "/world/") {
		score += 16
	}
	if baseURL != "" {
		if base, baseErr := url.Parse(baseURL); baseErr == nil {
			baseSegments := splitPathSegments(strings.TrimRight(base.Path, "/"))
			if len(baseSegments) > 0 {
				baseFirst := strings.ToLower(baseSegments[0])
				if len(segmentsLower) > 0 && baseFirst == segmentsLower[0] {
					score += 120
				} else {
					score -= 90
				}
			}
			if len(baseSegments) > 1 && len(segmentsLower) > 1 && strings.ToLower(baseSegments[1]) == segmentsLower[1] {
				score += 30
			}
		}
	}
	likelySectionTail := map[string]struct{}{
		"world": {}, "business": {}, "markets": {}, "technology": {}, "tech": {},
		"opinion": {}, "sport": {}, "sports": {}, "news": {}, "japan": {}, "us": {},
		"china": {}, "europe": {}, "ukraine": {}, "russia": {}, "latest": {}, "archive": {},
	}
	if len(segments) <= 3 {
		if _, section := likelySectionTail[lastSegmentLower]; section {
			score -= 180
		}
	}
	for _, segment := range segmentsLower {
		switch segment {
		case "video", "videos", "photos", "photo", "gallery", "graphics", "podcast",
			"tag", "tags", "topic", "topics", "section", "sections", "authors", "author":
			score -= 150
		}
	}
	if parsed.RawQuery != "" {
		score -= 12
	}
	return score
}

func splitPathSegments(pathname string) []string {
	segments := make([]string, 0, 8)
	for _, segment := range strings.Split(pathname, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

// detailRelevanceToScore is detailRelevanceToScore.
func detailRelevanceToScore(minRelevanceScore float64) float64 {
	if minRelevanceScore <= 0 {
		return math.Inf(-1)
	}
	return minRelevanceScore*300 - 120
}

// estimatePublishTimeConfidenceFromCandidateURL is
// estimatePublishTimeConfidenceFromCandidateUrl (URL-path confidence only).
func estimatePublishTimeConfidenceFromCandidateURL(candidate string) float64 {
	parsed, err := url.Parse(candidate)
	if err != nil {
		return 0.3
	}
	path := strings.ToLower(parsed.Path)
	if match := articleDateSlash.FindStringSubmatch(path); match != nil {
		if _, ok := utcDateMilliseconds(match[1], match[2], match[3]); ok {
			return 0.82
		}
	}
	if match := articleDateDashed.FindStringSubmatch(path); match != nil {
		if _, ok := utcDateMilliseconds(match[1], match[2], match[3]); ok {
			return 0.82
		}
	}
	segments := splitPathSegments(strings.TrimRight(parsed.Path, "/"))
	if len(segments) == 0 {
		return 0.38
	}
	lastSegment := strings.ToLower(segments[len(segments)-1])
	if regexp.MustCompile(`^\d{7,}$`).MatchString(lastSegment) {
		return 0.74
	}
	for _, segment := range segments {
		if segment == "article" || segment == "articles" {
			return 0.6
		}
	}
	if len(segments) >= 3 && slugSeparatorPattern.MatchString(lastSegment) {
		return 0.56
	}
	return 0.38
}

// extractPrimaryPathSegment is extractPrimaryPathSegment.
func extractPrimaryPathSegment(targetURL string) string {
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return ""
	}
	segments := splitPathSegments(strings.TrimRight(parsed.Path, "/"))
	if len(segments) == 0 {
		return ""
	}
	return strings.ToLower(segments[0])
}

// urlMatchesPrimaryPathSegment is urlMatchesPrimaryPathSegment.
func urlMatchesPrimaryPathSegment(candidate, segment string) bool {
	parsed, err := url.Parse(candidate)
	if err != nil {
		return false
	}
	segments := splitPathSegments(strings.TrimRight(parsed.Path, "/"))
	if len(segments) == 0 {
		return false
	}
	return strings.ToLower(segments[0]) == segment
}
