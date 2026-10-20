package kgingestion

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeBatchStore struct {
	articles []ProcessedArticle
	listErr  error
	limit    int
	advanced []string
}

func (s *fakeBatchStore) ListProcessedArticles(_ context.Context, _ string, _ *Cursor, limit int) ([]ProcessedArticle, error) {
	s.limit = limit
	return s.articles, s.listErr
}

func (s *fakeBatchStore) AdvanceCursor(_ context.Context, _ string, _ time.Time, articleID string) error {
	s.advanced = append(s.advanced, articleID)
	return nil
}

type fakeFailureCounter struct {
	counts    map[string]int
	increment int
	reset     int
}

func (c *fakeFailureCounter) Increment(_ context.Context, _ string, articleID string) (int64, error) {
	c.increment++
	c.counts[articleID]++
	return int64(c.counts[articleID]), nil
}

func (c *fakeFailureCounter) Reset(_ context.Context, _ string, articleID string) error {
	c.reset++
	delete(c.counts, articleID)
	return nil
}

type fakeArticleProcessor struct {
	failures map[string]int
	calls    []string
}

func (p *fakeArticleProcessor) ProcessArticle(_ context.Context, _ string, article ProcessedArticle, _ Settings) (ArticleWriteStats, error) {
	p.calls = append(p.calls, article.ArticleID)
	if p.failures[article.ArticleID] > 0 {
		p.failures[article.ArticleID]--
		return ArticleWriteStats{}, errors.New("boom")
	}
	return ArticleWriteStats{EdgesUpserted: 1, ValidatedRelations: 1, FilteredRelations: 1}, nil
}

func batchFixture() []ProcessedArticle {
	base := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	return []ProcessedArticle{
		{ArticleID: "a", ProcessedAt: base},
		{ArticleID: "b", ProcessedAt: base},
		{ArticleID: "c", ProcessedAt: base.Add(time.Minute)},
	}
}

func newBatchFixtures() (*fakeBatchStore, *fakeFailureCounter, *fakeArticleProcessor) {
	return &fakeBatchStore{articles: batchFixture()}, &fakeFailureCounter{counts: map[string]int{}}, &fakeArticleProcessor{failures: map[string]int{}}
}

func TestRunOrgBatchProcessesEveryArticle(t *testing.T) {
	store, counter, processor := newBatchFixtures()
	settings := Settings{MaxBatchSize: 50}
	summary, err := runOrgBatch(context.Background(), "org", settings, &Cursor{}, store, counter, processor, nil)
	if err != nil {
		t.Fatal(err)
	}
	if summary.ProcessedArticles != 3 || summary.FailedArticles != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if store.limit != 50 {
		t.Fatalf("limit = %d", store.limit)
	}
	wantAdvanced := []string{"a", "b", "c"}
	if len(store.advanced) != len(wantAdvanced) {
		t.Fatalf("advanced = %v", store.advanced)
	}
	for index, want := range wantAdvanced {
		if store.advanced[index] != want {
			t.Fatalf("advanced = %v", store.advanced)
		}
	}
	if summary.UpsertedEdges != 3 || summary.ValidatedRelations != 3 || summary.FilteredRelations != 3 {
		t.Fatalf("aggregates = %+v", summary)
	}
}

// TestRunOrgBatchStopsAtFirstFailure is K1: a failed article must keep the
// cursor before itself, so the next tick retries it instead of resuming past.
func TestRunOrgBatchStopsAtFirstFailure(t *testing.T) {
	store, counter, processor := newBatchFixtures()
	processor.failures["b"] = 1
	summary, err := runOrgBatch(context.Background(), "org", Settings{MaxBatchSize: 50}, &Cursor{}, store, counter, processor, nil)
	if err != nil {
		t.Fatal(err)
	}
	if summary.ProcessedArticles != 1 || summary.FailedArticles != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(store.advanced) != 1 || store.advanced[0] != "a" {
		t.Fatalf("advanced = %v", store.advanced)
	}
	if counter.counts["b"] != 1 {
		t.Fatalf("failure count = %v", counter.counts)
	}
	if len(processor.calls) != 2 {
		t.Fatalf("processed %v, want to stop after b", processor.calls)
	}
}

// TestRunOrgBatchSkipsAfterThreeFailures covers the K1 safety valve.
func TestRunOrgBatchSkipsAfterThreeFailures(t *testing.T) {
	store, counter, processor := newBatchFixtures()
	counter.counts["a"] = 2
	processor.failures["a"] = 1
	summary, err := runOrgBatch(context.Background(), "org", Settings{MaxBatchSize: 50}, &Cursor{}, store, counter, processor, nil)
	if err != nil {
		t.Fatal(err)
	}
	if summary.ProcessedArticles != 2 || summary.FailedArticles != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	want := []string{"a", "b", "c"}
	if len(store.advanced) != len(want) {
		t.Fatalf("advanced = %v", store.advanced)
	}
	for index, id := range want {
		if store.advanced[index] != id {
			t.Fatalf("advanced = %v", store.advanced)
		}
	}
}

func TestRunOrgBatchReturnsListError(t *testing.T) {
	store, counter, processor := newBatchFixtures()
	store.listErr = errors.New("mysql down")
	_, err := runOrgBatch(context.Background(), "org", Settings{MaxBatchSize: 50}, &Cursor{}, store, counter, processor, nil)
	if err == nil {
		t.Fatal("expected list error")
	}
	if len(processor.calls) != 0 {
		t.Fatalf("processed %v", processor.calls)
	}
}
