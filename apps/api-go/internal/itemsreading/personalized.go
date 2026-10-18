package itemsreading

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

// This file ports the PERSONALIZED ordering of ItemsListService: the profile
// normalization, the incremental candidate window, the six-dimension feature
// scan and the ranking formula. The recency term here is the dedicated
// 1/(1+ageHours/36) curve; it is intentionally different from the relevance
// half-life decay.

const (
	// personalizedCandidateMin is the smallest candidate window.
	personalizedCandidateMin = 180
	// personalizedCandidateMax caps the ranking window and the reported total.
	personalizedCandidateMax = 1600
	// personalizedCandidateMultiplier grows the window from the required count.
	personalizedCandidateMultiplier = 8
	// personalizedRecencyScaleHours is the 36-hour recency denominator.
	personalizedRecencyScaleHours = 36.0
	// personalizedScoreEpsilon is the tie threshold of the final sort.
	personalizedScoreEpsilon = 0.0001
	// personalizedTermCap caps one profile dimension after normalization.
	personalizedTermCap = 400
)

// PersonalizationProvider is the behavior-profile surface the personalized
// ordering consumes. It is implemented by newsbehavior.Service; the domain only
// reads the positive/negative dimensions and never the legacy Meta map.
type PersonalizationProvider interface {
	GetPersonalizationProfile(ctx context.Context, orgID string, userID string) (personalnews.PersonalizationProfile, error)
}

// ItemPreferenceDimensions is one side of the domain personalization profile:
// named, strongly typed term scores keyed by the normalized term.
type ItemPreferenceDimensions struct {
	Sources  map[string]float64
	Topics   map[string]float64
	Entities map[string]float64
	Items    map[string]float64
	Events   map[string]float64
	Domains  map[string]float64
}

// ItemPersonalizationProfile is the domain profile. The legacy dynamic Meta
// object is deliberately dropped.
type ItemPersonalizationProfile struct {
	Positive ItemPreferenceDimensions
	Negative ItemPreferenceDimensions
}

// enabled reports whether any dimension carries a score.
func (p ItemPersonalizationProfile) enabled() bool {
	return len(p.Positive.Sources) > 0 || len(p.Positive.Topics) > 0 || len(p.Positive.Entities) > 0 ||
		len(p.Positive.Items) > 0 || len(p.Positive.Events) > 0 || len(p.Positive.Domains) > 0 ||
		len(p.Negative.Sources) > 0 || len(p.Negative.Topics) > 0 || len(p.Negative.Entities) > 0 ||
		len(p.Negative.Items) > 0 || len(p.Negative.Events) > 0 || len(p.Negative.Domains) > 0
}

// ItemCandidateFeatures is the per-candidate personalization feature set.
type ItemCandidateFeatures struct {
	Source   *string
	Domain   *string
	Topics   []string
	Entities []string
	EventIDs []string
}

// PersonalizedCandidateRow is one candidate window row.
type PersonalizedCandidateRow struct {
	ID        string
	CreatedAt time.Time
	SortAt    time.Time
}

// personalizedCandidateCursor is the incremental (sortAt, id) window cursor.
type personalizedCandidateCursor struct {
	ID     string
	SortAt time.Time
}

// personalizedPage ports listPersonalizedWithPage.
func (s *Service) personalizedPage(ctx context.Context, orgID string, userID string, args listArgs, offset int) (pageRows, error) {
	required := offset + args.take
	total, ranked, err := s.getPersonalizedRanking(ctx, orgID, userID, args, required)
	if err != nil {
		return pageRows{}, err
	}
	if total <= 0 || len(ranked) <= offset {
		return pageRows{rows: []ItemMetaRow{}, extra: map[string]rankedEdge{}, total: total}, nil
	}
	end := offset + args.take
	if end > len(ranked) {
		end = len(ranked)
	}
	picked := ranked[offset:end]
	pageIDs := make([]string, 0, len(picked))
	for _, entry := range picked {
		pageIDs = append(pageIDs, entry.ID)
	}
	rowsByID, err := s.fetchItemMetaRowsByIDs(ctx, orgID, pageIDs)
	if err != nil {
		return pageRows{}, err
	}
	rows := make([]ItemMetaRow, 0, len(picked))
	extra := make(map[string]rankedEdge, len(picked))
	for _, entry := range picked {
		row, ok := rowsByID[entry.ID]
		if !ok {
			continue
		}
		rows = append(rows, row)
		rankOffset := entry.RankOffset
		extra[entry.ID] = rankedEdge{RankOffset: &rankOffset}
	}
	return pageRows{rows: rows, extra: extra, total: total}, nil
}

