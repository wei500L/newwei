// Package exceptioningest migrates the two exception-report POST endpoints to
// Go behind API_GO_EXCEPTION_INGEST_MODE:
//
//	POST /api/observability/exception-events/client
//	POST /api/internal/observability/exception-events
//
// The client endpoint keeps the @AllowAuthenticated contract (any authenticated
// user; orgId/userId always come from the server-side identity and the client
// body cannot override them). The internal endpoint keeps the
// LitellmInternalTokenGuard contract and is the only writer allowed to supply
// orgId/userId. Both endpoints normalize the payload into a named,
// strongly-typed report and write one document into the existing
// "exceptionevents" Mongo collection; the response stays the legacy best-effort
// {"ok":true} with HTTP 201 even when the single insert attempt fails.
package exceptioningest
