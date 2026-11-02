package legacyproxy

import "net/http"

// QueueOpsKey is the Go handler registration key of the queue operations
// console. The key is synthetic and never collides with a real request path.
const QueueOpsKey = "/__go/queue-ops"

// WithQueueOps registers the twelve queue operations console routes taken over
// when API_GO_QUEUE_OPS_MODE=go:
//
//	GET  /api/admin/queue-ops/queues
//	GET  /api/admin/queue-ops/jobs
//	GET  /api/admin/queue-ops/jobs/detail
//	POST /api/admin/queue-ops/jobs/retry
//	POST /api/admin/queue-ops/jobs/delete
//	POST /api/admin/queue-ops/jobs/promote
//	POST /api/admin/queue-ops/queues/retry-failed
//	POST /api/admin/queue-ops/queues/clean
//	POST /api/admin/queue-ops/queues/pause
//	POST /api/admin/queue-ops/queues/resume
//	POST /api/admin/queue-ops/dlq/replay
//	POST /api/admin/queue-ops/dlq/delete
//
// Every path is exact: the queue name and the job id travel in the query string
// or the request body, because a BullMQ job id may contain "/" and ":", which no
// dynamic-segment rule can express. appendExactKeyed adds OPTIONS to each rule so
// a CORS preflight reaches the Go handler (which forwards a preflight without
// CORS headers back to NestJS).
//
// These paths are new: NestJS never served /api/admin/queue-ops, so with
// API_GO_QUEUE_OPS_MODE=legacy this function adds no rule at all and the requests
// keep falling through to the /api/ legacy fallback, where Nest answers 404.
// /admin/queues (Bull Board) is untouched and keeps proxying to NestJS.
func WithQueueOps(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/queues",
		http.MethodGet)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/jobs",
		http.MethodGet)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/jobs/detail",
		http.MethodGet)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/jobs/retry",
		http.MethodPost)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/jobs/delete",
		http.MethodPost)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/jobs/promote",
		http.MethodPost)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/queues/retry-failed",
		http.MethodPost)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/queues/clean",
		http.MethodPost)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/queues/pause",
		http.MethodPost)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/queues/resume",
		http.MethodPost)
	rules = appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/dlq/replay",
		http.MethodPost)
	return appendExactKeyed(rules, QueueOpsKey, "/api/admin/queue-ops/dlq/delete",
		http.MethodPost)
}
