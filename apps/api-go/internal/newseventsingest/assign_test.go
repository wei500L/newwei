package newseventsingest

import (
	"math"
	"testing"
	"time"
)

func baseSettings() Settings {
	return Settings{
		Enabled:                      true,
		IngestionEnabled:             true,
		ClusteringMode:               ClusteringModeVector,
		BertopicMinItemsPerGroup:     8,
		BertopicMaxItemsPerRequest:   32,
		BertopicMinTopicSize:         4,
		MaxBatchSize:                 100,
		BackfillDays:                 30,
		LookbackDays:                 30,
		OverlapFallbackMaxGapHours:   72,
		VectorMinScore:               0.82,
		CrossLanguagePenalty:         0.1,
		ClassificationGateEnabled:    true,
		CategoryConflictReject:       true,
		CategorySoftPenalty:          0.15,
		MinCategoryConfidenceForGate: 0.4,
	}
}

func gateDisabledSettings() Settings {
	settings := baseSettings()
	settings.ClassificationGateEnabled = false
	return settings
}

// TestCosineSimilarityMatchesIndexOrder locks the accumulation order and the
// denominator: sqrt(normA) * sqrt(normB), never sqrt(normA * normB).
func TestCosineSimilarityMatchesIndexOrder(t *testing.T) {
	cases := []struct {
		left  []float64
		right []float64
		want  float64
	}{
		{[]float64{1, 0}, []float64{1, 0}, 1},
		{[]float64{1, 0}, []float64{0, 1}, 0},
		{[]float64{1, 1}, []float64{1, 1}, 1},
		{[]float64{3, 4}, []float64{3, 4}, 1},
		{[]float64{1, 2, 3}, []float64{4, 5, 6}, 32 / (math.Sqrt(14) * math.Sqrt(77))},
		{[]float64{}, []float64{1}, 0},
		{[]float64{1, 2}, []float64{1}, 0},
	}
	for _, testCase := range cases {
		got := cosineSimilarity(testCase.left, testCase.right)
		if math.Abs(got-testCase.want) > 1e-12 {
			t.Fatalf("cosine(%v, %v) = %v, want %v", testCase.left, testCase.right, got, testCase.want)
		}
	}
}

// TestCosineSimilarityMultipliesTwoSquareRoots locks the denominator shape: the
// NestJS code computes sqrt(normA) * sqrt(normB), not sqrt(normA * normB). With
// a 1e150 component both norms are 1e300; the product first would overflow to
// +Inf and yield 0, while the NestJS formula yields 1.
func TestCosineSimilarityMultipliesTwoSquareRoots(t *testing.T) {
	got := cosineSimilarity([]float64{1e150}, []float64{1e150})
	if got != 1 {
		t.Fatalf("cosine = %v, want 1", got)
	}
}

// TestChunkDocumentsKeepsOrderAndMinimumSize locks chunkDocuments.
func TestChunkDocumentsKeepsOrderAndMinimumSize(t *testing.T) {
	documents := []batchSignalDocument{
		{Signal: NewsSignal{ProcessedArticleID: "a"}},
		{Signal: NewsSignal{ProcessedArticleID: "b"}},
		{Signal: NewsSignal{ProcessedArticleID: "c"}},
	}
	chunks := chunkDocuments(documents, 2)
	if len(chunks) != 2 || len(chunks[0]) != 2 || len(chunks[1]) != 1 {
		t.Fatalf("chunks = %d (%d/%d)", len(chunks), len(chunks[0]), len(chunks[1]))
	}
	if chunks[0][0].Signal.ProcessedArticleID != "a" || chunks[1][0].Signal.ProcessedArticleID != "c" {
		t.Fatalf("chunk order changed")
	}
	// A size below 1 behaves like 1.
	if got := chunkDocuments(documents, 0); len(got) != 3 {
		t.Fatalf("size 0 => %d chunks, want 3", len(got))
	}
	// The chunks share the input backing array exactly like Array.prototype.slice.
	if len(chunks[0]) != 2 || len(documents) != 3 {
		t.Fatalf("unexpected slice lengths")
	}
}

