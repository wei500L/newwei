package newsnowhottest

import (
	"context"
	"math"
	"net/url"
	"sort"
	"strings"
	"sync"

	"github.com/wei500L/newwei/apps/api-go/internal/newsnowsources"
)

// Recommended feed (T5). The scoring, filtering, dedupe and ordering are ported
// line by line from newsnow-recommended.service.ts. The five reads run in
// parallel; the hottest analysis call reuses the per-organization in-flight
// merge, so concurrent recommendations for one organization trigger one refresh.

const (
	recommendedDefaultLimit = 30
	recommendedMaxLimit     = 100
	recommendedMaxSources   = 120
	recommendedMaxPerSource = 8
	recommendedScoreLimit   = 4
)

// RecommendedInput is the GET /recommended argument.
type RecommendedInput struct {
	OrgID        string
	UserID       string
	Limit        *int
	ForceRefresh bool
}

// GetRecommendedFeed ports getRecommendedFeed.
func (s *Service) GetRecommendedFeed(ctx context.Context, input RecommendedInput) (RecommendedResponse, error) {
	if s == nil || s.catalog == nil || s.sources == nil || s.behavior == nil || s.settings == nil {
		return RecommendedResponse{}, errServiceNotConfigured
	}
	hottestSourceIDs := firstN(s.catalog.HottestSourceIDs(), recommendedMaxSources)
	if len(hottestSourceIDs) == 0 {
		return RecommendedResponse{
			Scope:       "hottest",
			GeneratedAt: isoTime(s.now()),
			Degraded:    true,
			Items:       []RecommendedItem{},
		}, nil
	}
	limit := recommendedDefaultLimit
	if input.Limit != nil {
		limit = *input.Limit
	}
	limit = maxInt(1, minInt(recommendedMaxLimit, limit))

	var (
		profile       ScoringProfile
		collaborative CollaborativeProfile
		settings      NewsnowUISettings
		settingsFound bool
		analysis      *AnalysisResponse
		analysisErr   error
		batch         newsnowsources.BatchResponse
		profileErr    error
		collabErr     error
		settingsErr   error
	)
	var wait sync.WaitGroup
	wait.Add(5)
	go func() {
		defer wait.Done()
		profile, profileErr = s.behavior.GetScoringProfile(ctx, input.OrgID, input.UserID)
	}()
	go func() {
		defer wait.Done()
		collaborative, collabErr = s.behavior.GetCollaborativeProfile(ctx, input.OrgID, input.UserID)
	}()
	go func() {
		defer wait.Done()
		settings, settingsFound, settingsErr = s.settings.NewsnowSettings(ctx, input.OrgID, input.UserID)
	}()
	go func() {
		defer wait.Done()
		response, err := s.GetHottestAnalysis(ctx, analysisInput{
			OrgID:        input.OrgID,
			UserID:       input.UserID,
			ForceRefresh: input.ForceRefresh,
		})
		if err != nil {
			analysisErr = err
			return
		}
		analysis = &response
	}()
	go func() {
		defer wait.Done()
		batch = s.sources.FetchBatch(ctx, hottestSourceIDs, input.ForceRefresh)
	}()
	wait.Wait()

	if profileErr != nil {
		return RecommendedResponse{}, profileErr
	}
	if collabErr != nil {
		return RecommendedResponse{}, collabErr
	}
	if settingsErr != nil {
		return RecommendedResponse{}, settingsErr
	}
	if !settingsFound {
		settings = NewsnowUISettings{FocusSources: []string{}, SourceAffinity: map[string]float64{}}
	}
	if settings.FocusSources == nil {
		settings.FocusSources = []string{}
	}
	if settings.SourceAffinity == nil {
		settings.SourceAffinity = map[string]float64{}
	}
	analysisDegraded := analysisErr != nil || analysis == nil
	maxContent := buildDimensionMaxima(profile)
	maxCollaborative := buildDimensionMaximaFromCollaborative(collaborative)
	sourceResults := make(map[string]newsnowsources.SourceResponse, len(batch.Results))
	for _, result := range batch.Results {
		sourceResults[result.ID] = result
	}

	candidates := make([]candidate, 0, len(hottestSourceIDs)*recommendedMaxPerSource)
	for _, sourceID := range hottestSourceIDs {
		source, exists := s.catalog.Source(sourceID)
		if !exists {
			continue
		}
		response, exists := sourceResults[sourceID]
		if !exists {
			continue
		}
		sourceName := source.Name
		if sourceName == "" {
			sourceName = sourceID
		}
		items := firstN(response.Items, recommendedMaxPerSource)
		for index, item := range items {
			next, ok := s.buildRecommendedCandidate(buildCandidateInput{
				sourceID:         sourceID,
				sourceName:       sourceName,
				source:           source,
				item:             item,
				itemIndex:        index,
				itemCount:        len(items),
				analysisBySource: analysis,
				profile:          profile,
				collaborative:    collaborative,
				settings:         settings,
				maxContent:       maxContent,
				maxCollaborative: maxCollaborative,
			})
			if !ok {
				continue
			}
			candidates = append(candidates, next)
		}
	}

	deduped := dedupeCandidates(candidates)
	sort.SliceStable(deduped, func(left, right int) bool {
		if deduped[left].FinalScore != deduped[right].FinalScore {
			return deduped[left].FinalScore > deduped[right].FinalScore
		}
		if deduped[left].HotnessScore != deduped[right].HotnessScore {
			return deduped[left].HotnessScore > deduped[right].HotnessScore
		}
		return localeCompare(deduped[left].ID, deduped[right].ID) < 0
	})
	// The limit is applied before the response projection, exactly like the
	// NestJS `.slice(0, limit)`.
	if len(deduped) > limit {
		deduped = deduped[:limit]
	}
	items := make([]RecommendedItem, 0, len(deduped))
	for _, entry := range deduped {
		items = append(items, RecommendedItem{
			ID:             entry.ID,
			SourceID:       entry.SourceID,
			SourceName:     entry.SourceName,
			Title:          entry.Title,
			URL:            entry.URL,
			MobileURL:      entry.MobileURL,
			PubDate:        entry.PubDate,
			Topics:         nonNilStrings(entry.Topics),
			Entities:       nonNilStrings(entry.Entities),
			MatchedItemID:  entry.MatchedItemID,
			MatchedEventID: entry.MatchedEventID,
			ReasonLabel:    entry.ReasonLabel,
			Score:          entry.FinalScore,
			ScoreBreakdown: ScoreBreakdown{
				Content:       entry.ContentScore,
				Collaborative: entry.CollaborativeScore,
				Source:        entry.SourceScore,
				Hotness:       entry.HotnessScore,
				Final:         entry.FinalScore,
			},
		})
	}
	degraded := analysisDegraded || collaborative.Degraded || len(batch.Errors) > 0
	return RecommendedResponse{
		Scope:       "hottest",
		GeneratedAt: isoTime(s.now()),
		Degraded:    degraded,
		Items:       items,
	}, nil
}

