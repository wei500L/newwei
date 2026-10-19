// Package gdeltsnapshot generates and serves the situation-monitor GDELT
// external snapshot. It is the Go counterpart of
// apps/api/src/modules/situation-monitor/situation-monitor-external-snapshot.service.ts
// (rebuildSnapshot, readSnapshot, persistSnapshot, pruneHistory,
// buildStatusSummary, loadStatusMetrics) and of
// apps/api/src/modules/system-settings/situation-monitor-settings.controller.ts
// (POST external-snapshot/refresh).
//
// # Execution ownership
//
// Two independent switches decide who executes:
//
//   - API_GO_GDELT_SNAPSHOT_MODE owns the 15-minute wall-clock rebuild. go
//     starts Scheduler in this package and makes the NestJS @Cron callback
//     return before it acquires the lock; legacy (the default) starts nothing
//     here and NestJS keeps both the schedule and the lock.
//   - API_GO_GDELT_SNAPSHOT_REFRESH_MODE owns
//     POST /api/system-settings/situation-monitor/external-snapshot/refresh.
//     It is read by Go only; legacy (the default) keeps the route on NestJS.
//
// The two switches are independent of each other. A forced refresh always runs
// the Go rebuild when the route is taken over, no matter which process owns the
// schedule.
//
// # Lock contract
//
// Both executions take the Redis lease that NestJS CacheService.withLock uses:
// the physical key "lock:cron:situation-monitor:external-snapshot:gdelt" (the
// NestJS key plus CacheService's "lock:" prefix), SET NX PX with a random owner
// token, auto-renewal every TTL/3 and a compare-and-delete release. A run that
// cannot acquire the lease skips instead of queueing. Because NestJS and Go
// share the lease, a switch flip that briefly has both schedulers alive still
// rebuilds at most once, and a forced refresh never overlaps a scheduled one.
//
// # Snapshot format
//
// The payload written to MySQL, to the Redis fresh/stale keys and returned by
// the status summary is byte-compatible with NestJS JSON.stringify output:
// struct field order follows the NestJS object literal order, timestamps are
// ISO-8601 UTC with milliseconds and a trailing Z, empty collections are []
// and not null, and HTML characters are not escaped. That is what keeps
// situation insights (#103) able to read a Go-written snapshot and vice versa.
//
// # Category reuse
//
// Categories run in the SITUATION_MONITOR_CATEGORIES order. A category that
// yields no usable headline keeps the previous snapshot's headlines for that
// category (status "reused") when the previous snapshot has any, and otherwise
// becomes "empty". A category that fails and has no previous content also joins
// diagnostics.failedCategories. Any warning, reuse or failure makes the
// snapshot "partial"; only a run with headlines but no warning marks it
// "completed".
//
// # Request pacing
//
// One rebuild issues at most six GDELT requests, one per category, each with a
// 20 second budget and a single IPv4 fallback attempt. Categories are strictly
// sequential and separated by a fixed 5.5 second pause (not after the last
// one), so the request rate never exceeds the NestJS implementation. The pause
// is context-aware: a shutdown cancels it instead of sleeping out the rest of
// the interval, which does not change request spacing during normal operation.
//
// # Deliberate optimizations
//
// The status summary reads a 24 hour window of snapshots (about 96 rows). The
// NestJS implementation loads every column of every row and parses every stored
// payload to count warnings and available categories. This package computes the
// same counters in one projected SQL aggregate (see store.go) so a summary
// call transfers counters instead of megabytes of headlines; the reference
// implementation is kept for the equivalence tests in summary_test.go and
// snapshot_integration_test.go. The read path fetches the fresh and stale cache
// entries in one MGET, and a rebuild marshals the payload once and reuses those
// bytes for MySQL and for both cache layers, which also guarantees the caches
// and the history row carry identical JSON.
package gdeltsnapshot
