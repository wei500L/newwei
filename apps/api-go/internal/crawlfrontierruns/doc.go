// Package crawlfrontierruns serves the crawl frontier run monitoring and
// cancellation HTTP routes that the Go gateway takes over when
// API_GO_CRAWL_FRONTIER_RUNS_MODE=go.
//
// The unit migrates eleven routes under /api/admin/crawl-frontier:
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
// Every route is read-only except the two cancellation routes. Cancellation is
// implemented with the same transaction and row-lock protocol as the fixed
// NestJS implementation: terminal runs are skipped, locked ids are updated in
// ascending order, and one cancellation event is appended per locked workflow
// run after the transaction commits. The write queue routes (create run,
// retry, replay, trial-run) are never registered here, so they keep falling
// back to NestJS and no BullMQ job or crawl4ai call is made by this package.
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
