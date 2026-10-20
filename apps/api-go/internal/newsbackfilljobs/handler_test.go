package newsbackfilljobs

import "testing"

func TestParseLlmBackfillGroupID(t *testing.T) {
	valid := map[string]string{
		"/api/system-settings/news-events/clustering/failures/group-1/llm-backfill":   "group-1",
		"/api/system-settings/news-events/clustering/failures/group%201/llm-backfill": "group 1",
		"/api/system-settings/news-events/clustering/failures/abc:def/llm-backfill":   "abc:def",
	}
	for path, want := range valid {
		got, ok := parseLlmBackfillGroupID(path)
		if !ok || got != want {
			t.Fatalf("%s = %q ok=%t, want %q", path, got, ok, want)
		}
	}
	invalid := []string{
		"/api/system-settings/news-events/clustering/failures//llm-backfill",
		"/api/system-settings/news-events/clustering/failures/a/b/llm-backfill",
		"/api/system-settings/news-events/clustering/failures/llm-backfill",
		"/api/system-settings/news-events/clustering/failures/group-1/vector-backfill",
		"/api/system-settings/news-events/clustering/failures/group-1/llm-backfill/extra",
		"/api/system-settings/news-events/clustering/overview",
	}
	for _, path := range invalid {
		if got, ok := parseLlmBackfillGroupID(path); ok {
			t.Fatalf("%s unexpectedly parsed as %q", path, got)
		}
	}
}