// personalizedCursor ports listPersonalizedWithCursor.
//
// The relocation order is the opposite of RELEVANCE: a valid non-negative
// offset advances first, and only when no offset is present is the cursor id
// looked up in the ranking. Keeping the two rules separate preserves the
// NestJS contract for clients that only ever sent one of the two shapes.
func (s *Service) personalizedCursor(ctx context.Context, orgID string, userID string, args listArgs, cursor *ItemsCursorPayload) (ItemConnectionResult, error) {
	offset := 0
	if cursor != nil && cursor.Offset != nil && *cursor.Offset >= 0 {
		offset = *cursor.Offset + 1
	}
	total, ranked, err := s.getPersonalizedRanking(ctx, orgID, userID, args, offset+args.take+1)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	if offset <= 0 && cursor != nil && strings.TrimSpace(cursor.ID) != "" {
		for index, entry := range ranked {
			if entry.ID == cursor.ID {
				offset = index + 1
				break
			}
		}
	}
	if total <= 0 || len(ranked) <= offset {
		return emptyConnection(total), nil
	}
	window := ranked[offset:]
	if len(window) > args.take+1 {
		window = window[:args.take+1]
	}
	hasNextPage := len(window) > args.take || offset+args.take < total
	if hasNextPage && len(window) > args.take {
		window = window[:args.take]
	}
	pageIDs := make([]string, 0, len(window))
	for _, entry := range window {
		pageIDs = append(pageIDs, entry.ID)
	}
	rowsByID, err := s.fetchItemMetaRowsByIDs(ctx, orgID, pageIDs)
	if err != nil {
		return ItemConnectionResult{}, err
	}
	edges := make([]ItemListEdge, 0, len(window))
	for _, entry := range window {
		row, ok := rowsByID[entry.ID]
		if !ok {
			continue
		}
		rankOffset := entry.RankOffset
		edges = append(edges, ItemListEdge{
			Row:        row,
			RankOffset: &rankOffset,
			Cursor:     encodeRowCursor(ItemsRankingRecency, ItemsListOrderPersonalized, row, &rankOffset),
		})
	}
	return ItemConnectionResult{Edges: edges, HasNextPage: hasNextPage, TotalCount: total}, nil
}

// getPersonalizedRanking ports getPersonalizedRanking. The reported total is
// min(rawTotal, PERSONALIZED_CANDIDATE_MAX); the candidate window is grown
// incrementally rather than being capped at a fixed page, so deep pages do not
// end early.
func (s *Service) getPersonalizedRanking(ctx context.Context, orgID string, userID string, args listArgs, requiredCount int) (int, []rankedItem, error) {
	candidates := scopedCandidates(args)
	var (
		rawTotal int
		err      error
	)
	if s.readModelEnabled {
		rawTotal, err = s.mongo.CountReadModelMetaRows(ctx, orgID, candidates)
	} else {
		rawTotal, err = s.mysql.CountItemMeta(ctx, orgID, candidates)
	}
	if err != nil {
		return 0, nil, err
	}
	if rawTotal <= 0 {
		return 0, nil, nil
	}
	total := rawTotal
	if total > personalizedCandidateMax {
		total = personalizedCandidateMax
	}
	targetCount := requiredCount
	if targetCount < 1 {
		targetCount = 1
	}
	if targetCount > total {
		targetCount = total
	}
	initialCandidateTake := int(math.Floor(float64(requiredCount) * personalizedCandidateMultiplier))
	if initialCandidateTake < personalizedCandidateMin {
		initialCandidateTake = personalizedCandidateMin
	}
	if initialCandidateTake > personalizedCandidateMax {
		initialCandidateTake = personalizedCandidateMax
	}

	profile, err := s.loadItemPersonalizationProfile(ctx, orgID, userID)
	if err != nil {
		return 0, nil, err
	}
	candidateRows, err := s.collectPersonalizedCandidates(ctx, orgID, args, total, targetCount, initialCandidateTake)
	if err != nil {
		return 0, nil, err
	}
	ranked, err := s.rankPersonalizedCandidates(ctx, orgID, candidateRows, profile)
	if err != nil {
		return 0, nil, err
	}
	return total, ranked, nil
}