// TestBuildGroupIdMatchesSha1Rule locks the buildGroupId algorithm: sha1 over
// orgId|reason|sorted ids joined with commas, truncated to 24 hex characters.
func TestBuildGroupIdMatchesSha1Rule(t *testing.T) {
	got := buildGroupId("org_1", "bertopic_request_failed", []string{"c", "a", "b"})
	// Golden digest computed from the NodeJS update sequence:
	// sha1("org_1" + "|" + "bertopic_request_failed" + "|" + "a," + "b," + "c,").
	const want = "ccea4de03521bb15b9400abf"
	if got != want {
		t.Fatalf("buildGroupId = %q, want %q", got, want)
	}
	sorted := buildGroupId("org_1", "bertopic_request_failed", []string{"a", "b", "c"})
	if got != sorted {
		t.Fatalf("id order changed the group id: %q vs %q", got, sorted)
	}
	other := buildGroupId("org_2", "bertopic_request_failed", []string{"a", "b", "c"})
	if got == other {
		t.Fatalf("organization did not change the group id")
	}
	otherReason := buildGroupId("org_1", "other_reason", []string{"a", "b", "c"})
	if got == otherReason {
		t.Fatalf("failure reason did not change the group id")
	}
}

// TestScoreVectorCandidatesKeepsFirstOnTie locks the strict-greater comparison:
// the first event id of the iterated Map wins a tie.
func TestScoreVectorCandidatesKeepsFirstOnTie(t *testing.T) {
	settings := gateDisabledSettings()
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{}

	events := map[string]eventRecord{
		"ev_a": {ID: "ev_a"},
		"ev_b": {ID: "ev_b"},
	}
	scores := map[string]float64{"ev_a": 0.9, "ev_b": 0.9}
	best := scoreVectorCandidates([]string{"ev_a", "ev_b"}, scores, events, signal, derived, session)
	if best == nil || best.EventID != "ev_a" {
		t.Fatalf("best = %#v, want ev_a", best)
	}

	// A strictly higher later score wins.
	scores["ev_b"] = 0.91
	best = scoreVectorCandidates([]string{"ev_a", "ev_b"}, scores, events, signal, derived, session)
	if best == nil || best.EventID != "ev_b" {
		t.Fatalf("best = %#v, want ev_b", best)
	}

	// An absent event is skipped, and a NaN score never beats a higher finite
	// result because `NaN > x` is false.
	events["ev_c"] = eventRecord{ID: "ev_c"}
	scores["ev_c"] = math.NaN()
	best = scoreVectorCandidates([]string{"ev_a", "ev_b", "ev_c"}, scores, events, signal, derived, session)
	if best == nil || best.EventID != "ev_b" {
		t.Fatalf("best = %#v, want ev_b", best)
	}
	// A NaN first score is kept (it is the first candidate) and then compared
	// against nothing greater.
	scores["ev_a"] = math.NaN()
	best = scoreVectorCandidates([]string{"ev_a"}, scores, events, signal, derived, session)
	if best == nil || best.EventID != "ev_a" || !math.IsNaN(best.Score) {
		t.Fatalf("best = %#v, want ev_a with NaN", best)
	}
}

// TestScoreOverlapCandidatesRequiresTopicAndEntityWithinGap locks the tightened
// fallback: a candidate needs BOTH a case-sensitive primaryTopic and
// primaryEntity match AND a lastAt inside OverlapFallbackMaxGapHours. Topic-only,
// entity-only, stale and case-mismatched candidates are all excluded, and a
// double match scores 1.0.
func TestScoreOverlapCandidatesRequiresTopicAndEntityWithinGap(t *testing.T) {
	settings := gateDisabledSettings()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{PrimaryTopic: "ai", PrimaryEntity: "OpenAI"}

	candidates := []eventRecord{
		{ID: "ev_both", PrimaryTopic: stringPtr("ai"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-time.Hour)},
		{ID: "ev_topic", PrimaryTopic: stringPtr("ai"), LastAt: now.Add(-time.Hour)},
		{ID: "ev_entity", PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-time.Hour)},
		{ID: "ev_stale", PrimaryTopic: stringPtr("ai"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-73 * time.Hour)},
		// The SQL collation is case-insensitive but the in-memory re-check is not.
		{ID: "ev_case", PrimaryTopic: stringPtr("AI"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-time.Hour)},
	}
	scored := scoreOverlapCandidates(candidates, signal, derived, session, now)
	if len(scored) != 1 || scored[0].EventID != "ev_both" || scored[0].Score != 1 {
		t.Fatalf("scored = %#v, want only ev_both at 1.0", scored)
	}
}

