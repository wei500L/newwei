// Package pipelinerecovery serves the read-only pipeline recovery view of the
// admin quality workbench: GET /api/admin/quality/pipeline/runs.
//
// It reads ItemMeta from MySQL and ProcessedItem / TaskLog from Mongo and
// assembles one run per processed item, with the latest log row of every stage.
// Field names, ordering and defaults mirror PipelineRecoveryService.getRuns in
// apps/api/src/modules/observability/pipeline-recovery.service.ts so the web
// page keeps working unchanged.
//
// Replay and rollback are deliberately absent: both need the item pipeline
// producer (pipelineenqueue) that this batch does not have on main, so the two
// POST routes stay on NestJS and are not registered here.
package pipelinerecovery
