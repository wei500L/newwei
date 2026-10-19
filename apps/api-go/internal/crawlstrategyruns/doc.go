// Package crawlstrategyruns migrates the crawl strategy workflow run recorder
// and the trial-run/replay execution chain from
// apps/api/src/modules/crawl/crawl-strategy-run-recorder.service.ts and
// apps/api/src/modules/crawl/crawl-strategy-runtime.service.ts.
//
// Scope: the three crawl discovery entries that write workflow runs —
// POST /api/admin/crawl-frontier/workflows/:id/trial-run,
// POST /api/admin/crawl-frontier/workflow-runs/:runId/replay and the run records
// they create — plus the news-source preview that shares the discovery chain. The
// run detail, candidate and explanation reads stay in package crawlfrontierruns,
// which reads the same five tables and CrawlFrontierRun relation.
//
// Write contract: every insert carries a client-generated cuid-shaped id,
// millisecond timestamps and the same JSON document shapes NestJS writes, so the
// existing reads (Go and NestJS) render the same run, steps, candidates, traces,
// events, counts and error text. finalizeRun runs in one transaction exactly like
// the source: it replaces the step/event/candidate rows and then updates the run
// row with the aggregated counts.
package crawlstrategyruns
