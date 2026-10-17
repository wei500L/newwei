package exceptioningest

import (
	"crypto/subtle"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// authorizeInternal mirrors LitellmInternalTokenGuard in the same order:
//
//  1. the configured token is missing -> 403
//     "LITELLM_CONFIG_INTERNAL_TOKEN is not configured";
//  2. no extractable bearer -> 401 "Missing bearer token";
//  3. the token does not match -> 401 "Invalid bearer token".
//
// A missing configuration is an endpoint contract and never blocks startup. The
// comparison is constant time and the expected value is used raw, exactly like
// the model-access-settings internal routes.
func (s *Service) authorizeInternal(w http.ResponseWriter, r *http.Request) bool {
	expected := s.internalToken
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
		log.Printf("exceptioningest: rejected request with invalid internal bearer token")
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
// The JavaScript whitespace class and the JavaScript `.` semantics (which does
// not match \n, \r, U+2028 or U+2029) are reproduced explicitly.
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
		r, size := utf8.DecodeRuneInString(rest[whitespace:])
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

// constantTimeTokenEqual compares two secrets without leaking their contents.
// The length check mirrors tokensEqual (byte length first).
func constantTimeTokenEqual(provided, expected string) bool {
	if len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

// jsTrimSpace trims exactly the code points JavaScript's String.prototype.trim
// covers (ECMAScript \s), which is a superset of Go's unicode.IsSpace.
func jsTrimSpace(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

// isJSWhitespace reports whether r is a JavaScript WhiteSpace or LineTerminator
// code point.
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// containsJSLineTerminator reports whether the text holds a JavaScript line
// terminator.
func containsJSLineTerminator(text string) bool {
	for _, r := range text {
		switch r {
		case '\n', '\r', '\u2028', '\u2029':
			return true
		}
	}
	return false
}

// equalFoldASCII compares two ASCII strings case-insensitively.
func equalFoldASCII(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := 0; index < len(left); index++ {
		a := left[index]
		b := right[index]
		if a >= 'A' && a <= 'Z' {
			a += 'a' - 'A'
		}
		if b >= 'A' && b <= 'Z' {
			b += 'a' - 'A'
		}
		if a != b {
			return false
		}
	}
	return true
}