// personalizedCandidateBatch is one incremental window fetch.
type personalizedCandidateBatch struct {
	candidates []PersonalizedCandidateRow
	nextCursor *personalizedCandidateCursor
	rawCount   int
	exhausted  bool
}

// collectPersonalizedCandidates ports collectPersonalizedCandidates: it keeps
// widening the (sortAt, id) window until the required count is reached, the base
// range is exhausted or the window can no longer grow.
func (s *Service) collectPersonalizedCandidates(
	ctx context.Context,
	orgID string,
	args listArgs,
	total int,
	targetCount int,
	initialCandidateTake int,
) ([]PersonalizedCandidateRow, error) {
	if total <= 0 || targetCount <= 0 {
		return nil, nil
	}
	collected := make([]PersonalizedCandidateRow, 0, targetCount)
	seen := make(map[string]struct{}, targetCount)
	var cursor *personalizedCandidateCursor
	exhausted := false
	candidateTake := initialCandidateTake
	if candidateTake > total {
		candidateTake = total
	}
	fetchedWindowSize := 0

	for !exhausted && len(collected) < targetCount && fetchedWindowSize < total {
		targetWindowSize := candidateTake
		if targetWindowSize > total {
			targetWindowSize = total
		}
		deltaTake := targetWindowSize - fetchedWindowSize
		if deltaTake <= 0 {
			break
		}
		batch, err := s.fetchPersonalizedCandidateBatch(ctx, orgID, args, deltaTake, cursor)
		if err != nil {
			return nil, err
		}
		fetchedWindowSize += batch.rawCount
		if batch.nextCursor != nil {
			cursor = batch.nextCursor
		}
		exhausted = batch.exhausted
		for _, candidate := range batch.candidates {
			if _, ok := seen[candidate.ID]; ok {
				continue
			}
			seen[candidate.ID] = struct{}{}
			collected = append(collected, candidate)
		}
		if len(collected) >= targetCount || exhausted || targetWindowSize >= total {
			break
		}
		candidateTake = targetWindowSize * 2
		if candidateTake > personalizedCandidateMax {
			candidateTake = personalizedCandidateMax
		}
	}
	return collected, nil
}

// fetchPersonalizedCandidateBatch ports fetchPersonalizedCandidateBatch.
func (s *Service) fetchPersonalizedCandidateBatch(
	ctx context.Context,
	orgID string,
	args listArgs,
	take int,
	cursor *personalizedCandidateCursor,
) (personalizedCandidateBatch, error) {
	if take <= 0 {
		return personalizedCandidateBatch{exhausted: true}, nil
	}
	candidates := scopedCandidates(args)
	var raw []PersonalizedCandidateRow
	var err error
	if s.readModelEnabled {
		raw, err = s.mongo.FindReadModelCandidateWindow(ctx, orgID, candidates, cursor, take)
	} else {
		raw, err = s.mysql.FindItemMetaCandidateWindow(ctx, orgID, candidates, cursor, take)
	}
	if err != nil {
		return personalizedCandidateBatch{}, err
	}
	normalized := make([]PersonalizedCandidateRow, 0, len(raw))
	for _, candidate := range raw {
		if candidate.ID == "" || candidate.CreatedAt.IsZero() {
			continue
		}
		if candidate.SortAt.IsZero() {
			candidate.SortAt = candidate.CreatedAt
		}
		normalized = append(normalized, candidate)
	}
	var nextCursor *personalizedCandidateCursor
	if len(raw) >= take && len(normalized) > 0 {
		last := normalized[len(normalized)-1]
		nextCursor = &personalizedCandidateCursor{ID: last.ID, SortAt: last.SortAt}
	}
	return personalizedCandidateBatch{
		candidates: normalized,
		nextCursor: nextCursor,
		rawCount:   len(raw),
		exhausted:  len(raw) < take || nextCursor == nil,
	}, nil
}

