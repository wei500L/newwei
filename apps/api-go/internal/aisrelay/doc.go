// Package aisrelay is the Go implementation of apps/ais-relay, the AIS vessel relay that
// ingests the AISStream websocket feed and exposes aggregated maritime snapshots.
//
// It is a contract-equivalent port of the Node program: the same environment variables and
// aliases, the same HTTP routes, status codes and headers, the same JSON member order and
// the same health reason codes. That equivalence is what lets the API switch between the
// two with REALTIME_SIGNALS_AIS_BASE_URL while both versions are deployed in parallel.
//
// Ownership: the package owns the relay's aggregation state and HTTP surface only. Its only
// external dependency is the AISStream websocket; the API consumes the snapshot over HTTP
// and is not imported here.
//
// Layout:
//
//   - config.go         environment contract (names, aliases, defaults, minimums)
//   - jsnum.go          ECMAScript number, string and timestamp semantics
//   - ordered.go        insertion-ordered containers that reproduce JS Map/Set order
//   - classification.go candidate classification and payload value normalisers
//   - engine.go         state, backpressure queue and message folding
//   - aggregate.go      cleanup, disruption detection, density zoning, snapshot assembly
//   - health.go         health rules, diagnostics and the health/liveness payloads
//   - upstream.go       AISStream connection lifecycle, backoff and handshake timeout
//   - http.go           HTTP routes, bearer auth and JSON rendering
//   - json.go           JSON.stringify-compatible serialisation
//   - service.go        wiring, background workers and the ticker
//
// The command that runs it lives in apps/api-go/cmd/ais-relay.
package aisrelay
