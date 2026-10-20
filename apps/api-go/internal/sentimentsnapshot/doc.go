// Package sentimentsnapshot owns the hourly sentiment snapshot rebuild cron.
//
// It is the Go port of SentimentSnapshotIngestionService.rebuildRecentSnapshots
// from apps/api/src/modules/sentiment/sentiment-snapshot.ingestion.service.ts.
// The port keeps the NestJS contract:
//
//   - the tick gate key "cron:sentiment-snapshot:tick-gate" with
//     {"claimedAt": <ISO>} and a 3300 second TTL;
//   - the organization lease "cron:sentiment-snapshot:org:<orgId>" with a
//     300 second TTL, whose physical Redis key is "lock:" + that name;
//   - today and yesterday as UTC days, the two aggregation pipelines verbatim,
//     the 5000 row cap and the delete-then-rewrite transaction.
//
// One deliberate difference from the NestJS implementation is documented in the
// PR: an ON DUPLICATE KEY UPDATE write merges rows whose names are distinct in
// Mongo but equal under the table's utf8mb4_unicode_ci collation, instead of
// aborting the whole transaction on the unique index.
package sentimentsnapshot