// rankPersonalizedCandidates ports rankPersonalizedCandidates.
func (s *Service) rankPersonalizedCandidates(
	ctx context.Context,
	orgID string,
	candidates []PersonalizedCandidateRow,
	profile ItemPersonalizationProfile,
) ([]rankedItem, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	profileEnabled := profile.enabled()
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
	}
	featuresByID, err := s.loadCandidateFeatures(ctx, orgID, ids)
	if err != nil {
		return nil, err
	}
	now := time.Now()

	type scoredRow struct {
		id     string
		score  float64
		sortAt time.Time
	}
	scored := make([]scoredRow, 0, len(candidates))
	for _, candidate := range candidates {
		ageHours := now.Sub(candidate.SortAt).Hours()
		if ageHours < 0 {
			ageHours = 0
		}
		recencyScore := personalizedRecencyScore(ageHours)
		if !profileEnabled {
			scored = append(scored, scoredRow{id: candidate.ID, score: recencyScore, sortAt: candidate.SortAt})
			continue
		}
		feature, hasFeature := featuresByID[candidate.ID]
		if !hasFeature {
			feature = ItemCandidateFeatures{}
		}
		positiveRaw := s.sourcePreferenceScore(feature, profile.Positive.Sources)*1.15 +
			sumPreferenceScore(feature.Topics, profile.Positive.Topics, 6) +
			sumPreferenceScore(feature.Entities, profile.Positive.Entities, 6)*0.9 +
			behaviorItemScore(candidate.ID, profile.Positive.Items)*1.45 +
			sumPreferenceScore(feature.EventIDs, profile.Positive.Events, 4)*1.2 +
			behaviorDomainScore(feature.Domain, profile.Positive.Domains)*0.75
		negativeRaw := s.sourcePreferenceScore(feature, profile.Negative.Sources)*1.15 +
			sumPreferenceScore(feature.Topics, profile.Negative.Topics, 6) +
			sumPreferenceScore(feature.Entities, profile.Negative.Entities, 6)*0.9 +
			behaviorItemScore(candidate.ID, profile.Negative.Items)*1.45 +
			sumPreferenceScore(feature.EventIDs, profile.Negative.Events, 4)*1.2 +
			behaviorDomainScore(feature.Domain, profile.Negative.Domains)*0.75
		scored = append(scored, scoredRow{
			id:     candidate.ID,
			score:  personalizedFinalScore(personalizedBehaviorScore(positiveRaw, negativeRaw), recencyScore),
			sortAt: candidate.SortAt,
		})
	}

	// Tie-break: within 1e-4 the newer sortAt wins, then the id ascending. The
	// epsilon deliberately differs from the exact relevance comparator.
	sort.SliceStable(scored, func(i, j int) bool {
		if math.Abs(scored[j].score-scored[i].score) > personalizedScoreEpsilon {
			return scored[j].score < scored[i].score
		}
		if !scored[i].sortAt.Equal(scored[j].sortAt) {
			return scored[j].sortAt.Before(scored[i].sortAt)
		}
		return localeCompare(scored[i].id, scored[j].id) < 0
	})
	ranked := make([]rankedItem, 0, len(scored))
	for index, entry := range scored {
		ranked = append(ranked, rankedItem{ID: entry.id, Score: entry.score, RankOffset: index})
	}
	return ranked, nil
}

// personalizedRecencyScore is the personalized recency curve: 1 / (1 + age/36).
// It is deliberately different from the relevance half-life decay.
func personalizedRecencyScore(ageHours float64) float64 {
	return 1 / (1 + ageHours/personalizedRecencyScaleHours)
}

