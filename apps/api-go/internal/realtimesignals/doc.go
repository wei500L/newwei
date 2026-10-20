// Package realtimesignals owns the realtime signal collection cron
// (RealtimeSignalsService.refreshScheduled) when
// API_GO_REALTIME_SIGNALS_MODE=go.
//
// It replaces the NestJS @Cron path one-for-one: the same Redis keys and JSON
// documents, the same external request shapes, the same OpenSky credit ledger,
// the same insight snapshot and the same Mongo transport documents. NestJS keeps
// serving the diagnostics, viewport and settings HTTP surfaces; this package only
// collects.
//
// Execution ownership is all-or-nothing. The eight sources feed one insight
// snapshot, so a deployment must not let Go and NestJS split the source set. Both
// sides claim the same tick gate and organization leases, therefore only one
// process collects in an interval even during a rolling switch.
//
// Two deliberate behavior changes are implemented here and documented in the pull
// request:
//
//   - B1: the OpenSky military region batch is fetched once per round and shared
//     by every organization, so concurrent organizations cannot reserve the same
//     daily credits more than once. The NestJS path reserves once per
//     organization and relies on cache.wrap to deduplicate only the HTTP call.
//   - O1: the AIS relay snapshot and the Polymarket event list are global
//     responses, so they are fetched once per round and reused by every
//     organization. The per-organization snapshot write, transport write,
//     prediction comparison and price cache stay per organization.
package realtimesignals
