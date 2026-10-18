// Package situationsignals implements the Strangler Fig takeover of the seven
// situation monitor signal read and feedback HTTP routes:
//
//	GET  /api/situation-monitor/catalog                 (items.read)
//	POST /api/situation-monitor/feedback                (items.write, 201)
//	GET  /api/situation-monitor/refresh-runs/:refreshId (items.read, 200/404)
//	GET  /api/situation-monitor/telegram-feed           (items.read)
//	GET  /api/situation-monitor/oref-alerts             (items.read)
//	GET  /api/situation-monitor/oref-history            (items.read)
//	GET  /api/situation-monitor/live-hls-proxy-config   (items.read)
//
// The switch is API_GO_SITUATION_MONITOR_SIGNALS_MODE (legacy|go, empty means
// legacy). Rollback only flips that one variable: no data is migrated, the
// NestJS implementation stays in place, and the gateway routes the seven paths
// back to NestJS.
//
// Identity is derived in Go exactly like the other migrated domains: HS256
// signature verification, the Redis revocation list (fail-closed) and the
// MySQL membership/permission re-derivation; mtk_ machine tokens are resolved
// through a SHA-256 lookup against MachineAccessToken (revoked / expired /
// inactive Org rejected, lastUsedAt refreshed). JWT permission claims are never
// read.
//
// Data sources are read-only projections of state that NestJS schedulers and
// services own:
//   - MySQL: NewsSource counts, CrawlTask/PipelineJob counts, SystemSetting and
//     the caller's SituationMonitorMonitor rows.
//   - Redis: the cached Telegram state, the two cached OREF documents, the
//     refresh-run record and the situation_monitor_settings envelope.
//   - Mongo: the feedback insert and the learning-state upsert.
//
// No Telegram or OREF upstream request is ever made from here, no queue job is
// enqueued, and no worker is started. Insights, POST /refresh,
// /monitors** (its own switch) and /api/system-settings/realtime-signals/runtime
// keep falling back to NestJS.
package situationsignals