// personalizedBehaviorScore is the log-damped behavior term:
// log1p(max(0, positive)) - log1p(max(0, negative * 1.15)).
func personalizedBehaviorScore(positiveRaw, negativeRaw float64) float64 {
	return math.Log1p(math.Max(0, positiveRaw)) - math.Log1p(math.Max(0, negativeRaw*1.15))
}

// personalizedFinalScore is the personalized blend: 0.78 * behavior +
// 0.22 * recency. With no profile the caller uses the recency alone.
func personalizedFinalScore(behaviorScore, recencyScore float64) float64 {
	return behaviorScore*0.78 + recencyScore*0.22
}

// loadCandidateFeatures ports loadCandidateFeatures for both read-model modes.
func (s *Service) loadCandidateFeatures(ctx context.Context, orgID string, itemMetaIDs []string) (map[string]ItemCandidateFeatures, error) {
	out := make(map[string]ItemCandidateFeatures, len(itemMetaIDs))
	if len(itemMetaIDs) == 0 {
		return out, nil
	}
	if s.readModelEnabled {
		docsByID, err := s.readModel.loadItemReadModelsByIDs(ctx, orgID, itemMetaIDs)
		if err != nil {
			return nil, err
		}
		processedIDByMetaID := make(map[string]string, len(itemMetaIDs))
		processedIDs := make([]string, 0, len(itemMetaIDs))
		for _, itemMetaID := range itemMetaIDs {
			doc, ok := docsByID[itemMetaID]
			if !ok {
				continue
			}
			if doc.Processed != nil {
				if processedID := normalizeBehaviorID(doc.Processed.ID); processedID != "" {
					processedIDs = append(processedIDs, processedID)
					processedIDByMetaID[itemMetaID] = processedID
				}
			}
			out[itemMetaID] = ItemCandidateFeatures{
				Source:   normalizePreferenceKey(firstNonEmptyPtrString(doc.SourceID, doc.SourceName)),
				Domain:   normalizePreferenceKey(doc.Domain),
				Topics:   capStrings(doc.TopicKeys, 10),
				Entities: capStrings(doc.EntityKeys, 10),
			}
		}
		if len(processedIDs) > 0 {
			eventIDsByProcessed, err := s.mysql.NewsEventItemEventIDsByProcessedItemIDs(ctx, orgID, processedIDs)
			if err != nil {
				return nil, err
			}
			for itemMetaID, processedID := range processedIDByMetaID {
				feature := out[itemMetaID]
				feature.EventIDs = eventIDsByProcessed[processedID]
				out[itemMetaID] = feature
			}
		}
		return out, nil
	}

	aggregates, err := s.mongo.AggregateProcessedFeatures(ctx, orgID, itemMetaIDs)
	if err != nil {
		return nil, err
	}
	processedIDsByMetaID := make(map[string][]string, len(aggregates))
	processedIDsForEvents := make([]string, 0, len(aggregates))
	for _, aggregate := range aggregates {
		itemMetaID := normalizeBehaviorID(aggregate.ItemMetaID)
		if itemMetaID == "" {
			continue
		}
		result, _ := decodeResultRecord(aggregate.Result)
		sourceCandidate := firstNonEmptyPtrString(aggregate.SourceID, aggregate.Source)
		if sourceCandidate == nil {
			if fromResult := pickResultString(result, []string{"source"}); strings.TrimSpace(fromResult) != "" {
				value := fromResult
				sourceCandidate = &value
			}
		}
		ids := make([]string, 0, len(aggregate.ProcessedItemIDs))
		for _, raw := range aggregate.ProcessedItemIDs {
			normalized := normalizeBehaviorID(raw)
			if normalized == "" || stringInSlice(ids, normalized) {
				continue
			}
			ids = append(ids, normalized)
			if len(ids) >= 12 {
				break
			}
		}
		if len(ids) > 0 {
			processedIDsByMetaID[itemMetaID] = ids
			processedIDsForEvents = append(processedIDsForEvents, ids...)
		}
		out[itemMetaID] = ItemCandidateFeatures{
			Source:   normalizePreferenceKey(sourceCandidate),
			Topics:   normalizePreferenceTerms(result.Topics.Bytes()),
			Entities: normalizePreferenceTerms(result.Entities.Bytes()),
		}
	}

	domains, err := s.mongo.AggregateRawDomains(ctx, itemMetaIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range domains {
		itemMetaID := normalizeBehaviorID(row.ItemMetaID)
		if itemMetaID == "" {
			continue
		}
		domain := normalizePreferenceDomain(row.URL)
		if domain == "" {
			continue
		}
		feature, ok := out[itemMetaID]
		if ok {
			if feature.Domain == nil {
				value := domain
				feature.Domain = &value
			}
			out[itemMetaID] = feature
			continue
		}
		value := domain
		out[itemMetaID] = ItemCandidateFeatures{Domain: &value}
	}

	if len(processedIDsForEvents) > 0 {
		eventIDsByProcessed, err := s.mysql.NewsEventItemEventIDsByProcessedItemIDs(ctx, orgID, processedIDsForEvents)
		if err != nil {
			return nil, err
		}
		for itemMetaID, ids := range processedIDsByMetaID {
			eventIDs := make([]string, 0, 8)
			for _, processedID := range ids {
				for _, eventID := range eventIDsByProcessed[processedID] {
					if stringInSlice(eventIDs, eventID) {
						continue
					}
					eventIDs = append(eventIDs, eventID)
					if len(eventIDs) >= 8 {
						break
					}
				}
				if len(eventIDs) >= 8 {
					break
				}
			}
			feature := out[itemMetaID]
			feature.EventIDs = eventIDs
			out[itemMetaID] = feature
		}
	}
	return out, nil
}

// loadItemPersonalizationProfile ports loadItemPersonalizationProfile and
// converts the behavior profile into the domain dimensions.
func (s *Service) loadItemPersonalizationProfile(ctx context.Context, orgID string, userID string) (ItemPersonalizationProfile, error) {
	if s.personalization == nil {
		return ItemPersonalizationProfile{}, nil
	}
	profile, err := s.personalization.GetPersonalizationProfile(ctx, orgID, userID)
	if err != nil {
		return ItemPersonalizationProfile{}, err
	}
	return ItemPersonalizationProfile{
		Positive: ItemPreferenceDimensions{
			Sources:  parseBehaviorScores(profile.Positive.Sources, normalizePreferenceKeyString),
			Topics:   parseBehaviorScores(profile.Positive.Topics, normalizePreferenceKeyString),
			Entities: parseBehaviorScores(profile.Positive.Entities, normalizePreferenceKeyString),
			Items:    parseBehaviorScores(profile.Positive.Items, normalizeBehaviorID),
			Events:   parseBehaviorScores(profile.Positive.Events, normalizeBehaviorID),
			Domains:  parseBehaviorScores(profile.Positive.Domains, normalizePreferenceKeyString),
		},
		Negative: ItemPreferenceDimensions{
			Sources:  parseBehaviorScores(profile.Negative.Sources, normalizePreferenceKeyString),
			Topics:   parseBehaviorScores(profile.Negative.Topics, normalizePreferenceKeyString),
			Entities: parseBehaviorScores(profile.Negative.Entities, normalizePreferenceKeyString),
			Items:    parseBehaviorScores(profile.Negative.Items, normalizeBehaviorID),
			Events:   parseBehaviorScores(profile.Negative.Events, normalizeBehaviorID),
			Domains:  parseBehaviorScores(profile.Negative.Domains, normalizePreferenceKeyString),
		},
	}, nil
}

// parseBehaviorScores ports parseBehaviorScores: drop blank keys and
// non-positive/non-finite scores, order by score descending and keep the top
// personalizedTermCap entries.
func parseBehaviorScores(raw personalnews.ScoreMap, normalize func(string) string) map[string]float64 {
	if len(raw) == 0 {
		return map[string]float64{}
	}
	type entry struct {
		key   string
		score float64
	}
	entries := make([]entry, 0, len(raw))
	for term, value := range raw {
		normalized := normalize(term)
		if normalized == "" {
			continue
		}
		if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
			continue
		}
		entries = append(entries, entry{key: normalized, score: value})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].score > entries[j].score })
	if len(entries) > personalizedTermCap {
		entries = entries[:personalizedTermCap]
	}
	out := make(map[string]float64, len(entries))
	for _, item := range entries {
		out[item.key] = item.score
	}
	return out
}

