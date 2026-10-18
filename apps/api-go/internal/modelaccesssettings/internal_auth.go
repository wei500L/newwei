package modelaccesssettings

import (
	"crypto/subtle"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// internalRoute splits the two LiteLLM internal endpoints away from the human
// JWT/machine-token routes before any identity work happens: a JWT or an mtk_
// token must NOT be interpreted as an internal caller, and the internal bearer
// token must not be interpreted as a user.
type internalRoute int

const (
	// internalRouteNone is not an internal endpoint.
	internalRouteNone internalRoute = iota
	// internalRouteGetKeys is GET /api/internal/litellm/openai-keys.
	internalRouteGetKeys
	// internalRouteReportApplied is POST /api/internal/litellm/openai-keys/applied.
	internalRouteReportApplied
	// internalRouteProxyLoadBalancing is
	// GET /api/internal/litellm/proxy-load-balancing.
	internalRouteProxyLoadBalancing
)

// internalRouteForPath classifies the internal paths by exact equality, so a
// neighbouring route can never be captured.
func internalRouteForPath(path string) internalRoute {
	switch path {
	case pathInternalOpenAiKeys:
		return internalRouteGetKeys
	case pathInternalOpenAiKeysApplied:
		return internalRouteReportApplied
	case pathInternalProxyLoadBalancing:
		return internalRouteProxyLoadBalancing
	default:
		return internalRouteNone
	}
}

// authorizeInternal implements the LiteLLM internal token guard, in the same order
// as LitellmInternalTokenGuard:
//
//  1. the configured token is missing -> 403
//     "LITELLM_CONFIG_INTERNAL_TOKEN is not configured";
//  2. no extractable bearer -> 401 "Missing bearer token";
//  3. the token does not match -> 401 "Invalid bearer token".
//
// The missing configuration is an ENDPOINT contract and never blocks startup.
// The comparison is constant time and the expected value is used raw (the NestJS
// env schema only rejects an all-whitespace value; it never trims the accepted
// one).
func (s *Service) authorizeInternal(w http.ResponseWriter, r *http.Request) bool {
	expected := s.cfg.LiteLLMConfigInternalToken
	if jsTrimSpace(expected) == "" {
		authhttp.WriteHTTPException(w, r, http.StatusForbidden, "LITELLM_CONFIG_INTERNAL_TOKEN is not configured")
		return false
	}
	token, ok := extractBearerToken(r.Header.Get("Authorization"))
	if !ok {
		authhttp.WriteUnauthorized(w, r, "Missing bearer token")
		return false
	}
	if !constantTimeTokenEqual(token, expected) {
		log.Printf("modelaccesssettings: rejected request with invalid internal bearer token")
		authhttp.WriteUnauthorized(w, r, "Invalid bearer token")
		return false
	}
	return true
}

// extractBearerToken mirrors apps/api/src/common/internal-token.ts
// extractBearerToken exactly:
//
//	trim the whole header; match /^bearer\s+(.+)$/i; trim the capture.
//
// The JavaScript whitespace class and the JavaScript `.` semantics (which does not
// match \n, \r, U+2028 or U+2029) are reproduced explicitly instead of relying on
// Go's narrower \s and wider dot.
func extractBearerToken(header string) (string, bool) {
	trimmed := jsTrimSpace(header)
	if trimmed == "" {
		return "", false
	}
	const keyword = "bearer"
	if len(trimmed) < len(keyword) || !equalFoldASCII(trimmed[:len(keyword)], keyword) {
		return "", false
	}
	rest := trimmed[len(keyword):]
	whitespace := 0
	for whitespace < len(rest) {
		r, size := decodeRune(rest[whitespace:])
		if !isJSWhitespace(r) {
			break
		}
		whitespace += size
	}
	if whitespace == 0 {
		// "bearer" must be followed by at least one whitespace character.
		return "", false
	}
	capture := rest[whitespace:]
	if capture == "" || containsJSLineTerminator(capture) {
		// `(.+)` needs at least one character and `.` cannot cross a line
		// terminator, and `$` anchors at the end of the input.
		return "", false
	}
	token := jsTrimSpace(capture)
	if token == "" {
		return "", false
	}
	return token, true
}

// constantTimeTokenEqual compares two secrets without leaking their contents
// through timing. The length check mirrors tokensEqual (byte length first), and the
// actual comparison is constant time.
func constantTimeTokenEqual(provided, expected string) bool {
	if len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
