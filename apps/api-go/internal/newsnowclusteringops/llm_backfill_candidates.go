package newsnowclusteringops

import (
	"context"
	"sort"
	"strings"
	"time"
)

// candidateScore is the merged score state of one event. A nil pointer means
// that origin did not produce the event.
type candidateScore struct {
	vector  *float64
	overlap *float64
}

// listAssignmentCandidates mirrors
// NewsEventsService.listAssignmentCandidatesForSignal: it merges the vector
// candidates of the article summary with the local topic/entity overlap
// candidates, applies the language penalty and the category gate, then returns
// the highest scoring events.
//
// A vector-search failure is not an error: it behaves exactly like the NestJS
// searchBestEffort returning null, so the local candidates still make the
// decision possible. The Go implementation deliberately keeps no in-process
// circuit breaker; every claim performs one best-effort search.
func (s *Service) listAssignmentCandidates(ctx context.Context, orgID string, signal newsSignal, settings newsEventSettings, limit int, searcher SummaryVectorSearcher) ([]AssignmentCandidate, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > 12 {
		limit = 12
	}
	primaryTopic := pickPrimaryTopic(signal.Topics)
	primaryEntity := pickPrimaryEntity(signal.Entities)
	state := make(map[string]*candidateScore)

	if searcher != nil {
		if err := s.collectVectorCandidates(ctx, orgID, signal, settings, searcher, state); err != nil {
			return nil, err
		}
	}
	if err := s.collectOverlapCandidates(ctx, orgID, signal, primaryTopic, primaryEntity, settings, state); err != nil {
		return nil, err
	}

	eventIDs := make([]string, 0, len(state))
	for eventID := range state {
		eventIDs = append(eventIDs, eventID)
	}
	if len(eventIDs) == 0 {
		return nil, nil
	}
	// Keep the event query deterministic; the final sort below is stable and
	// uses score then lastAt, matching the NestJS sort.
	sort.Strings(eventIDs)
	events, err := s.clustering.listNewsEventCandidateDetails(ctx, orgID, eventIDs)
	if err != nil {
		return nil, err
	}
	return projectAssignmentCandidates(state, events, limit), nil
}

// projectAssignmentCandidates merges the two score origins and applies the
// NestJS projection and ordering. It is pure so the merge and sort rules can be
// unit tested without a database.
func projectAssignmentCandidates(state map[string]*candidateScore, events []newsEventCandidateDetail, limit int) []AssignmentCandidate {
	candidates := make([]AssignmentCandidate, 0, len(events))
	for i := range events {
		event := events[i]
		scoreState := state[event.ID]
		if scoreState == nil {
			continue
		}
		score := 0.0
		if scoreState.vector != nil && *scoreState.vector > score {
			score = *scoreState.vector
		}
		if scoreState.overlap != nil && *scoreState.overlap > score {
			score = *scoreState.overlap
		}
		origin := "overlap"
		switch {
		case scoreState.vector != nil && scoreState.overlap != nil:
			origin = "hybrid"
		case scoreState.vector != nil:
			origin = "vector"
		}
		candidates = append(candidates, AssignmentCandidate{
			EventID:       event.ID,
			Score:         score,
			MatchOrigin:   origin,
			Title:         event.Title,
			Summary:       event.Summary,
			Language:      event.Language,
			PrimaryTopic:  event.PrimaryTopic,
			PrimaryEntity: event.PrimaryEntity,
			StartAt:       event.StartAt,
			LastAt:        event.LastAt,
			ItemCount:     event.ItemCount,
		})
	}
	// Stable descending score, then descending lastAt, exactly like the
	// NestJS Array.prototype.sort comparator.
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score > candidates[j].Score
		}
		return candidates[i].LastAt.After(candidates[j].LastAt)
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates
}