// sourcePreferenceScore ports resolveSourcePreferenceScore: the larger of the
// source and domain scores, counting only positive values.
func (s *Service) sourcePreferenceScore(feature ItemCandidateFeatures, profile map[string]float64) float64 {
	score := 0.0
	if feature.Source != nil {
		if value, ok := profile[*feature.Source]; ok && isFinite(value) && value > score {
			score = value
		}
	}
	if feature.Domain != nil {
		if value, ok := profile[*feature.Domain]; ok && isFinite(value) && value > score {
			score = value
		}
	}
	return score
}

// behaviorItemScore looks the item id up in the profile, using the ID
// normalization rules.
func behaviorItemScore(itemID string, profile map[string]float64) float64 {
	normalized := normalizeBehaviorID(itemID)
	if normalized == "" {
		return 0
	}
	return profile[normalized]
}

// behaviorDomainScore looks the feature domain up in the profile.
func behaviorDomainScore(domain *string, profile map[string]float64) float64 {
	if domain == nil {
		return 0
	}
	return profile[*domain]
}

// sumPreferenceScore ports sumPreferenceScore: dedupe the terms, add the
// positive profile scores and stop after limit distinct terms.
func sumPreferenceScore(terms []string, profile map[string]float64, limit int) float64 {
	if len(terms) == 0 {
		return 0
	}
	score := 0.0
	consumed := 0
	seen := make(map[string]struct{}, len(terms))
	for _, term := range terms {
		if _, ok := seen[term]; ok {
			continue
		}
		seen[term] = struct{}{}
		if value, ok := profile[term]; ok && isFinite(value) && value > 0 {
			score += value
		}
		consumed++
		if consumed >= limit {
			break
		}
	}
	return score
}

