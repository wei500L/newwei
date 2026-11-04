package httproute

import "net/http"

// Handler registration keys for the analysis workbench routes. Dynamic rule
// prefixes carry a trailing slash, so lookups use these static keys and the board
// handler never answers task creation.
const (
	AnalysisViewsKey    = "/api/analysis/views"
	AnalysisBoardsKey   = "/api/analysis/boards"
	AnalysisColumnsKey  = "/api/analysis/columns"
	AnalysisTasksKey    = "/api/analysis/tasks"
	AnalysisThreadsKey  = "/api/analysis/threads"
	AnalysisCommentsKey = "/api/analysis/comments"
)

// WithAnalysisViews appends the five saved-view routes: GET/POST
// /api/analysis/views (exact) and GET/PATCH/DELETE /api/analysis/views/:id (one
// segment).
func WithAnalysisViews(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, AnalysisViewsKey, "/api/analysis/views",
		http.MethodGet, http.MethodPost)
	return appendSegmentRule(rules, AnalysisViewsKey, "/api/analysis/views/", true, false, "",
		http.MethodGet, http.MethodPatch, http.MethodDelete)
}

// WithAnalysisBoards appends the thirteen board, column and task routes: exact
// /api/analysis/boards GET/POST, one-segment /boards/:id GET/PATCH/DELETE, the
// nested /boards/:id/columns and /columns/reorder POSTs, /boards/:id/tasks POST
// (keyed to AnalysisTasksKey), and /columns/:id and /tasks/:id PATCH/DELETE plus
// /tasks/:id/move POST.
func WithAnalysisBoards(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, AnalysisBoardsKey, "/api/analysis/boards",
		http.MethodGet, http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisBoardsKey, "/api/analysis/boards/", true, false, "",
		http.MethodGet, http.MethodPatch, http.MethodDelete)
	rules = appendSegmentRule(rules, AnalysisBoardsKey, "/api/analysis/boards/", true, false, "/columns",
		http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisBoardsKey, "/api/analysis/boards/", true, false, "/columns/reorder",
		http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisTasksKey, "/api/analysis/boards/", true, false, "/tasks",
		http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisColumnsKey, "/api/analysis/columns/", true, false, "",
		http.MethodPatch, http.MethodDelete)
	rules = appendSegmentRule(rules, AnalysisTasksKey, "/api/analysis/tasks/", true, false, "",
		http.MethodPatch, http.MethodDelete)
	return appendSegmentRule(rules, AnalysisTasksKey, "/api/analysis/tasks/", true, false, "/move",
		http.MethodPost)
}

// WithAnalysisThreads appends the five discussion and comment routes:
// two-segment /api/analysis/threads/:a/:b GET/PUT, its exact /comments POST, and
// one-segment /api/analysis/comments/:id PATCH/DELETE.
func WithAnalysisThreads(rules []Rule) []Rule {
	rules = appendSegmentRule(rules, AnalysisThreadsKey, "/api/analysis/threads/", false, true, "",
		http.MethodGet, http.MethodPut)
	rules = appendSegmentRule(rules, AnalysisThreadsKey, "/api/analysis/threads/", false, true, "/comments",
		http.MethodPost)
	return appendSegmentRule(rules, AnalysisCommentsKey, "/api/analysis/comments/", true, false, "",
		http.MethodPatch, http.MethodDelete)
}

func appendExactKeyed(rules []Rule, key, path string, methods ...string) []Rule {
	set := map[string]bool{http.MethodOptions: true}
	for _, method := range methods {
		set[method] = true
	}
	return append(rules, Rule{
		Prefix:     path,
		Exact:      true,
		HandlerKey: key,
		Methods:    set,
	})
}

func appendSegmentRule(rules []Rule, key, prefix string, one, two bool, tail string, methods ...string) []Rule {
	set := map[string]bool{http.MethodOptions: true}
	for _, method := range methods {
		set[method] = true
	}
	return append(rules, Rule{
		Prefix:      prefix,
		OneSegment:  one,
		TwoSegments: two,
		Tail:        tail,
		HandlerKey:  key,
		Methods:     set,
	})
}
