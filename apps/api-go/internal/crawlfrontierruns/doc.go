// Package crawlfrontierruns serves the crawl frontier monitoring, cancellation
// and admin write HTTP routes that the Go gateway takes over under
// /api/admin/crawl-frontier.
//
// Two switches own disjoint route sets, so a read-only deployment never
// registers a write handler and vice versa:
//
// API_GO_CRAWL_FRONTIER_RUNS_MODE=go takes over eleven routes:
//
//	GET  /runs
//	GET  /runs/:id
//	GET  /runs/:id/workflow-run
//	GET  /runs/:id/workflow-candidates
//	GET  /runs/:id/workflow-candidates/:candidateId
//	POST /runs/cancel
//	POST /runs/:id/cancel
//	GET  /nodes/:id
//	GET  /workflow-runs/:runId
//	GET  /workflow-runs/:runId/candidates
//	GET  /workflow-runs/:runId/candidates/:candidateId/explanation
//
// API_GO_CRAWL_FRONTIER_WRITES_MODE=go takes over three routes:
//
//	POST /runs
//	POST /nodes/retry
//	POST /nodes/:id/retry
//
// The write switch requires the read switch (config.go), because create and
// retry answer with the very same getRun run detail the read routes serve.
//
// The eleven read routes are read-only apart from the two cancellation routes.
// Cancellation is implemented with the same transaction and row-lock protocol
// as the fixed NestJS implementation: terminal runs are skipped, locked ids are
// updated in ascending order, and one cancellation event is appended per locked
// workflow run after the transaction commits.
//
// The three write routes do enqueue crawl work: createRun writes the synthetic
// CrawlTask, the run, the workflow run and the root node and enqueues that root
// node, and the two retry routes requeue a node. They never call crawl4ai
// themselves and never start a worker; a queued node is executed by whichever
// side currently owns the crawl worker, and both sides speak the same queue
// protocol.
//
// Identity is always derived server-side. Human tokens go through JWT
// verification, the Redis revocation list and membership-based permission
// re-derivation; mtk_ machine tokens are looked up by SHA-256 in
// MachineAccessToken. JWT permission claims are never trusted and orgId always
// comes from the authenticated identity. Request DTOs reproduce the
// class-validator messages and ordering of the NestJS DTOs, responses reproduce
// the Prisma field order, and schema-less JSON columns are carried as RawJSON
// so no untyped container is used anywhere in this package.
package crawlfrontierruns
