package analysis

import "testing"

func TestClassifyTagResultAndHeuristic(t *testing.T) {
	tagged := ClassifySituationMonitorCategory(ClassificationInput{Tags: []string{"sm:ai"}, Title: "anything"})
	if tagged.Category != CategoryAI || tagged.Source != ClassificationSourceTag {
		t.Fatalf("tag classification = %+v", tagged)
	}
	byResult := ClassifySituationMonitorCategory(ClassificationInput{ResultCategory: "technology", Title: "x"})
	if byResult.Category != CategoryTech || byResult.Source != ClassificationSourceResultCategory {
		t.Fatalf("result classification = %+v", byResult)
	}
	heuristic := ClassifySituationMonitorCategory(ClassificationInput{Title: "OpenAI releases GPT-5"})
	if heuristic.Category != CategoryAI || heuristic.Source != ClassificationSourceHeuristic {
		t.Fatalf("heuristic classification = %+v", heuristic)
	}
	unknown := ClassifySituationMonitorCategory(ClassificationInput{Title: "a quiet afternoon"})
	if unknown.Category != "" {
		t.Fatalf("unknown classification = %+v", unknown)
	}
}

func TestBuildEventClustersMergesByCanonicalURLAndOrdersAlertsFirst(t *testing.T) {
	headlines := HeadlinesByCategory{
		Politics: []Headline{
			{ID: "1", Title: "Calm talks continue", Link: "https://example.com/a?utm_source=x", Source: "Reuters", Timestamp: 1000, Category: CategoryPolitics, Origin: "items"},
			{ID: "2", Title: "Calm talks continue", Link: "https://example.com/a", Source: "AP", Timestamp: 2000, Category: CategoryPolitics, Origin: "gdelt"},
			{ID: "3", Title: "Missile attack reported", Link: "https://example.com/b", Source: "CNN", Timestamp: 500, Category: CategoryPolitics, Origin: "items", IsAlert: true},
		},
	}
	clusters := BuildSituationMonitorEventClusters(headlines, ClusterBuildOptions{MaxClustersPerCategory: 6, MaxItemsPerCluster: 6})
	if len(clusters.Politics) != 2 {
		t.Fatalf("clusters = %d", len(clusters.Politics))
	}
	if !clusters.Politics[0].IsAlert {
		t.Fatalf("alert cluster should sort first: %+v", clusters.Politics[0])
	}
	if clusters.Politics[1].InternalCount != 1 || clusters.Politics[1].ExternalCount != 1 {
		t.Fatalf("merged counts = %+v", clusters.Politics[1])
	}
	if clusters.Politics[1].DistinctSourceCount != 2 || !clusters.Politics[1].MixedSource {
		t.Fatalf("merged sources = %+v", clusters.Politics[1])
	}
}

func TestAnalyzeCorrelationsMomentumAndBlockedLearning(t *testing.T) {
	news := []NewsItem{
		{Title: "Tariff announcement hits markets", Source: "Reuters", Timestamp: 1},
		{Title: "New tariff plan", Source: "AP", Timestamp: 2},
		{Title: "Tariff vote scheduled", Source: "BBC", Timestamp: 3},
	}
	outcome := AnalyzeCorrelations(news, CorrelationOptions{})
	if outcome.Results == nil {
		t.Fatal("expected results")
	}
	if outcome.TopicCounts["tariffs"] != 3 {
		t.Fatalf("counts = %+v", outcome.TopicCounts)
	}
	if len(outcome.Results.EmergingPatterns) != 1 || outcome.Results.EmergingPatterns[0].Level != "emerging" {
		t.Fatalf("emerging = %+v", outcome.Results.EmergingPatterns)
	}
	if len(outcome.Results.MomentumSignals) != 1 || outcome.Results.MomentumSignals[0].Delta != 3 {
		t.Fatalf("momentum = %+v", outcome.Results.MomentumSignals)
	}
	blocked := AnalyzeCorrelations(news, CorrelationOptions{Learning: map[string]CorrelationLearningOverride{
		"tariffs": {BlockedTokens: []string{"tariff"}},
	}})
	if blocked.TopicCounts["tariffs"] != 0 {
		t.Fatalf("blocked counts = %+v", blocked.TopicCounts)
	}
}

func TestAnalyzeNarrativesCrossingFringeAndMainstream(t *testing.T) {
	news := []NewsItem{
		{Title: "Deep state resistance grows", Source: "zerohedge", Timestamp: 2},
		{Title: "Deep state claims spread online", Source: "reuters", Timestamp: 3},
	}
	results := AnalyzeNarratives(news, NarrativeOptions{})
	if results == nil {
		t.Fatal("expected narrative results")
	}
	if len(results.FringeToMainstream) != 1 {
		t.Fatalf("crossing = %+v", results.FringeToMainstream)
	}
	if results.FringeToMainstream[0].Count != 2 || results.FringeToMainstream[0].MainstreamCount != 1 {
		t.Fatalf("counts = %+v", results.FringeToMainstream[0])
	}
}

func TestCalculateMainCharacterCountsEveryMatch(t *testing.T) {
	results := CalculateMainCharacter([]NewsItem{
		{Title: "Trump meets Trump"},
		{Title: "Musk and Trump talk"},
	})
	if len(results.Characters) != 2 {
		t.Fatalf("characters = %+v", results.Characters)
	}
	if results.Characters[0].Name != "Trump" || results.Characters[0].Count != 3 {
		t.Fatalf("trump = %+v", results.Characters[0])
	}
	if results.TopCharacter == nil || results.TopCharacter.Name != "Trump" {
		t.Fatalf("top = %+v", results.TopCharacter)
	}
}

func TestBuildWorldLeadersAndSituations(t *testing.T) {
	leaders := BuildWorldLeaders([]NewsItem{{Title: "Trump meets Putin", Source: "Reuters", Timestamp: 1}})
	if leaders[0].MatchCount != 1 {
		t.Fatalf("top leader = %+v", leaders[0])
	}
	now := int64(10 * 24 * 60 * 60 * 1000)
	news := []NewsItem{
		{Title: "Iran protests continue", Timestamp: now - 1000},
		{Title: "Tehran crackdown", Timestamp: now - 2000},
		{Title: "IRGC statement", Timestamp: now - 3000},
	}
	panels := BuildSituations(news, now)
	if panels[2].ID != "iran" || panels[2].Status != "CRITICAL" {
		t.Fatalf("iran panel = %+v", panels[2])
	}
}

func TestCanonicalizeURLAndNormalizeTitle(t *testing.T) {
	got := canonicalizeURL("https://Example.com/Story/?utm_source=x&b=2&a=1#frag")
	if got != "example.com/Story?a=1&b=2" {
		t.Fatalf("canonical = %q", got)
	}
	if normalized := normalizeTitle("Breaking: Markets Rally - Reuters"); normalized != "breaking markets rally" {
		t.Fatalf("title = %q", normalized)
	}
}
