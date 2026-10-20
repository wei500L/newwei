package newseventsingest

import (
	"strings"
	"testing"
	"time"
)

// TestPartitionBatchDocumentsKeepsGroupOrder locks the bertopic grouping: the
// immediate fallback keeps the batch order, the group key is
// `language::embeddingModel` (with "unknown" for a missing language), and the
// groups keep the first-seen order.
func TestPartitionBatchDocumentsKeepsGroupOrder(t *testing.T) {
	english := stringPtr("en")
	german := stringPtr("de")
	model := stringPtr("text-embedding-3-small")

	document := func(id string, language *string, embeddingModel *string, embedding []float64, title string) batchSignalDocument {
		return batchSignalDocument{
			Signal: NewsSignal{
				ProcessedArticleID: id,
				Language:           language,
				Title:              stringPtr(title),
			},
			Embedding:      embedding,
			EmbeddingModel: embeddingModel,
		}
	}

	documents := []batchSignalDocument{
		document("no_vector", english, model, nil, "a"),
		document("en_1", english, model, []float64{1}, "b"),
		document("no_model", english, nil, []float64{1}, "c"),
		document("de_1", german, model, []float64{1}, "d"),
		document("en_2", english, model, []float64{1}, "e"),
		document("no_text", english, model, []float64{1}, "   "),
		document("unknown_lang", nil, model, []float64{1}, "f"),
	}

	immediate, groups := partitionBatchDocuments(documents)
	if len(immediate) != 3 {
		t.Fatalf("immediate = %d, want 3", len(immediate))
	}
	for index, want := range []string{"no_vector", "no_model", "no_text"} {
		if immediate[index].Signal.ProcessedArticleID != want {
			t.Fatalf("immediate[%d] = %q, want %q", index, immediate[index].Signal.ProcessedArticleID, want)
		}
	}
	if len(groups.keys) != 3 {
		t.Fatalf("groups = %v", groups.keys)
	}
	if groups.keys[0] != "en::text-embedding-3-small" {
		t.Fatalf("groups[0] = %q", groups.keys[0])
	}
	if groups.keys[1] != "de::text-embedding-3-small" {
		t.Fatalf("groups[1] = %q", groups.keys[1])
	}
	if groups.keys[2] != "unknown::text-embedding-3-small" {
		t.Fatalf("groups[2] = %q", groups.keys[2])
	}
	if len(groups.groups[groups.keys[0]]) != 2 {
		t.Fatalf("en group size = %d", len(groups.groups[groups.keys[0]]))
	}
}

// TestToClusterTextJoinsTitleAndSummary locks the blank line join and the blank
// filtering.
func TestToClusterTextJoinsTitleAndSummary(t *testing.T) {
	document := batchSignalDocument{Signal: NewsSignal{
		Title:   stringPtr("Title"),
		Summary: stringPtr(" Summary "),
	}}
	if got := toClusterText(document); got != "Title\n\nSummary" {
		t.Fatalf("text = %q", got)
	}
	document.Signal.Summary = nil
	if got := toClusterText(document); got != "Title" {
		t.Fatalf("text = %q", got)
	}
	document.Signal.Title = stringPtr("   ")
	if got := toClusterText(document); got != "" {
		t.Fatalf("text = %q, want empty", got)
	}
	if hasClusterableText(document) {
		t.Fatal("blank text counted as clusterable")
	}
}

// TestBuildIngestionBatchQueryWithCursor locks the cursor predicate and the B1
// upper bound.
func TestBuildIngestionBatchQueryWithCursor(t *testing.T) {
	cursor := time.Date(2026, 10, 20, 11, 0, 0, 0, time.UTC)
	cursorID := "ca_5"
	state := ingestionState{LastProcessedAt: &cursor, LastProcessedArticleID: &cursorID}
	cutoff := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

	query := buildIngestionBatchQuery("org_1", state, cursor, cutoff, 100)
	if !strings.Contains(query.SQL, "pa.`processedAt` <= ?") {
		t.Fatalf("settle upper bound missing: %s", query.SQL)
	}
	if !strings.Contains(query.SQL, "ORDER BY pa.`processedAt` ASC, pa.`articleId` ASC LIMIT ?") {
		t.Fatalf("order/limit missing: %s", query.SQL)
	}
	if !strings.Contains(query.SQL, "(pa.`processedAt` > ? OR (pa.`processedAt` = ? AND pa.`articleId` > ?))") {
		t.Fatalf("cursor predicate missing: %s", query.SQL)
	}
	if strings.Contains(query.SQL, "pa.`processedAt` >= ?") {
		t.Fatalf("the no-cursor branch leaked into the cursor query: %s", query.SQL)
	}
	if len(query.Args) != 7 {
		t.Fatalf("args = %d, want 7 (%#v)", len(query.Args), query.Args)
	}
	if query.Args[0] != "org_1" || query.Args[1] != processedArticleStatusCompleted {
		t.Fatalf("args[0..1] = %#v", query.Args[:2])
	}
	if arg, ok := query.Args[2].(time.Time); !ok || !arg.Equal(cutoff) {
		t.Fatalf("settle arg = %v, want %v", query.Args[2], cutoff)
	}
	for index := 3; index <= 4; index++ {
		if arg, ok := query.Args[index].(time.Time); !ok || !arg.Equal(cursor) {
			t.Fatalf("cursor arg %d = %v, want %v", index, query.Args[index], cursor)
		}
	}
	if query.Args[5] != cursorID {
		t.Fatalf("cursor id arg = %#v", query.Args[5])
	}
	if query.Args[6] != 100 {
		t.Fatalf("limit arg = %#v", query.Args[6])
	}
}