// buildCandidateInput is the strongly typed argument of buildRecommendedCandidate.
type buildCandidateInput struct {
	sourceID         string
	sourceName       string
	source           SourceDescriptor
	item             newsnowsources.NewsItem
	itemIndex        int
	itemCount        int
	analysisBySource *AnalysisResponse
	profile          ScoringProfile
	collaborative    CollaborativeProfile
	settings         NewsnowUISettings
	maxContent       dimensionMaxima
	maxCollaborative dimensionMaxima
}

// dimensionMaxima is buildDimensionMaxima.
type dimensionMaxima struct {
	Items    float64
	Events   float64
	Topics   float64
	Entities float64
	Domains  float64
}

// buildRecommendedCandidate ports buildCandidate.
func (s *Service) buildRecommendedCandidate(input buildCandidateInput) (candidate, bool) {
	title := jsTrim(input.item.Title)
	url := jsTrim(input.item.URL)
	if title == "" || url == "" {
		return candidate{}, false
	}
	signalKey := buildSignalKey(input.sourceID, title, url)
	itemID := input.item.ID.String()
	var analyzed *AnalyzedItem
	if input.analysisBySource != nil {
		if value, exists := input.analysisBySource.BySource.Lookup(input.sourceID, itemID); exists {
			analyzed = &value
		}
	}
	domain := normalizeDomain(url)
	var topics []string
	var entities []string
	var matchedItemID *string
	var matchedEventID *string
	isNew := false
	isRising := false
	var candidateScore *float64
	var freshnessScore *float64
	if analyzed != nil {
		topics = normalizeBehaviorTerms(analyzed.Topics)
		entities = normalizeBehaviorTerms(analyzed.Entities)
		matchedItemID = analyzed.MatchedItemID
		matchedEventID = analyzed.MatchedEventID
		isNew = analyzed.IsNew
		isRising = analyzed.IsRising
		score := analyzed.CandidateScore
		candidateScore = &score
		freshness := analyzed.FreshnessScore
		freshnessScore = &freshness
	}
	if blockedByNegativeFeedback(blockedInput{
		sourceID:       input.sourceID,
		sourceName:     input.sourceName,
		source:         input.source,
		matchedItemID:  matchedItemID,
		matchedEventID: matchedEventID,
		topics:         topics,
		entities:       entities,
		domain:         domain,
		negative:       input.profile.Negative,
	}) {
		return candidate{}, false
	}
	contentScore := computePreferenceScore(preferenceInput{
		matchedItemID:  matchedItemID,
		matchedEventID: matchedEventID,
		topics:         topics,
		entities:       entities,
		domain:         domain,
		record:         input.profile,
		maxima:         input.maxContent,
	})
	collaborativeScore := computePreferenceScore(preferenceInput{
		matchedItemID:  matchedItemID,
		matchedEventID: matchedEventID,
		topics:         topics,
		entities:       entities,
		domain:         domain,
		record: ScoringProfile{
			Sources:  input.collaborative.Sources,
			Topics:   input.collaborative.Topics,
			Entities: input.collaborative.Entities,
			Items:    input.collaborative.Items,
			Events:   input.collaborative.Events,
			Domains:  input.collaborative.Domains,
		},
		maxima: input.maxCollaborative,
	})
	sourceScore := computeSourceScore(input.sourceID, input.settings.FocusSources, input.settings.SourceAffinity)
	hotnessScore := computeHotnessScore(candidateScore, freshnessScore, input.itemIndex, input.itemCount)
	finalScore := roundN(
		contentScore*0.4+collaborativeScore*0.3+sourceScore*0.15+hotnessScore*0.15,
		4,
	)
	pubDate := nullableDate{}
	if input.item.PubDate != nil {
		if raw, ok := publicDateRaw(input.item.PubDate); ok {
			pubDate = nullableDate{Raw: raw, Valid: true}
		}
	}
	mobileURL := nullableString{}
	if input.item.MobileURL != nil {
		if trimmed := jsTrim(*input.item.MobileURL); trimmed != "" {
			mobileURL = stringOrNull(trimmed)
		}
	}
	return candidate{
		ID:                 input.sourceID + ":" + signalKey,
		SourceID:           input.sourceID,
		SourceName:         input.sourceName,
		Title:              title,
		URL:                url,
		MobileURL:          mobileURL,
		PubDate:            pubDate,
		Domain:             domain,
		Topics:             topics,
		Entities:           entities,
		MatchedItemID:      matchedItemID,
		MatchedEventID:     matchedEventID,
		ContentScore:       contentScore,
		CollaborativeScore: collaborativeScore,
		SourceScore:        sourceScore,
		HotnessScore:       hotnessScore,
		FinalScore:         finalScore,
		ReasonLabel: resolveReasonLabel(reasonInput{
			contentScore:       contentScore,
			collaborativeScore: collaborativeScore,
			sourceScore:        sourceScore,
			hotnessScore:       hotnessScore,
			focusSources:       input.settings.FocusSources,
			sourceID:           input.sourceID,
			isNew:              isNew,
			isRising:           isRising,
			matchedItemID:      matchedItemID,
			matchedEventID:     matchedEventID,
		}),
	}, true
}