// normalizePreferenceKey ports normalizePreferenceKey.
func normalizePreferenceKey(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := normalizePreferenceKeyString(*value)
	if normalized == "" {
		return nil
	}
	return &normalized
}

// normalizePreferenceKeyString ports normalizePreferenceKey for a plain string.
func normalizePreferenceKeyString(value string) string {
	normalized := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
	runes := []rune(normalized)
	if len(runes) > 96 {
		runes = runes[:96]
	}
	return string(runes)
}

// normalizeBehaviorID ports normalizeBehaviorId.
func normalizeBehaviorID(value string) string {
	normalized := strings.TrimSpace(value)
	runes := []rune(normalized)
	if len(runes) > 128 {
		runes = runes[:128]
	}
	return string(runes)
}

// normalizePreferenceTerms ports normalizePreferenceTerms over a typed result
// field: strings or {name,label,value} objects, deduped and capped at 10.
func normalizePreferenceTerms(raw []byte) []string {
	if len(raw) == 0 {
		return []string{}
	}
	terms := make([]string, 0, 8)
	seen := make(map[string]struct{}, 8)
	for _, element := range jsonArrayElements(raw) {
		candidate := elementText(element)
		normalized := normalizePreferenceKeyString(candidate)
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		terms = append(terms, normalized)
		if len(terms) >= 10 {
			break
		}
	}
	return terms
}

// normalizePreferenceDomain ports normalizePreferenceDomain: the lowercase
// hostname without a leading www, falling back to parsing the raw value as a
// URL with an https scheme.
func normalizePreferenceDomain(value *string) string {
	if value == nil {
		return ""
	}
	host := normalizeURLDomain(*value)
	if host == nil {
		return ""
	}
	return normalizePreferenceKeyString(*host)
}

// capStrings returns at most limit entries of values.
func capStrings(values []string, limit int) []string {
	if limit > 0 && len(values) > limit {
		return values[:limit]
	}
	return values
}

