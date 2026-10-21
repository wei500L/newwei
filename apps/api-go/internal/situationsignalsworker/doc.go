// Package situationsignalsworker is the Go implementation of the NestJS
// situation-monitor signals poller.
//
// It replaces apps/api/src/modules/situation-monitor/signals/
// situation-monitor-signals.service.ts (Telegram/OREF polling, the Redis
// caches, the realtime event bridge and the OREF default alert rules) and is
// consumed through the BullMQ queue "situationMonitorSignals" written by
// queue.go/repeatables.go (owned by the queue layer in this package).
//
// # Wiring
//
// The API process builds a Service with New and feeds every queued job to
// HandleJob: source "telegram" runs the Telegram poll, source "oref" runs the
// OREF poll. Run owns the background part of the worker: it subscribes to the
// cross-instance Telegram clear broadcast ("situation-monitor:telegram-clear:v1")
// and clears the local Telegram state when another instance or the settings
// HTTP route broadcasts it. Close releases the MTProto connection.
//
// # B1: Redis is the single source of truth
//
// NestJS keeps Telegram/OREF feed state in process memory and only restores it
// from Redis when that memory is empty. Two NestJS workers (or a worker and a
// restarted process) therefore write stale snapshots over each other. This
// implementation reads the latest cached state from Redis at the start of every
// job, uses it as the only source of truth and writes the refreshed snapshot
// back at the end of the cycle. The in-process struct is a scratch buffer for
// one job, never the authority. Jobs are serialized with a local mutex in
// addition to the queue's concurrency of one.
//
// The Telegram MTProto connection is only created by the process that owns the
// Redis lease (telegramclient.Manager). A process without the lease skips the
// whole cycle without dialing. The OREF cycle takes the Redis lease
// situation-monitor:signals:oref:poll so two processes can never poll the
// upstream endpoint concurrently; a process that loses the race skips the
// cycle. The lock TTL (120s) covers one OREF poll: the HTTP request is capped
// at the configured curl timeout (15s by default) and the history bootstrap
// retries at most max-retries times with sub-second backoff.
//
// # B2 (queue duplicate suppression)
//
// B2 is owned by the queue layer: exactly one repeatable job registration is
// kept per source.
//
// # B3: invalid OREF responses are failures
//
// NestJS parsed a non-JSON body (an HTML error page, a proxy error) into an
// empty alert list and then persisted the empty list, published an empty
// realtime update and skipped the previous alerts. Go treats a non-2xx
// response, an oversized body and an unparseable non-empty body as a failed
// poll: the previous alerts/history/counters are kept, no event is published,
// no alert rule is evaluated and the cached documents are not overwritten.
// The empty body, "[]" and "null" still mean "no active alerts".
//
// # B4: a failed Telegram channel keeps its error
//
// NestJS cleared lastError unconditionally after a poll cycle, hiding the
// channel that failed. Go keeps the last channel error (and the AUTH_KEY /
// FLOOD_WAIT error) when at least one channel failed, the cycle timed out or
// FLOOD_WAIT stopped it early, and only clears it after a fully successful
// cycle. AUTH_KEY_DUPLICATED still permanently disables polling with the fixed
// NestJS message.
//
// # Redis documents
//
// The cache keys, TTLs and JSON shapes are byte-compatible with NestJS:
//
//   - situation-monitor:signals:telegram:state:v1 (24h):
//     {channelSet,cursorByHandle,items,lastPollAt,lastError}
//   - situation-monitor:signals:oref:alerts:v1 (1h):
//     {scope,configured,alerts,historyCount24h,totalHistoryCount,timestamp,error?}
//   - situation-monitor:signals:oref:history:v1 (7d):
//     {scope,configured,history,historyCount24h,totalHistoryCount,timestamp}
//   - situation-monitor:signals:metrics:oref:v1 (7d):
//     {activeAlerts,historyCount24h,updatedAt}
//
// Realtime events are published to situation-monitor:signals:events:v1 as
// {"version":1,"type":<type>,"payload":<payload>,"timestamp":<ISO ms Z>} so the
// NestJS subscribers (and the Go socket layer, if it subscribes) receive the
// same wire format. Payload augmentation (monitor matches, per-user fields) is
// intentionally not done here: it belongs to the socket/gateway layer.
//
// # Environment
//
// NewEnvFromLookup mirrors apps/api/src/modules/config/env.schema.ts for every
// SITUATION_MONITOR_TELEGRAM_*/SITUATION_MONITOR_OREF_* variable this package
// reads. Telegram runtime configuration comes from the effective settings
// (MySQL + environment fallbacks) through SettingsProvider, with the same
// environment fallback NestJS uses when that read fails.
//
// The Telegram channel catalog is a verbatim copy of
// apps/api/src/modules/situation-monitor/signals/telegram-channels.json; a test
// asserts the copy stays byte-identical.
package situationsignalsworker
