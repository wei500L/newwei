package situationsignals

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
)

func candidate(itemKey, title string, extra func(*monitorCandidate)) monitorCandidate {
	candidate := monitorCandidate{
		ItemKey:    itemKey,
		ItemType:   "telegram",
		Title:      title,
		Summary:    title + " summary",
		Link:       "https://example.test/" + itemKey,
		Source:     "Alpha",
		Timestamp:  1000,
		Topics:     []string{},
		Entities:   []string{},
		GeoTexts:   []string{},
		ExtraTexts: []string{},
	}
	if extra != nil {
		extra(&candidate)
	}
	return candidate
}

func monitor(id, name string, extra func(*monitorRecord)) monitorRecord {
	record := monitorRecord{
		ID:                   id,
		Kind:                 "manual",
		Name:                 name,
		RawKeywords:          []string{},
		ApprovedTopics:       []string{},
		ApprovedEntities:     []string{},
		ApprovedSources:      []string{},
		ApprovedGeos:         []string{},
		ApprovedLexicalTerms: []string{},
	}
	if extra != nil {
		extra(&record)
	}
	return record
}

func TestEmbedCandidateBatchSkipsGatewayWithoutVectors(t *testing.T) {
	fake := &fakeEmbeddings{}
	service := &Service{embed: fake}
	monitors := []monitorRecord{monitor("m1", "One", nil)}
	candidates := []monitorCandidate{candidate("c1", "hello", nil)}

	got := service.embedCandidateBatch(context.Background(), "org-1", monitors, candidates)
	if len(got) != 0 {
		t.Fatalf("embeddings = %v", got)
	}
	if fake.embedCalls != 0 {
		t.Fatalf("the model gateway must not be called: %d calls", fake.embedCalls)
	}
}

func TestEmbedCandidateBatchFallsBackOnFailure(t *testing.T) {
	fake := &fakeEmbeddings{embedErr: errors.New("gateway down")}
	service := &Service{embed: fake}
	monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
		record.QueryEmbeddingVector = []float64{1, 0}
	})}
	candidates := []monitorCandidate{candidate("c1", "hello", nil)}

	got := service.embedCandidateBatch(context.Background(), "org-1", monitors, candidates)
	if len(got) != 0 {
		t.Fatalf("a failing gateway must yield the empty fallback, got %v", got)
	}
	if fake.embedCalls != 1 {
		t.Fatalf("embed calls = %d", fake.embedCalls)
	}
}

func TestEmbedCandidateBatchNormalizesVectors(t *testing.T) {
	fake := &fakeEmbeddings{vectors: [][]float64{{3, 4}}}
	service := &Service{embed: fake}
	monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
		record.QueryEmbeddingVector = []float64{1, 0}
	})}
	candidates := []monitorCandidate{candidate("c1", "hello", nil)}

	got := service.embedCandidateBatch(context.Background(), "org-1", monitors, candidates)
	vector, ok := got["c1"]
	if !ok || len(vector) != 2 {
		t.Fatalf("embeddings = %v", got)
	}
	if vector[0] != 0.6 || vector[1] != 0.8 {
		t.Fatalf("vector = %v", vector)
	}
}