// TestBuildIngestionBatchQueryWithoutCursor locks the backfill start and the
// settle upper bound.
func TestBuildIngestionBatchQueryWithoutCursor(t *testing.T) {
	baseline := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	cutoff := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	query := buildIngestionBatchQuery("org_2", ingestionState{}, baseline, cutoff, 25)
	if !strings.Contains(query.SQL, "pa.`processedAt` >= ?") {
		t.Fatalf("backfill lower bound missing: %s", query.SQL)
	}
	if strings.Contains(query.SQL, "pa.`articleId` > ?") {
		t.Fatalf("cursor branch leaked into the backfill query: %s", query.SQL)
	}
	if len(query.Args) != 5 {
		t.Fatalf("args = %d", len(query.Args))
	}
	if arg, ok := query.Args[2].(time.Time); !ok || !arg.Equal(cutoff) {
		t.Fatalf("settle arg = %v, want %v", query.Args[2], cutoff)
	}
	if arg, ok := query.Args[3].(time.Time); !ok || !arg.Equal(baseline) {
		t.Fatalf("baseline arg = %v, want %v", query.Args[3], baseline)
	}
	if query.Args[4] != 25 {
		t.Fatalf("limit arg = %#v", query.Args[4])
	}
}

// TestBatchProcessedItemIDsDedupesAndTrims locks the NestJS Set over the trimmed
// cleanedMarkdownRef values.
func TestBatchProcessedItemIDsDedupesAndTrims(t *testing.T) {
	batch := []ProcessedArticleRecord{
		{CleanedMarkdownRef: stringPtr(" a ")},
		{CleanedMarkdownRef: stringPtr("a")},
		{CleanedMarkdownRef: stringPtr("   ")},
		{CleanedMarkdownRef: nil},
		{CleanedMarkdownRef: stringPtr("b")},
	}
	ids := batchProcessedItemIDs(batch)
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Fatalf("ids = %#v", ids)
	}
}

// TestAlignToInterval locks the wall-clock alignment.
func TestAlignToInterval(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 3, 30, 0, time.UTC)
	if got := alignToInterval(now, 5*time.Minute); !got.Equal(time.Date(2026, 10, 20, 12, 5, 0, 0, time.UTC)) {
		t.Fatalf("aligned = %v", got)
	}
	exact := time.Date(2026, 10, 20, 12, 5, 0, 0, time.UTC)
	if got := alignToInterval(exact, 5*time.Minute); !got.Equal(time.Date(2026, 10, 20, 12, 10, 0, 0, time.UTC)) {
		t.Fatalf("aligned on a boundary = %v", got)
	}
}

// TestSchedulerKeyNames locks the shared tick-gate and organization-lock keys.
func TestSchedulerKeyNames(t *testing.T) {
	if tickGateKey != "cron:news-events-ingestion:tick-gate" {
		t.Fatalf("tick gate = %q", tickGateKey)
	}
	if tickGateTTL != 4*time.Minute+45*time.Second {
		t.Fatalf("tick gate ttl = %v", tickGateTTL)
	}
	if orgLockKeyPrefix != "lock:cron:news-events-ingestion:org:" {
		t.Fatalf("org lock prefix = %q", orgLockKeyPrefix)
	}
	if orgLockTTL != time.Minute {
		t.Fatalf("org lock ttl = %v", orgLockTTL)
	}
	if activeOrgCacheKey != "org:active:list:v1" || activeOrgLockKey != "lock:org:active:list:v1" {
		t.Fatalf("active org keys = %q/%q", activeOrgCacheKey, activeOrgLockKey)
	}
}
