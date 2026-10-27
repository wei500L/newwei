package aisrelay

import (
	"crypto/subtle"
	"net/http"
	"strconv"
	"strings"
)

// HTTP surface of the relay.
//
// The routes, status codes, header set and method handling match the Node server,
// including the details a client can observe: OPTIONS is answered with 204 and only
// the CORS method/header allow-lists (no origin header), /health is always 200 with the
// verdict in the body, and /ais/snapshot answers 401 unless a configured secret matches
// the bearer token.

// jsonContentType matches the Node relay's Content-Type header byte for byte.
const jsonContentType = "application/json; charset=utf-8"

// bearerPrefix is the seven-character scheme prefix the Node relay slices off.
const bearerPrefix = "bearer "

// ServeHTTP implements the relay endpoints.
func (r *Relay) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	// The Node relay matches on new URL(req.url).pathname, which keeps percent-encoding
	// intact, so the comparison uses EscapedPath rather than the decoded path.
	path := request.URL.EscapedPath()

	if request.Method == http.MethodOptions {
		header := writer.Header()
		header.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		header.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		writer.WriteHeader(http.StatusNoContent)
		return
	}

	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", "GET, OPTIONS")
		writeJSON(writer, http.StatusMethodNotAllowed, errorPayload{Error: "Method Not Allowed"})
		return
	}

	switch path {
	case "/", "/health":
		// Always 200: a container probe on this path must not restart a relay that is
		// reachable but whose upstream stream is down. The verdict is in the body.
		writeJSON(writer, http.StatusOK, r.engine.healthPayload())
	case "/healthz/live":
		writeJSON(writer, http.StatusOK, r.engine.livenessPayload())
	case "/ais/snapshot":
		if !r.authorized(request) {
			writeJSON(writer, http.StatusUnauthorized, errorPayload{Error: "Unauthorized"})
			return
		}
		// A snapshot request also pulls the upstream retry forward, which is what the
		// Node handler does by calling connectUpstream() on this path.
		r.upstream.wakeNow()

		body := r.engine.snapshotBytes(request.URL.Query().Get("candidates") == "true")
		writer.Header().Set("Content-Type", jsonContentType)
		// The snapshot carries auth-relevant data, so it must never enter a shared
		// cache; max-age mirrors the snapshot cadence.
		writer.Header().Set("Cache-Control", "private, max-age="+strconv.Itoa(r.snapshotMaxAgeSeconds()))
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(body)
	default:
		writeJSON(writer, http.StatusNotFound, errorPayload{Error: "Not Found"})
	}
}

// snapshotMaxAgeSeconds is `Math.max(1, Math.floor(SNAPSHOT_CACHE_TTL_MS / 1000))`.
func (r *Relay) snapshotMaxAgeSeconds() int {
	seconds := int(r.cfg.SnapshotCacheTTL.Milliseconds() / 1000)
	if seconds < 1 {
		return 1
	}
	return seconds
}

// authorized reproduces isAuthorizedRequest: an unconfigured secret disables auth
// entirely, otherwise a non-empty bearer token must match the configured secret.
func (r *Relay) authorized(request *http.Request) bool {
	if r.cfg.SharedSecret == "" {
		return true
	}
	token := bearerToken(request.Header.Get("Authorization"))
	return token != "" && tokenEquals(token, r.cfg.SharedSecret)
}

// bearerToken reproduces getBearerToken: the scheme comparison is case insensitive and
// the token is JS-trimmed after the prefix.
func bearerToken(authorization string) string {
	if authorization == "" {
		return ""
	}
	if !strings.HasPrefix(strings.ToLower(authorization), bearerPrefix) {
		return ""
	}
	return jsTrim(authorization[len(bearerPrefix):])
}

// tokenEquals reproduces tokenEquals: a length check followed by a constant-time
// comparison, so a wrong secret cannot be recovered from response timing.
func tokenEquals(provided string, expected string) bool {
	left := []byte(provided)
	right := []byte(expected)
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare(left, right) == 1
}

// writeJSON writes a JSON response using the relay's content type.
func writeJSON(writer http.ResponseWriter, statusCode int, payload any) {
	body, err := encodeJSJSON(payload)
	if err != nil {
		// Unreachable for the relay's own payload types.
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", jsonContentType)
	writer.WriteHeader(statusCode)
	_, _ = writer.Write(body)
}

// snapshotBytes returns the cached serialised snapshot in the requested candidate
// variant, rebuilding it when the cache is cold or older than half the TTL.
func (e *engine) snapshotBytes(includeCandidates bool) []byte {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.buildSnapshotLocked()
	if includeCandidates {
		return e.lastSnapshotJSONWithCandidates
	}
	return e.lastSnapshotJSONWithoutCandidates
}