func TestMatchIncludeRules(t *testing.T) {
	t.Run("explicit keyword reason includes", func(t *testing.T) {
		fake := &fakeEmbeddings{}
		service := &Service{embed: fake}
		monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
			record.RawKeywords = []string{"alpha"}
		})}
		results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors,
			[]monitorCandidate{candidate("c1", "alpha report", nil)}, map[string][]float64{})
		if len(results) != 1 {
			t.Fatalf("results = %v", results)
		}
		if fake.rerankCalls != 0 {
			t.Fatalf("rerank must not run for an empty shortlist: %d", fake.rerankCalls)
		}
		if results[0].Reasons[0].Code != "keyword" || results[0].Reasons[0].Label != "Keyword matched" {
			t.Fatalf("reasons = %+v", results[0].Reasons)
		}
		// 0.42 base score, no semantic and no rerank contribution.
		if results[0].Score != 0.42 {
			t.Fatalf("score = %v", results[0].Score)
		}
		if results[0].MonitorID != "m1" || results[0].MonitorKind != "manual" || results[0].MonitorName != "One" {
			t.Fatalf("result = %+v", results[0])
		}
	})

	t.Run("rerank above the include threshold includes", func(t *testing.T) {
		fake := &fakeEmbeddings{rerankHits: []llmembed.Hit{{Index: 0, Score: 0.9}}}
		service := &Service{embed: fake}
		monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
			record.QueryEmbeddingVector = []float64{1, 0}
		})}
		embeddings := map[string][]float64{"c1": {1, 0}}
		results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors,
			[]monitorCandidate{candidate("c1", "unrelated", nil)}, embeddings)
		if fake.rerankCalls != 1 {
			t.Fatalf("rerank calls = %d", fake.rerankCalls)
		}
		if len(results) != 1 {
			t.Fatalf("results = %v", results)
		}
		reason := results[0].Reasons[len(results[0].Reasons)-1]
		if reason.Code != "rerank" {
			t.Fatalf("reasons = %+v", results[0].Reasons)
		}
		// semantic 1.0 * 0.15 + rerank 1.0 * 0.2 = 0.35
		if results[0].Score != 0.35 {
			t.Fatalf("score = %v", results[0].Score)
		}
	})

	t.Run("semantic above the include threshold includes", func(t *testing.T) {
		// The semantic-only branch needs an empty rerank map, which is what a
		// failing rerank call produces.
		fake := &fakeEmbeddings{rerankErr: errors.New("no rerank")}
		service := &Service{embed: fake}
		monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
			record.QueryEmbeddingVector = []float64{1, 0}
		})}
		embeddings := map[string][]float64{"c1": {0.9, 0.1}}
		results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors,
			[]monitorCandidate{candidate("c1", "unrelated", nil)}, embeddings)
		if len(results) != 1 {
			t.Fatalf("results = %v", results)
		}
		reason := results[0].Reasons[len(results[0].Reasons)-1]
		if reason.Code != "semantic" || reason.Label != "Semantic recall" {
			t.Fatalf("reasons = %+v", results[0].Reasons)
		}
		// semantic 0.9 * 0.15 = 0.135
		if results[0].Score != 0.135 {
			t.Fatalf("score = %v", results[0].Score)
		}
	})

	t.Run("below both thresholds is excluded", func(t *testing.T) {
		fake := &fakeEmbeddings{rerankErr: errors.New("no rerank")}
		service := &Service{embed: fake}
		monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
			record.QueryEmbeddingVector = []float64{1, 0}
		})}
		// 0.7 clears the shortlist threshold (0.68) but not the include threshold
		// (0.82), and the rerank call fails so its result cannot include it
		// either.
		embeddings := map[string][]float64{"c1": {0.7, 0.714}}
		results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors,
			[]monitorCandidate{candidate("c1", "unrelated", nil)}, embeddings)
		if len(results) != 0 {
			t.Fatalf("results = %v", results)
		}
	})

	t.Run("shortlist below the threshold is not reranked", func(t *testing.T) {
		fake := &fakeEmbeddings{rerankHits: []llmembed.Hit{{Index: 0, Score: 0.9}}}
		service := &Service{embed: fake}
		monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
			record.QueryEmbeddingVector = []float64{1, 0}
		})}
		embeddings := map[string][]float64{"c1": {0.1, 0.995}}
		results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors,
			[]monitorCandidate{candidate("c1", "unrelated", nil)}, embeddings)
		if fake.rerankCalls != 0 {
			t.Fatalf("rerank calls = %d", fake.rerankCalls)
		}
		if len(results) != 0 {
			t.Fatalf("results = %v", results)
		}
	})

	t.Run("vector length mismatch is skipped", func(t *testing.T) {
		fake := &fakeEmbeddings{rerankErr: errors.New("no rerank")}
		service := &Service{embed: fake}
		monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
			record.QueryEmbeddingVector = []float64{1, 0, 0}
		})}
		embeddings := map[string][]float64{"c1": {1, 0}}
		results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors,
			[]monitorCandidate{candidate("c1", "unrelated", nil)}, embeddings)
		if len(results) != 0 {
			t.Fatalf("results = %v", results)
		}
	})
}

