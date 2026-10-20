// Package auditoutbox replays the AuditLogOutbox rows that the audit writer
// enqueued when a direct AuditLog insert failed.
//
// It owns one background chain: the per-minute Redis lease, the three-status
// candidate scan, the conditional claim, the five-column dedupe insert into
// AuditLog, the outbox delete, and the failure backoff / dead transition. The
// user-visible path is unchanged: the existing admin audit-log page reads the
// recovered AuditLog rows through its normal query.
//
// The package deliberately excludes every other outbox worker (RawItem,
// CrawlCleanup, NewsPipeline), audit retention and any notification side
// effect. The payload contract is the same envelope the NestJS consumer and
// the Go producers already write.
package auditoutbox
