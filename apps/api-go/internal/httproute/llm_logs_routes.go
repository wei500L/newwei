package httproute

import "net/http"

// LlmLogsKey is the handler registration key for the three read-only LLM
// request-log GET routes. All three are exact paths with no dynamic segment, so
// the key is the collection path itself.
const LlmLogsKey = "/api/llm-logs"

// WithLlmLogs appends the three read-only LLM request-log GET routes:
// /api/llm-logs, /api/llm-logs/export and /api/llm-logs/summary, all exact and
// all requiring settings.manage.
func WithLlmLogs(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, LlmLogsKey, "/api/llm-logs", http.MethodGet)
	rules = appendExactKeyed(rules, LlmLogsKey, "/api/llm-logs/export", http.MethodGet)
	return appendExactKeyed(rules, LlmLogsKey, "/api/llm-logs/summary", http.MethodGet)
}