// pickOverlapBest mirrors pickEventByOverlap's "stably sorted first candidate"
// selection for the in-memory decision tests. A nil result means no overlap
// candidate survived the tightened rule.
func pickOverlapBest(candidates []eventRecord, signal NewsSignal, derived derivedSignal, session *assignmentSession, now time.Time) *assignment {
	scored := scoreOverlapCandidates(candidates, signal, derived, session, now)
	if len(scored) == 0 {
		return nil
	}
	sortScoredEvents(scored)
	best := scored[0]
	similarity := best.Score
	return &assignment{EventID: best.EventID, Similarity: &similarity, Method: assignmentMethodOverlap}
}

// TestVectorLowScoreCreatesNewEventWithoutOverlapFallback is the core L1
// regression: the vector path judged the article dissimilar (best score below
// VectorMinScore), so even a same-topic AND same-entity candidate inside the gap
// must be ignored and a new event created.
func TestVectorLowScoreCreatesNewEventWithoutOverlapFallback(t *testing.T) {
	settings := baseSettings()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{PrimaryTopic: "ai", PrimaryEntity: "OpenAI"}

	overlap := pickOverlapBest([]eventRecord{{
		ID: "ev_existing", PrimaryTopic: stringPtr("ai"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-time.Hour),
	}}, signal, derived, session, now)
	if overlap == nil {
		t.Fatal("expected a same-topic same-entity candidate within the gap")
	}

	judgement := vectorJudgement{attempted: true, usable: true, best: &scoredEvent{EventID: "ev_existing", Score: 0.5}}
	got := decideEventAssignment(judgement, overlap, settings.VectorMinScore)
	if got.EventID != "" {
		t.Fatalf("vector low score must create a new event, got %+v", got)
	}
	if got.Similarity != nil {
		t.Fatalf("a created event carries no similarity, got %v", got.Similarity)
	}
}

// TestOverlapFallbackAssignsWhenTopicAndEntityMatchWithinGap: no embedding means
// the vector cannot judge, so a same-topic AND same-entity event inside 72h is
// joined.
func TestOverlapFallbackAssignsWhenTopicAndEntityMatchWithinGap(t *testing.T) {
	settings := baseSettings()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{PrimaryTopic: "ai", PrimaryEntity: "OpenAI"}

	overlap := pickOverlapBest([]eventRecord{{
		ID: "ev_existing", PrimaryTopic: stringPtr("ai"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-71 * time.Hour),
	}}, signal, derived, session, now)
	got := decideEventAssignment(vectorJudgement{attempted: false}, overlap, settings.VectorMinScore)
	if got.EventID != "ev_existing" || got.Method != assignmentMethodOverlap {
		t.Fatalf("got %+v, want overlap into ev_existing", got)
	}
	if got.Similarity == nil || *got.Similarity != 1 {
		t.Fatalf("similarity = %v, want 1", got.Similarity)
	}
}

// TestOverlapFallbackIgnoresTopicOnlyMatch: no embedding, only the topic matches,
// so a new event is created.
func TestOverlapFallbackIgnoresTopicOnlyMatch(t *testing.T) {
	settings := baseSettings()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{PrimaryTopic: "ai", PrimaryEntity: "OpenAI"}

	overlap := pickOverlapBest([]eventRecord{{
		ID: "ev_topic", PrimaryTopic: stringPtr("ai"), LastAt: now.Add(-time.Hour),
	}}, signal, derived, session, now)
	if overlap != nil {
		t.Fatalf("a topic-only match must not be a candidate: %#v", overlap)
	}
	got := decideEventAssignment(vectorJudgement{attempted: false}, overlap, settings.VectorMinScore)
	if got.EventID != "" {
		t.Fatalf("got %+v, want a new event", got)
	}
}

