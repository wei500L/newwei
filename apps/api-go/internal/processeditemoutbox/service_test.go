package processeditemoutbox

import (
	"context"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

func TestBackoffDelayMatchesLegacyFormula(t *testing.T) {
	service := &Service{random: func() float64 { return 0.5 }}
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{0, 30 * time.Second},
		{1, 30 * time.Second},
		{2, 60 * time.Second},
		{5, 480 * time.Second},
		{6, 480 * time.Second},
		{10, 480 * time.Second},
	}
	for _, testCase := range cases {
		if got := service.backoffDelay(testCase.attempt); got != testCase.want {
			t.Fatalf("backoffDelay(%d) = %s, want %s", testCase.attempt, got, testCase.want)
		}
	}
	service.random = func() float64 { return 0 }
	if got := service.backoffDelay(1); got != 15*time.Second {
		t.Fatalf("low jitter = %s, want 15s", got)
	}
	service.random = func() float64 { return 1 }
	if got := service.backoffDelay(1); got != 45*time.Second {
		t.Fatalf("high jitter = %s, want 45s", got)
	}
}

func TestToItemMetaNameMatches191Boundary(t *testing.T) {
	exact := make([]rune, 191)
	for index := range exact {
		exact[index] = 'a'
	}
	if got := toItemMetaName(string(exact)); got != string(exact) {
		t.Fatalf("191 characters should not be truncated")
	}
	long := string(exact) + "b"
	got := toItemMetaName(long)
	if len([]rune(got)) != 191 || got[len(got)-len("…"):] != "…" {
		t.Fatalf("truncated name = %q", got)
	}
	if got[:190] != string(exact[:190]) {
		t.Fatalf("truncated prefix = %q", got[:190])
	}
	spaced := string(exact[:189]) + "  " + "xyz"
	if trimmed := toItemMetaName(spaced); trimmed[len(trimmed)-1] != '…' {
		t.Fatalf("spaced name = %q", trimmed)
	}
}

func TestTruncateUTF16UsesJavaScriptSlices(t *testing.T) {
	if got := truncateUTF16("hello", 2000); got != "hello" {
		t.Fatalf("short value = %q", got)
	}
	if got := truncateUTF16("abcde", 3); got != "abc" {
		t.Fatalf("slice = %q", got)
	}
}

