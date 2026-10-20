// Package classificationalert implements the Go takeover of the NestJS
// classification quality alert scheduler.
//
// Source of truth: apps/api/src/modules/observability/classification-quality-alert-scheduler.service.ts
// (classified statement by statement, including the metric labels and log
// fields, never a simplified reimplementation).
//
// Ownership switch: cmd/api wires this unit only when
// API_GO_CLASSIFICATION_QUALITY_ALERT_MODE=go. In that mode the NestJS
// @Interval handler returns before claiming the tick gate, so the two
// processes never both own an interval.
//
// Key contract (shared with NestJS so both schedulers contend safely):
//   - tick gate "cron:classification-quality-alert:tick-gate":
//     SET key '{"claimedAt":"<ISO>"}' EX 285 NX, no "lock:" prefix
//     (claimSchedulerTick);
//   - organization lock "lock:quality:classification:alert-scheduler:<orgId>:1h":
//     CacheService.withLock("quality:classification:alert-scheduler:<orgId>:1h")
//     adds the "lock:" prefix, TTL 240s with token-checked renewal and release;
//   - active organizations "org:active:list:v1": 15s value TTL, 2s fill lock,
//     50ms retry and 500ms wait, the exact cache ActiveOrgRegistryService reads;
//   - metrics scheduler_runs_total{scheduler="classification_quality_alerts",
//     status="success"|"failure"}: the existing family, never a new one.
//
// One organization evaluation is
// internal/classificationrssops.EvaluateClassificationQualityAlerts: the
// getSummary({orgId, window:"1h"}) equivalent, including its side effects
// (summary cache fill, threshold-alert throttle, recipient lookup and
// Notification rows). The Notification relay hook installed by cmd/api makes
// those rows reach the Go Socket.IO transport through notification:events:v1.
//
// Redis, MySQL and the summary evaluation are all injected through Options, so
// the whole evaluation flow is unit tested with fakes and no infrastructure.
package classificationalert
