// Package newsnowhottest owns the two NewsNow "hot" reading surfaces:
// GET /api/news-aggregator/hottest-analysis and
// GET /api/news-aggregator/recommended, plus the two background owners that keep
// their caches warm:
//
//   - NewsnowHottestAnalysisScheduler: every ten minutes claim the shared tick
//     gate, build one global hottest snapshot, then refresh every active
//     organization's projection under its own lock;
//   - NewsnowSourceWarmScheduler: every minute take the shared warm lock and
//     fetch the active sources with concurrency six.
//
// Both HTTP entries are permission-guarded by items.read; the analysis endpoint
// auto-imports eligible hot signals into ItemMeta only when the caller also
// holds items.write.
//
// Compatibility contract with the NestJS implementation
// (apps/api/src/modules/news-aggregator/newsnow-*.ts):
//
//   - Redis keys and TTLs are byte-identical: the organization analysis
//     fresh/stale pair, the global snapshot fresh/stale pair, the signature, the
//     per-organization signal state and every `lock:` prefixed lease. JSON
//     documents keep the NestJS property order and omission rules so either
//     process can read what the other wrote.
//   - The global input signature (sha1 over the normalized fetch payload) and
//     the per-signal keys are computed with the same inputs, order and hash
//     algorithm. A different order would make the two sides invalidate each
//     other's snapshot on every request.
//   - The organization projection matches candidate URLs only against ItemMeta
//     rows of that organization. This intentionally differs from the public
//     /resolve endpoint, which keeps its global semantics; see match.go.
package newsnowhottest