func TestReadModelProjectionUsesDeliverySnapshots(t *testing.T) {
	created := "2026-01-02T03:04:05.000Z"
	published := "2026-01-01T00:00:00.000Z"
	model := "embed-v1"
	dimensions := 2
	sourceID := "source-1"
	rawPayload := itemsreading.NewOpenJSON([]byte(`{"url":"https://example.com/a","metadata":{"sourceName":"Publisher","sourceId":"raw-source"},"summary":"raw summary"}`))
	processedResult := itemsreading.NewOpenJSON([]byte(`{"title":"Processed title","summary":"processed summary","topics":["Topic"],"entities":[{"name":"ACME","type":"company","confidence":0.9}],"sentiment_label":"positive"}`))
	doc := itemsreading.BuildReadModelDocument(itemsreading.ReadModelBuildInput{
		Meta: itemsreading.ItemMetaRow{
			ID: "meta-1", OrgID: "org-1", ExternalID: "external-1", Name: "Old name",
			Status: "completed", MongoRef: "507f1f77bcf86cd799439012", Version: 2,
			SortAt:    itemsreading.NewISOTime(mustTime(t, published)),
			CreatedAt: itemsreading.NewISOTime(mustTime(t, created)),
			UpdatedAt: itemsreading.NewISOTime(mustTime(t, created)),
		},
		Raw: &itemsreading.ReadModelRawDoc{
			ID: "507f1f77bcf86cd799439012", ItemMetaID: "meta-1", Payload: rawPayload,
			CreatedAt: itemsreading.NewISOTime(mustTime(t, created)), UpdatedAt: itemsreading.NewISOTime(mustTime(t, created)),
		},
		Processed: &itemsreading.ReadModelProcessedDoc{
			ID: "507f1f77bcf86cd799439011", ItemMetaID: "meta-1", SourceID: &sourceID,
			Status: "completed", Tags: []string{" tag-1 ", "tag-1", "tag-2"}, Result: processedResult,
			SummaryEmbeddingModel: &model, SummaryEmbeddingDimensions: &dimensions,
			CreatedAt: itemsreading.NewISOTime(mustTime(t, created)), UpdatedAt: itemsreading.NewISOTime(mustTime(t, created)),
		},
		SourceID: &sourceID,
	})
	if doc.Title != "Processed title" || doc.SourceName == nil || *doc.SourceName != "Publisher" {
		t.Fatalf("title/source = %q/%v", doc.Title, doc.SourceName)
	}
	if doc.SourceID == nil || *doc.SourceID != "source-1" {
		t.Fatalf("sourceId = %v", doc.SourceID)
	}
	if len(doc.Tags) != 2 || doc.Tags[0] != "tag-1" || !doc.HasVector {
		t.Fatalf("tags/hasVector = %+v/%v", doc.Tags, doc.HasVector)
	}
	if doc.Processed == nil || doc.Processed.Status != "completed" || doc.Processed.SummaryEmbeddingDimensions == nil || *doc.Processed.SummaryEmbeddingDimensions != 2 {
		t.Fatalf("processed = %+v", doc.Processed)
	}
	if doc.Processed.CreatedAt.Time.Format(time.RFC3339) != "2026-01-02T03:04:05Z" {
		t.Fatalf("processed createdAt = %s", doc.Processed.CreatedAt.Time)
	}
	if len(doc.SearchTerms) == 0 || len(doc.SearchText) == 0 {
		t.Fatalf("search projection empty: %+v", doc)
	}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestUpsertVectorConditions(t *testing.T) {
	writer := &countingVector{}
	service := &Service{
		vectorConfig: fixedVectorConfig{},
		vector:       writer,
		now:          time.Now,
	}
	empty := ""
	duplicate := "507f1f77bcf86cd799439099"
	model := "embed-v1"
	doc := Document{
		ID: "507f1f77bcf86cd799439011", ItemMetaID: "meta-1", OrgID: "org-1",
		DuplicateOf: &duplicate, SummaryEmbedding: []float64{0.1}, SummaryEmbeddingSet: true,
		SummaryEmbeddingModel: &model,
	}
	if err := service.upsertVector(t.Context(), doc, nil); err != nil || writer.calls != 0 {
		t.Fatalf("duplicate vector call: err=%v calls=%d", err, writer.calls)
	}
	doc.DuplicateOf = &empty
	doc.SummaryEmbedding = nil
	if err := service.upsertVector(t.Context(), doc, nil); err != nil || writer.calls != 0 {
		t.Fatalf("empty embedding call: err=%v calls=%d", err, writer.calls)
	}
	doc.SummaryEmbedding = []float64{0.1}
	emptyModel := ""
	doc.SummaryEmbeddingModel = &emptyModel
	if err := service.upsertVector(t.Context(), doc, nil); err != nil || writer.calls != 0 {
		t.Fatalf("empty model call: err=%v calls=%d", err, writer.calls)
	}
	doc.SummaryEmbeddingModel = &model
	if err := service.upsertVector(t.Context(), doc, nil); err != nil {
		t.Fatal(err)
	}
	if writer.calls != 1 || writer.last.EmbeddingModel != model || writer.last.Points[0].ItemMetaID != "meta-1" {
		t.Fatalf("vector call = %+v", writer.last)
	}
}

type fixedVectorConfig struct{}

func (fixedVectorConfig) EffectiveVectorConfig(context.Context) (vectorclient.Config, error) {
	return vectorclient.Config{Enabled: true, BaseURL: "http://vector", Token: "token"}, nil
}

type countingVector struct {
	calls int
	last  vectorclient.UpsertRequest
}

func (v *countingVector) Upsert(_ context.Context, _ vectorclient.Config, request vectorclient.UpsertRequest) error {
	v.calls++
	v.last = request
	return nil
}
