// Package newseventstimeline owns the news-event timeline rebuild cron.
//
// It is the Go port of NewsEventsTimelineService.rebuildRecentTimelines from
// apps/api/src/modules/news-events/news-events-timeline.service.ts. The port
// keeps the NestJS contract:
//
//   - the tick gate key "cron:news-events-timeline:tick-gate" with
//     {"claimedAt": <ISO>} and a 585 second TTL;
//   - the organization lease "cron:news-events-timeline:org:<orgId>" with a
//     540 second TTL, whose physical Redis key is "lock:" + that name;
//   - the NewsEvent selection, the 5000-item cap, the UTC day bucketing and the
//     bucket key format (Date.toISOString);
//   - the classification, importance, distribution, KL-drift and phase-summary
//     arithmetic, including JavaScript rounding and toFixed;
//   - the metadata.timeline payload shape.
//
// Two deliberate differences from the NestJS implementation are documented in
// the PR:
//
//	B1  metadata is written with JSON_SET on "$.timeline" only, so a briefV1
//	    leaf written while a rebuild is in flight is never overwritten with the
//	    stale snapshot read at the start of the run.
//	O1  the per-bucket Prisma upserts are replaced by chunked multi-row
//	    INSERT ... ON DUPLICATE KEY UPDATE statements with the same final rows.
package newseventstimeline