// publicDateRaw keeps the source publication date literal.
func publicDateRaw(value *newsnowsources.DateValue) ([]byte, bool) {
	if value == nil {
		return nil, false
	}
	switch value.Kind {
	case newsnowsources.ValueString:
		text, _ := value.StringValue()
		encoded, err := marshalJSON(text)
		if err != nil {
			return nil, false
		}
		return encoded, true
	case newsnowsources.ValueNumber:
		if _, ok := value.Number(); !ok {
			return nil, false
		}
		return []byte(value.Text), true
	default:
		return nil, false
	}
}

// blockedInput is the negative-feedback filter argument.
type blockedInput struct {
	sourceID       string
	sourceName     string
	source         SourceDescriptor
	matchedItemID  *string
	matchedEventID *string
	topics         []string
	entities       []string
	domain         *string
	negative       NegativeScores
}

// blockedByNegativeFeedback ports isBlockedByNegativeFeedback.
func blockedByNegativeFeedback(input blockedInput) bool {
	if hasAnyPositiveScore(buildSourceBehaviorAliases(input.sourceID, input.source), input.negative.Sources) {
		return true
	}
	if hasPositiveScore(input.negative.Items, input.matchedItemID) {
		return true
	}
	if hasPositiveScore(input.negative.Events, input.matchedEventID) {
		return true
	}
	if hasPositiveScore(input.negative.Domains, input.domain) {
		return true
	}
	if hasAnyPositiveScore(input.topics, input.negative.Topics) {
		return true
	}
	return hasAnyPositiveScore(input.entities, input.negative.Entities)
}