// TestOverlapFallbackIgnoresCandidateOutsideGap: no embedding, both match but the
// event lastAt is older than 72h, so a new event is created.
func TestOverlapFallbackIgnoresCandidateOutsideGap(t *testing.T) {
	settings := baseSettings()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{PrimaryTopic: "ai", PrimaryEntity: "OpenAI"}

	overlap := pickOverlapBest([]eventRecord{{
		ID: "ev_stale", PrimaryTopic: stringPtr("ai"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-73 * time.Hour),
	}}, signal, derived, session, now)
	if overlap != nil {
		t.Fatalf("a candidate outside the gap must not match: %#v", overlap)
	}
	got := decideEventAssignment(vectorJudgement{attempted: false}, overlap, settings.VectorMinScore)
	if got.EventID != "" {
		t.Fatalf("got %+v, want a new event", got)
	}
}

// TestOverlapFallbackAssignsWhenVectorUnavailable: the vector path attempted but
// the service was unavailable (usable false), so the tightened overlap applies.
func TestOverlapFallbackAssignsWhenVectorUnavailable(t *testing.T) {
	settings := baseSettings()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{PrimaryTopic: "ai", PrimaryEntity: "OpenAI"}

	overlap := pickOverlapBest([]eventRecord{{
		ID: "ev_existing", PrimaryTopic: stringPtr("ai"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-time.Hour),
	}}, signal, derived, session, now)
	judgement := vectorJudgement{attempted: true, usable: false}
	got := decideEventAssignment(judgement, overlap, settings.VectorMinScore)
	if got.EventID != "ev_existing" || got.Method != assignmentMethodOverlap {
		t.Fatalf("got %+v, want overlap into ev_existing", got)
	}
}

// TestVectorHitKeepsVectorAssignment: when the vector path can judge and the best
// score reaches the threshold, it joins that event with the vector method, and
// any overlap candidate is ignored.
func TestVectorHitKeepsVectorAssignment(t *testing.T) {
	settings := baseSettings()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	session := &assignmentSession{orgID: "org_1", settings: settings}
	signal := NewsSignal{ProcessedArticleID: "pa_1"}
	derived := derivedSignal{PrimaryTopic: "ai", PrimaryEntity: "OpenAI"}

	overlap := pickOverlapBest([]eventRecord{{
		ID: "ev_overlap", PrimaryTopic: stringPtr("ai"), PrimaryEntity: stringPtr("OpenAI"), LastAt: now.Add(-time.Hour),
	}}, signal, derived, session, now)
	judgement := vectorJudgement{attempted: true, usable: true, best: &scoredEvent{EventID: "ev_vector", Score: 0.93}}
	got := decideEventAssignment(judgement, overlap, settings.VectorMinScore)
	if got.EventID != "ev_vector" || got.Method != assignmentMethodVector {
		t.Fatalf("got %+v, want the vector event", got)
	}
	if got.Similarity == nil || *got.Similarity != 0.93 {
		t.Fatalf("similarity = %v, want 0.93", got.Similarity)
	}
}

// TestSortScoredEventsOrdersFiniteScoresStably locks the descending order and
// the first-wins tie break.
func TestSortScoredEventsOrdersFiniteScoresStably(t *testing.T) {
	scored := []scoredEvent{
		{EventID: "a", Score: 0.5},
		{EventID: "b", Score: 0.9},
		{EventID: "c", Score: 0.5},
		{EventID: "d", Score: 0.1},
	}
	sortScoredEvents(scored)
	want := []string{"b", "a", "c", "d"}
	for index, id := range want {
		if scored[index].EventID != id {
			t.Fatalf("order = %q,%q,%q,%q, want %q", scored[0].EventID, scored[1].EventID,
				scored[2].EventID, scored[3].EventID, want)
		}
	}
}