func TestMatchGeoTasksAreHardExclusions(t *testing.T) {
	fake := &fakeEmbeddings{}
	service := &Service{embed: fake}
	monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
		record.RawKeywords = []string{"alpha"}
		record.Location = &monitorLocation{Name: "Paris", CountryCodeAlpha2: "FR"}
	})}
	candidates := []monitorCandidate{
		candidate("conflict", "alpha report", func(item *monitorCandidate) {
			item.GeoTexts = []string{"Germany"}
		}),
		candidate("same-country", "alpha report", func(item *monitorCandidate) {
			item.GeoTexts = []string{"France"}
		}),
		candidate("same-city", "alpha report", func(item *monitorCandidate) {
			item.GeoTexts = []string{"Paris"}
		}),
	}
	results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors, candidates, map[string][]float64{})
	if len(results) != 2 {
		t.Fatalf("results = %+v", results)
	}
	byKey := map[string]matchResult{}
	for _, result := range results {
		byKey[result.ItemKey] = result
	}
	if _, ok := byKey["conflict"]; ok {
		t.Fatal("a conflicting country must be excluded")
	}
	if byKey["same-country"].GeoStatus != geoStatusCountryMatch {
		t.Fatalf("geoStatus = %s", byKey["same-country"].GeoStatus)
	}
	if byKey["same-city"].GeoStatus != geoStatusMatched {
		t.Fatalf("geoStatus = %s", byKey["same-city"].GeoStatus)
	}
	// Location matched adds 0.08 to the keyword base score of 0.42.
	if byKey["same-city"].Score != 0.5 {
		t.Fatalf("score = %v", byKey["same-city"].Score)
	}
	// Country matched adds 0.04.
	if byKey["same-country"].Score != 0.46 {
		t.Fatalf("score = %v", byKey["same-country"].Score)
	}
}

func TestMatchConditionalKeysAndOrdering(t *testing.T) {
	fake := &fakeEmbeddings{}
	service := &Service{embed: fake}
	// Two monitors so the coloured and uncoloured conditional key can be
	// observed on different results.
	monitors := []monitorRecord{
		monitor("m-colour", "Colour", func(record *monitorRecord) {
			record.RawKeywords = []string{"alpha"}
			record.Color = "#123456"
		}),
		monitor("m-plain", "Plain", func(record *monitorRecord) {
			record.ApprovedTopics = []string{"war"}
		}),
	}

	// Everything a match result can carry, produced by the coloured monitor.
	populated := candidate("c1", "alpha", func(item *monitorCandidate) {
		item.Timestamp = 5000
		item.ItemMetaID = "meta-1"
		item.ItemType = "oref_alert"
		item.Category = "rockets"
		item.SummaryZh = "summary-zh"
		item.TitleZh = "title-zh"
	})
	// A falsy title/link/summary/category produced by the plain monitor through
	// a topic match, so it is still included.
	empty := candidate("c2", "", func(item *monitorCandidate) {
		item.Timestamp = 1000
		item.Summary = ""
		item.Link = ""
		item.Category = ""
		// The source is part of the lexical haystack, so it must not contain the
		// coloured monitor's keyword or this candidate would match it too.
		item.Source = "Bravo"
		item.Topics = []string{"war"}
	})
	results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors,
		[]monitorCandidate{populated, empty}, map[string][]float64{})
	if len(results) != 2 {
		t.Fatalf("results = %+v", results)
	}

	encoded, err := json.Marshal(results)
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	populatedKeys := decoded[0]
	for _, key := range []string{"itemKey", "itemType", "itemMetaId", "monitorId", "monitorKind", "monitorName", "monitorColor", "score", "geoStatus", "matchedTerms", "reasons", "link", "title", "titleZh", "summary", "summaryZh", "category", "source", "timestamp"} {
		if _, ok := populatedKeys[key]; !ok {
			t.Fatalf("populated result is missing %s: %v", key, populatedKeys)
		}
	}
	emptyKeys := decoded[1]
	for _, key := range []string{"link", "title"} {
		if _, ok := emptyKeys[key]; !ok {
			t.Fatalf("%s must always be present: %v", key, emptyKeys)
		}
	}
	for _, key := range []string{"itemMetaId", "monitorColor", "titleZh", "summaryZh", "summary", "category"} {
		if _, ok := emptyKeys[key]; ok {
			t.Fatalf("%s must be omitted when falsy: %v", key, emptyKeys)
		}
	}
	if string(emptyKeys["link"]) != `""` || string(emptyKeys["title"]) != `""` {
		t.Fatalf("link/title = %s %s", emptyKeys["link"], emptyKeys["title"])
	}
	// Timestamp descending puts the later candidate first.
	if results[0].ItemKey != "c1" || results[1].ItemKey != "c2" {
		t.Fatalf("order = %v", results)
	}
	if results[0].MonitorID != "m-colour" || results[1].MonitorID != "m-plain" {
		t.Fatalf("monitors = %s %s", results[0].MonitorID, results[1].MonitorID)
	}
}