// collectVectorCandidates adds the vector-origin scores to the state.
func (s *Service) collectVectorCandidates(ctx context.Context, orgID string, signal newsSignal, settings newsEventSettings, searcher SummaryVectorSearcher, state map[string]*candidateScore) error {
	embedding := s.clustering.loadSummaryEmbedding(ctx, signal.ProcessedItemID)
	if embedding == nil {
		return nil
	}
	lookbackDays := settings.LookbackDays
	if lookbackDays < 1 {
		lookbackDays = 1
	}
	matches, err := searcher.SearchSummaryVectors(ctx, SummaryVectorSearchRequest{
		OrgID:          orgID,
		EmbeddingModel: embedding.Model,
		Vector:         embedding.Vector,
		Limit:          llmBackfillVectorSearchLimit,
		MinScore:       settings.VectorMinScore,
		Lookback:       time.Duration(lookbackDays) * 24 * time.Hour,
	})
	if err != nil {
		// searchBestEffort returns null on any failure: no vector candidates,
		// no error.
		return nil
	}
	signalProcessedItemID := ""
	if signal.ProcessedItemID != nil {
		signalProcessedItemID = strings.TrimSpace(*signal.ProcessedItemID)
	}
	matchIDs := make([]string, 0, len(matches))
	seen := make(map[string]struct{}, len(matches))
	for _, match := range matches {
		id := strings.TrimSpace(match.ProcessedItemID)
		if id == "" || id == signalProcessedItemID {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		matchIDs = append(matchIDs, id)
	}
	if len(matchIDs) == 0 {
		return nil
	}
	memberships, err := s.clustering.listMembershipsByProcessedItemIDs(ctx, orgID, matchIDs)
	if err != nil {
		return err
	}
	if len(memberships) == 0 {
		return nil
	}
	// Keep the highest raw score of every event, exactly like the NestJS
	// scoreByEventId map.
	scoreByEventID := make(map[string]float64, len(memberships))
	for _, match := range matches {
		id := strings.TrimSpace(match.ProcessedItemID)
		eventID, ok := memberships[id]
		if !ok || eventID == "" {
			continue
		}
		existing, ok := scoreByEventID[eventID]
		if !ok || match.Score > existing {
			scoreByEventID[eventID] = match.Score
		}
	}
	if len(scoreByEventID) == 0 {
		return nil
	}
	eventIDs := make([]string, 0, len(scoreByEventID))
	for eventID := range scoreByEventID {
		eventIDs = append(eventIDs, eventID)
	}
	sort.Strings(eventIDs)
	events, err := s.clustering.listNewsEventCandidateDetails(ctx, orgID, eventIDs)
	if err != nil {
		return err
	}
	for i := range events {
		event := events[i]
		adjusted := applyLanguagePenalty(scoreByEventID[event.ID], signal.Language, event.Language, settings)
		categoryAdjusted, ok := applyCategoryGate(adjusted, signal, event.MetadataJSON, settings)
		if !ok {
			continue
		}
		entry := state[event.ID]
		if entry == nil {
			entry = &candidateScore{}
			state[event.ID] = entry
		}
		score := categoryAdjusted
		entry.vector = &score
	}
	return nil
}

// collectOverlapCandidates adds the local topic/entity overlap scores.
func (s *Service) collectOverlapCandidates(ctx context.Context, orgID string, signal newsSignal, primaryTopic, primaryEntity string, settings newsEventSettings, state map[string]*candidateScore) error {
	if primaryTopic == "" && primaryEntity == "" {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	lookbackDays := settings.LookbackDays
	if lookbackDays < 1 {
		lookbackDays = 1
	}
	since := now.Add(-time.Duration(lookbackDays) * 24 * time.Hour)
	candidates, err := s.clustering.listNewsEventCandidates(ctx, orgID, since, primaryTopic, primaryEntity)
	if err != nil {
		return err
	}
	for i := range candidates {
		score, ok := scoreCandidate(candidates[i], signal, primaryTopic, primaryEntity, settings)
		if !ok {
			continue
		}
		entry := state[candidates[i].ID]
		if entry == nil {
			entry = &candidateScore{}
			state[candidates[i].ID] = entry
		}
		value := score
		entry.overlap = &value
	}
	return nil
}