// hasAnyPositiveScore reports whether any key has a positive score.
func hasAnyPositiveScore(keys []string, record ScoreMap) bool {
	for _, key := range keys {
		if hasPositiveScore(record, &key) {
			return true
		}
	}
	return false
}

// hasPositiveScore reports whether a non-empty key has a positive finite score.
func hasPositiveScore(record ScoreMap, key *string) bool {
	if key == nil {
		return false
	}
	trimmed := *key
	if trimmed == "" {
		return false
	}
	value, exists := record[trimmed]
	if !exists {
		return false
	}
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0
}

// buildSourceBehaviorAliases ports buildSourceBehaviorAliases.
func buildSourceBehaviorAliases(sourceID string, source SourceDescriptor) []string {
	aliases := make([]string, 0, 5)
	seen := make(map[string]struct{}, 5)
	push := func(value string) {
		normalized := normalizeBehaviorTerm(value)
		if normalized == nil {
			return
		}
		if _, exists := seen[*normalized]; exists {
			return
		}
		seen[*normalized] = struct{}{}
		aliases = append(aliases, *normalized)
	}
	push(sourceID)
	baseSourceID := sourceID
	if index := strings.Index(sourceID, "-"); index >= 0 {
		baseSourceID = sourceID[:index]
	}
	if baseSourceID != sourceID {
		push(baseSourceID)
	}
	push(source.Name)
	push(source.Title)
	if domain := extractDomainFromURL(source.Home); domain != nil {
		push(*domain)
	}
	return aliases
}

// buildDimensionMaxima ports buildDimensionMaxima over the scoring profile.
func buildDimensionMaxima(profile ScoringProfile) dimensionMaxima {
	return dimensionMaxima{
		Items:    maxRecordValue(profile.Items),
		Events:   maxRecordValue(profile.Events),
		Topics:   maxRecordValue(profile.Topics),
		Entities: maxRecordValue(profile.Entities),
		Domains:  maxRecordValue(profile.Domains),
	}
}

// buildDimensionMaximaFromCollaborative is the collaborative variant.
func buildDimensionMaximaFromCollaborative(profile CollaborativeProfile) dimensionMaxima {
	return dimensionMaxima{
		Items:    maxRecordValue(profile.Items),
		Events:   maxRecordValue(profile.Events),
		Topics:   maxRecordValue(profile.Topics),
		Entities: maxRecordValue(profile.Entities),
		Domains:  maxRecordValue(profile.Domains),
	}
}

// maxRecordValue is Math.max(0, ...Object.values(record)), or 0 when empty.
func maxRecordValue(record ScoreMap) float64 {
	best := 0.0
	for _, value := range record {
		if value > best {
			best = value
		}
	}
	return best
}