// FindReadModelCandidateWindow pages the read-model collection by the
// incremental (sortAt, itemMetaId) cursor into it. The window is ordered exactly
// like the MySQL variant so both read-model modes produce the same candidate
// order before ranking.
func (s *mongoStore) FindReadModelCandidateWindow(
	ctx context.Context,
	orgID string,
	scopedIDs []string,
	cursor *personalizedCandidateCursor,
	take int,
) ([]PersonalizedCandidateRow, error) {
	if scopedIDs != nil && len(scopedIDs) == 0 {
		return []PersonalizedCandidateRow{}, nil
	}
	if take <= 0 {
		return []PersonalizedCandidateRow{}, nil
	}
	base := readModelScopedMatch(orgID, scopedIDs)
	match := base
	if cursor != nil {
		match = bson.D{{Key: "$and", Value: bson.A{
			base,
			bson.D{{Key: "$or", Value: bson.A{
				bson.D{{Key: "sortAt", Value: bson.D{{Key: "$lt", Value: cursor.SortAt}}}},
				bson.D{{Key: "sortAt", Value: cursor.SortAt}, {Key: "itemMetaId", Value: bson.D{{Key: "$lt", Value: cursor.ID}}}},
			}}},
		}}}
	}
	opts := options.Find().
		SetProjection(bson.D{{Key: "itemMetaId", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "sortAt", Value: 1}}).
		SetSort(bson.D{{Key: "sortAt", Value: -1}, {Key: "itemMetaId", Value: -1}}).
		SetLimit(int64(take))
	rows, err := s.readModels().Find(ctx, match, opts)
	if err != nil {
		return nil, err
	}
	defer rows.Close(ctx)
	out := make([]PersonalizedCandidateRow, 0, take)
	for rows.Next(ctx) {
		var row struct {
			ItemMetaID string   `bson:"itemMetaId"`
			CreatedAt  *ISOTime `bson:"createdAt"`
			SortAt     *ISOTime `bson:"sortAt"`
		}
		if err := rows.Decode(&row); err != nil {
			return nil, err
		}
		candidate := PersonalizedCandidateRow{ID: strings.TrimSpace(row.ItemMetaID)}
		if row.CreatedAt != nil && !row.CreatedAt.IsZero() {
			candidate.CreatedAt = row.CreatedAt.Time
		}
		if row.SortAt != nil && !row.SortAt.IsZero() {
			candidate.SortAt = row.SortAt.Time
		}
		out = append(out, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// FindItemMetaCandidateWindow pages MySQL ItemMeta by the same incremental
// (sortAt, id) cursor. The projection is limited to the three columns the
// candidate normalization needs.
func (s *mySQLStore) FindItemMetaCandidateWindow(
	ctx context.Context,
	orgID string,
	scopedIDs []string,
	cursor *personalizedCandidateCursor,
	take int,
) ([]PersonalizedCandidateRow, error) {
	if scopedIDs != nil && len(scopedIDs) == 0 {
		return []PersonalizedCandidateRow{}, nil
	}
	if take <= 0 {
		return []PersonalizedCandidateRow{}, nil
	}
	query := "SELECT `id`, `createdAt`, `sortAt` FROM `ItemMeta`" + itemMetaBaseWhere
	args := make(mySQLArgs, 0, len(scopedIDs)+4)
	args = append(args, orgID)
	if len(scopedIDs) > 0 {
		query += mySQLInPredicate("`id`", len(scopedIDs))
		for _, id := range scopedIDs {
			args = append(args, id)
		}
	}
	if cursor != nil {
		query += " AND (`sortAt` < ? OR (`sortAt` = ? AND `id` < ?))"
		args = append(args, cursor.SortAt, cursor.SortAt, cursor.ID)
	}
	query += " ORDER BY `sortAt` DESC, `id` DESC LIMIT ?"
	args = append(args, take)

	sqlRows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer sqlRows.Close()
	out := make([]PersonalizedCandidateRow, 0, take)
	for sqlRows.Next() {
		var (
			id        string
			createdAt time.Time
			sortAt    time.Time
		)
		if err := sqlRows.Scan(&id, &createdAt, &sortAt); err != nil {
			return nil, err
		}
		out = append(out, PersonalizedCandidateRow{ID: id, CreatedAt: createdAt.UTC(), SortAt: sortAt.UTC()})
	}
	if err := sqlRows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
