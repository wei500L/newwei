package httproute

import "net/http"

// QueueOpsKey is the Go handler registration key of the queue operations
// console. The key is synthetic and never collides with a real request path.
const QueueOpsKey = "/__go/queue-ops"

// WithQueueOps registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
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