// preferenceInput is the computePreferenceScore argument.
type preferenceInput struct {
	matchedItemID  *string
	matchedEventID *string
	topics         []string
	entities       []string
	domain         *string
	record         ScoringProfile
	maxima         dimensionMaxima
}

// computePreferenceScore ports computePreferenceScore.
func computePreferenceScore(input preferenceInput) float64 {
	itemScore := normalizeTermScore(input.matchedItemID, input.record.Items, input.maxima.Items)
	eventScore := normalizeTermScore(input.matchedEventID, input.record.Events, input.maxima.Events)
	topicScore := averageNormalizedTerms(input.topics, input.record.Topics, input.maxima.Topics, recommendedScoreLimit)
	entityScore := averageNormalizedTerms(input.entities, input.record.Entities, input.maxima.Entities, recommendedScoreLimit)
	domainScore := normalizeTermScore(input.domain, input.record.Domains, input.maxima.Domains)
	return roundN(
		itemScore*0.32+eventScore*0.24+topicScore*0.18+entityScore*0.16+domainScore*0.1,
		4,
	)
}

// normalizeTermScore ports normalizeTermScore.
func normalizeTermScore(key *string, record ScoreMap, maxValue float64) float64 {
	if key == nil || *key == "" || maxValue <= 0 {
		return 0
	}
	value, exists := record[*key]
	if !exists || value <= 0 {
		return 0
	}
	return roundN(math.Min(1, value/maxValue), 4)
}

// averageNormalizedTerms ports averageNormalizedTerms.
func averageNormalizedTerms(terms []string, record ScoreMap, maxValue float64, limit int) float64 {
	if len(terms) == 0 || maxValue <= 0 {
		return 0
	}
	score := 0.0
	count := 0
	seen := make(map[string]struct{}, len(terms))
	for _, term := range terms {
		if term == "" {
			continue
		}
		if _, exists := seen[term]; exists {
			continue
		}
		seen[term] = struct{}{}
		score += normalizeTermScore(&term, record, maxValue)
		count++
		if count >= limit {
			break
		}
	}
	if count == 0 {
		return 0
	}
	return roundN(score/float64(count), 4)
}

// normalizeBehaviorTerms ports normalizeBehaviorTerms.
func normalizeBehaviorTerms(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		normalized := normalizeBehaviorTerm(value)
		if normalized == nil {
			continue
		}
		if _, exists := seen[*normalized]; exists {
			continue
		}
		seen[*normalized] = struct{}{}
		out = append(out, *normalized)
	}
	return out
}

// computeSourceScore ports computeSourceScore.
func computeSourceScore(sourceID string, focusSources []string, sourceAffinity map[string]float64) float64 {
	affinityRaw := sourceAffinity[sourceID]
	affinity := roundN(math.Max(0, math.Min(1, affinityRaw/100)), 4)
	focusBonus := 0.0
	for _, focus := range focusSources {
		if focus == sourceID {
			focusBonus = 0.25
			break
		}
	}
	return roundN(math.Min(1, affinity*0.75+focusBonus), 4)
}

// computeHotnessScore ports computeHotnessScore.
func computeHotnessScore(candidateScore, freshnessScore *float64, itemIndex, itemCount int) float64 {
	if candidateScore != nil && !math.IsNaN(*candidateScore) && !math.IsInf(*candidateScore, 0) &&
		freshnessScore != nil && !math.IsNaN(*freshnessScore) && !math.IsInf(*freshnessScore, 0) {
		return roundN(math.Min(1, *candidateScore*0.7+*freshnessScore*0.3), 4)
	}
	denominator := float64(itemCount)
	if denominator < 1 {
		denominator = 1
	}
	return roundN(math.Max(0.1, 1-float64(itemIndex)/denominator), 4)
}

// reasonInput is the resolveReasonLabel argument.
type reasonInput struct {
	contentScore       float64
	collaborativeScore float64
	sourceScore        float64
	hotnessScore       float64
	focusSources       []string
	sourceID           string
	isNew              bool
	isRising           bool
	matchedItemID      *string
	matchedEventID     *string
}