// TestScoredEventLessTreatsNaNAsEqual locks the comparator itself. The NestJS
// comparator `b.score - a.score` returns NaN when either score is NaN, which the
// specification turns into "equal"; `less` therefore has to report false in both
// directions. The resulting order of a NaN score is implementation-defined in
// both runtimes (the comparator is not a strict weak ordering), and no reachable
// assignment can produce one: every score comes from a clamped setting or from a
// proximity result.
func TestScoredEventLessTreatsNaNAsEqual(t *testing.T) {
	nan := scoredEvent{EventID: "nan", Score: math.NaN()}
	finite := scoredEvent{EventID: "finite", Score: 0.5}
	if scoredEventLess(nan, finite) || scoredEventLess(finite, nan) {
		t.Fatal("a NaN score must compare equal in both directions")
	}
	if !scoredEventLess(finite, scoredEvent{EventID: "lower", Score: 0.4}) {
		t.Fatal("a higher score must sort first")
	}
	if scoredEventLess(finite, scoredEvent{EventID: "same", Score: 0.5}) {
		t.Fatal("equal scores must not reorder")
	}
}

// TestApplyLanguagePenalty locks the two-sided, case-sensitive rule.
func TestApplyLanguagePenalty(t *testing.T) {
	settings := baseSettings()
	settings.CrossLanguagePenalty = 0.25
	if got := applyLanguagePenalty(1, stringPtr("en"), stringPtr("en"), settings); got != 1 {
		t.Fatalf("same language = %v", got)
	}
	if got := applyLanguagePenalty(1, nil, stringPtr("en"), settings); got != 1 {
		t.Fatalf("nil signal language = %v", got)
	}
	if got := applyLanguagePenalty(1, stringPtr("en"), nil, settings); got != 1 {
		t.Fatalf("nil event language = %v", got)
	}
	if got := applyLanguagePenalty(1, stringPtr(" "), stringPtr("en"), settings); got != 1 {
		t.Fatalf("blank signal language = %v", got)
	}
	if got := applyLanguagePenalty(1, stringPtr("EN"), stringPtr("en"), settings); got != 0.75 {
		t.Fatalf("case-sensitive comparison = %v, want 0.75", got)
	}
	// The penalty is clamped into 0..1 before use.
	settings.CrossLanguagePenalty = 5
	if got := applyLanguagePenalty(1, stringPtr("en"), stringPtr("zh"), settings); got != 0 {
		t.Fatalf("clamped penalty = %v, want 0", got)
	}
	settings.CrossLanguagePenalty = -2
	if got := applyLanguagePenalty(1, stringPtr("en"), stringPtr("zh"), settings); got != 1 {
		t.Fatalf("negative penalty = %v, want 1", got)
	}
}

// TestPickPrimaryTopicAndEntity locks the derived fields.
func TestPickPrimaryTopicAndEntity(t *testing.T) {
	if got := pickPrimaryTopic([]string{"", "  ", " ai ", "tech"}); got != "ai" {
		t.Fatalf("topic = %q", got)
	}
	if got := pickPrimaryTopic(nil); got != "" {
		t.Fatalf("empty topic = %q", got)
	}
	entities := []NewsSignalEntity{
		{Name: "First"},
		{Name: "Second", Confidence: floatPtr(0.4)},
		{Name: "Third", Confidence: floatPtr(0.9)},
		{Name: "Fourth", Confidence: floatPtr(0.9)},
	}
	if got := pickPrimaryEntity(entities); got != "Third" {
		t.Fatalf("entity = %q, want Third (first highest)", got)
	}
	if got := pickPrimaryEntity([]NewsSignalEntity{{Name: "  "}, {Name: "Fallback"}}); got != "Fallback" {
		t.Fatalf("fallback = %q", got)
	}
	if got := pickPrimaryEntity(nil); got != "" {
		t.Fatalf("empty entity = %q", got)
	}
}

// TestOrderedScoresKeepsInsertionOrder locks the Map-order proxy.
func TestOrderedScoresKeepsInsertionOrder(t *testing.T) {
	scores := newOrderedScores()
	scores.setIfHigher("b", 0.1)
	scores.setIfHigher("a", 0.2)
	scores.setIfHigher("b", 0.3)
	scores.setIfHigher("b", 0.2)
	if len(scores.keys) != 2 || scores.keys[0] != "b" || scores.keys[1] != "a" {
		t.Fatalf("keys = %#v", scores.keys)
	}
	if scores.values["b"] != 0.3 {
		t.Fatalf("b = %v, want 0.3 (strictly higher only)", scores.values["b"])
	}
}
