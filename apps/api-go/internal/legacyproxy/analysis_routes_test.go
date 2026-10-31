package legacyproxy

import (
	"net/http"
	"testing"
)

func TestAnalysisRoutesMatchMethodAndShape(t *testing.T) {
	rules := BaseRules()
	rules = WithAnalysisViews(rules)
	rules = WithAnalysisBoards(rules)
	rules = WithAnalysisThreads(rules)
	gateway := New(rules)

	goCases := []struct {
		method string
		path   string
		key    string
	}{
		{http.MethodGet, "/api/analysis/views", AnalysisViewsKey},
		{http.MethodPost, "/api/analysis/views", AnalysisViewsKey},
		{http.MethodGet, "/api/analysis/views/view-1", AnalysisViewsKey},
		{http.MethodPatch, "/api/analysis/views/view-1", AnalysisViewsKey},
		{http.MethodDelete, "/api/analysis/views/view-1", AnalysisViewsKey},
		{http.MethodGet, "/api/analysis/boards", AnalysisBoardsKey},
		{http.MethodPost, "/api/analysis/boards", AnalysisBoardsKey},
		{http.MethodGet, "/api/analysis/boards/board-1", AnalysisBoardsKey},
		{http.MethodDelete, "/api/analysis/boards/board-1", AnalysisBoardsKey},
		{http.MethodPost, "/api/analysis/boards/board-1/columns", AnalysisBoardsKey},
		{http.MethodPost, "/api/analysis/boards/board-1/columns/reorder", AnalysisBoardsKey},
		{http.MethodPatch, "/api/analysis/columns/column-1", AnalysisColumnsKey},
		{http.MethodDelete, "/api/analysis/columns/column-1", AnalysisColumnsKey},
		{http.MethodPost, "/api/analysis/boards/board-1/tasks", AnalysisTasksKey},
		{http.MethodPatch, "/api/analysis/tasks/task-1", AnalysisTasksKey},
		{http.MethodDelete, "/api/analysis/tasks/task-1", AnalysisTasksKey},
		{http.MethodPost, "/api/analysis/tasks/task-1/move", AnalysisTasksKey},
		{http.MethodGet, "/api/analysis/threads/saved_view/view-1", AnalysisThreadsKey},
		{http.MethodPut, "/api/analysis/threads/analysis_task/task-1", AnalysisThreadsKey},
		{http.MethodPost, "/api/analysis/threads/item/item-1/comments", AnalysisThreadsKey},
		{http.MethodPatch, "/api/analysis/comments/comment-1", AnalysisCommentsKey},
		{http.MethodDelete, "/api/analysis/comments/comment-1", AnalysisCommentsKey},
	}
	for _, tc := range goCases {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != tc.key {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, key, tc.key)
		}
	}

	legacyCases := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/analysis/exports/search"},
		{http.MethodPost, "/api/analysis/exports/items"},
		{http.MethodPost, "/api/analysis/exports/events"},
		{http.MethodPut, "/api/analysis/views"},
		{http.MethodPost, "/api/analysis/views/view-1"},
		{http.MethodGet, "/api/analysis/views/view-1/extra"},
		{http.MethodGet, "/api/analysis/boards/board-1/columns"},
		{http.MethodPost, "/api/analysis/boards/board-1/columns/reorder/extra"},
		{http.MethodPost, "/api/analysis/boards/board-1/tasks/extra"},
		{http.MethodGet, "/api/analysis/threads/saved_view"},
		{http.MethodGet, "/api/analysis/threads/saved_view/view-1/comments"},
		{http.MethodPost, "/api/analysis/threads/saved_view/view-1/comments/extra"},
		{http.MethodPatch, "/api/analysis/tasks/task-1/move"},
	}
	for _, tc := range legacyCases {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