// resolveReasonLabel ports resolveReasonLabel.
func resolveReasonLabel(input reasonInput) string {
	type entry struct {
		key   string
		score float64
	}
	breakdown := []entry{
		{key: "content", score: input.contentScore},
		{key: "collaborative", score: input.collaborativeScore},
		{key: "source", score: input.sourceScore},
		{key: "hotness", score: input.hotnessScore},
	}
	sort.SliceStable(breakdown, func(left, right int) bool {
		return breakdown[left].score > breakdown[right].score
	})
	dominant := breakdown[0].key
	if dominant == "collaborative" && input.collaborativeScore > 0 {
		return "相似用户也在关注"
	}
	if dominant == "content" && input.contentScore > 0 {
		if input.matchedEventID != nil {
			return "匹配近期事件偏好"
		}
		if input.matchedItemID != nil {
			return "匹配近期阅读偏好"
		}
		return "匹配近期主题偏好"
	}
	if dominant == "source" && input.sourceScore > 0 {
		for _, focus := range input.focusSources {
			if focus == input.sourceID {
				return "来自你关注的来源"
			}
		}
		return "来源偏好较高"
	}
	if input.isRising {
		return "热点正在上升"
	}
	if input.isNew {
		return "新进入热点候选"
	}
	return "当前热度较高"
}

// dedupeCandidates ports dedupeCandidates: the first position wins, a higher
// final score replaces the value.
func dedupeCandidates(candidates []candidate) []candidate {
	order := make([]string, 0, len(candidates))
	byKey := make(map[string]candidate, len(candidates))
	for _, entry := range candidates {
		key := buildDedupeKey(entry)
		existing, exists := byKey[key]
		if !exists {
			order = append(order, key)
			byKey[key] = entry
			continue
		}
		if entry.FinalScore > existing.FinalScore {
			byKey[key] = entry
		}
	}
	out := make([]candidate, 0, len(order))
	for _, key := range order {
		out = append(out, byKey[key])
	}
	return out
}

// buildDedupeKey ports buildDedupeKey.
func buildDedupeKey(entry candidate) string {
	if variants, ok := comparableURLVariants(entry.URL); ok {
		return "url:" + toLowerCase(variants.Full)
	}
	if entry.MatchedEventID != nil && *entry.MatchedEventID != "" {
		return "event:" + *entry.MatchedEventID
	}
	if entry.MatchedItemID != nil && *entry.MatchedItemID != "" {
		return "item:" + *entry.MatchedItemID
	}
	return entry.SourceID + ":" + entry.ID
}

// normalizeBehaviorTerm ports normalizeBehaviorTerm.
func normalizeBehaviorTerm(value string) *string {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return nil
	}
	normalized := truncateJS(whitespaceRunPattern.ReplaceAllString(toLowerCase(trimmed), " "), 96)
	if normalized == "" {
		return nil
	}
	return &normalized
}

// normalizeDomain ports normalizeDomain.
func normalizeDomain(rawURL string) *string {
	parsed, ok := parseJSHost(rawURL)
	if !ok {
		return nil
	}
	return &parsed
}

// extractDomainFromURL ports extractDomainFromUrl.
func extractDomainFromURL(value string) *string {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return nil
	}
	if host, ok := parseJSHost(trimmed); ok {
		return &host
	}
	if host, ok := parseJSHost("https://" + trimmed); ok {
		return &host
	}
	return nil
}

// parseJSHost mirrors `new URL(value).hostname.trim().toLowerCase().replace(/^www\./,"")`.
// A value without scheme or host is treated as a parse failure, like the WHATWG
// constructor throwing.
func parseJSHost(value string) (string, bool) {
	parsed, err := url.Parse(jsTrim(value))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", false
	}
	host := toLowerCase(jsTrim(parsed.Hostname()))
	if host == "" {
		return "", false
	}
	host = strings.TrimPrefix(host, "www.")
	return host, true
}

// nonNilStrings renders nil slices as empty arrays.
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// maxInt returns the larger value.
func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

// minInt returns the smaller value.
func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