func TestMatchOrderingIsTimestampThenScoreThenMonitorName(t *testing.T) {
	fake := &fakeEmbeddings{}
	service := &Service{embed: fake}
	monitors := []monitorRecord{
		monitor("m-b", "Bravo", func(record *monitorRecord) { record.RawKeywords = []string{"alpha"} }),
		monitor("m-a", "Alpha", func(record *monitorRecord) { record.RawKeywords = []string{"alpha"} }),
		monitor("m-c", "Charlie", func(record *monitorRecord) {
			record.RawKeywords = []string{"alpha"}
			record.ApprovedTopics = []string{"war"}
		}),
	}
	candidates := []monitorCandidate{
		candidate("late", "alpha", func(item *monitorCandidate) { item.Timestamp = 900 }),
		candidate("early", "alpha", func(item *monitorCandidate) {
			item.Timestamp = 100
			item.Topics = []string{"war"}
		}),
	}
	results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors, candidates, map[string][]float64{})
	if len(results) != 6 {
		t.Fatalf("results = %d", len(results))
	}
	// Timestamp descending first: every "late" candidate precedes every "early"
	// one, and inside a timestamp group the higher score (topic + keyword beats
	// keyword) comes first, then the monitor name ascending.
	if results[0].ItemKey != "late" {
		t.Fatalf("first = %+v", results[0])
	}
	if results[0].MonitorName != "Alpha" || results[1].MonitorName != "Bravo" || results[2].MonitorName != "Charlie" {
		t.Fatalf("late group order = %s %s %s", results[0].MonitorName, results[1].MonitorName, results[2].MonitorName)
	}
	if results[3].ItemKey != "early" || results[3].MonitorName != "Charlie" {
		t.Fatalf("early group order = %+v", results[3])
	}
	if results[3].Score != 0.6 {
		t.Fatalf("topic+keyword score = %v", results[3].Score)
	}
	if results[4].MonitorName != "Alpha" || results[5].MonitorName != "Bravo" {
		t.Fatalf("early group order = %s %s", results[4].MonitorName, results[5].MonitorName)
	}
}

func TestMatchMatchedTermsDedupeAndCap(t *testing.T) {
	fake := &fakeEmbeddings{}
	service := &Service{embed: fake}
	monitors := []monitorRecord{monitor("m1", "One", func(record *monitorRecord) {
		record.RawKeywords = []string{"alpha", "beta", "gamma", "delta", "epsilon", "zeta"}
		record.ApprovedTopics = []string{"war", "econ"}
	})}
	candidates := []monitorCandidate{candidate("c1", "alpha beta gamma delta epsilon zeta", func(item *monitorCandidate) {
		item.Topics = []string{"war", "econ"}
	})}
	results := service.matchCandidatesWithPreparedData(context.Background(), "org-1", monitors, candidates, map[string][]float64{})
	if len(results) != 1 {
		t.Fatalf("results = %v", results)
	}
	if len(results[0].MatchedTerms) != matchedTermLimit {
		t.Fatalf("matchedTerms = %v", results[0].MatchedTerms)
	}
	seen := map[string]bool{}
	for _, term := range results[0].MatchedTerms {
		if seen[term] {
			t.Fatalf("duplicate term %s in %v", term, results[0].MatchedTerms)
		}
		seen[term] = true
	}
}

func TestCollectLexicalHitsShortTokenNeedsWordBoundary(t *testing.T) {
	// "war" is three ASCII characters, so it needs a word boundary: "warning"
	// must not match.
	if hits := collectLexicalHits([]string{"war"}, "warning signs"); len(hits) != 0 {
		t.Fatalf("hits = %v", hits)
	}
	if hits := collectLexicalHits([]string{"war"}, "a war started"); len(hits) != 1 {
		t.Fatalf("hits = %v", hits)
	}
	// "warning" is longer than three characters, so it is a substring match.
	if hits := collectLexicalHits([]string{"warning"}, "prewarning signs"); len(hits) != 1 {
		t.Fatalf("hits = %v", hits)
	}
}

func TestCrawlAndPipelineStatusLists(t *testing.T) {
	if len(allCrawlTaskStatuses) != 6 || len(allPipelineJobStatuses) != 6 {
		t.Fatalf("status lists = %d/%d", len(allCrawlTaskStatuses), len(allPipelineJobStatuses))
	}
	if allCrawlTaskStatuses[5] != crawlTaskPaused || allPipelineJobStatuses[5] != pipelineJobDelayed {
		t.Fatalf("status order = %v %v", allCrawlTaskStatuses, allPipelineJobStatuses)
	}
}
