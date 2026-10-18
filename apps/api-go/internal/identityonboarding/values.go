package identityonboarding

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// jsTrim mirrors String.prototype.trim: ASCII whitespace plus the Unicode space
// separators and the zero-width no-break space.
func jsTrim(value string) string {
	return strings.TrimFunc(value, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	default:
		return r >= '\u2000' && r <= '\u200a'
	}
}

// jsLength mirrors the validator.js isLength count used by class-validator:
// str.length minus one per surrogate pair, which is the code point count.
func jsLength(value string) int {
	return len([]rune(value))
}

// nowMillis returns the millisecond-truncated UTC time Prisma stores.
func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// newRowID writes a Prisma cuid column. MySQL has no client-side default, so the
// id must be supplied explicitly; the shape matches the existing Go batches
// (c followed by 24 hexadecimal digits).
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// inviteTokenBytes is the 32-byte random token generateOpaqueToken uses.
const inviteTokenBytes = 32

// newInviteToken returns the raw token (never stored) and its SHA-256 hex hash
// (the only form the database keeps).
func newInviteToken() (string, string, error) {
	buffer := make([]byte, inviteTokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", "", err
	}
	raw := hex.EncodeToString(buffer)
	return raw, hashOpaqueToken(raw), nil
}

// hashOpaqueToken mirrors hashOpaqueToken in auth-flow.utils.ts.
func hashOpaqueToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// normalizeEmailAddress mirrors normalizeEmailAddress: trim then lowercase.
func normalizeEmailAddress(email string) string {
	return strings.ToLower(jsTrim(email))
}

// sortedUniqueStrings keeps the first occurrence order and drops duplicates.
func sortedUniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// nullableString converts an optional string to its driver value.
func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// stringPtr returns a pointer to a copy of value.
func stringPtr(value string) *string {
	return &value
}

// readRequestBody reads a JSON body with a hard size limit.
func readRequestBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalidJSON
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return data, bodyInvalidJSON
	}
	return data, bodyOK
}

// isJSONContentType reports whether the header selects the JSON body parser.
func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return media == "application/json"
}

// ---- validator.js isEmail port ----

// The following mirrors validator.js isEmail with the default options
// (require_tld=true, allow_utf8_local_part=true, allow_ip_domain=false,
// allow_display_name=false, ignore_max_length=false, domain_specific_validation
// =false). It is duplicated here because each migration unit owns its contract
// copy; the DTO must reject exactly the addresses class-validator rejects.
var (
	quotedEmailUserRe = regexp.MustCompile("(?i)^([\\s\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\x21-\\x5b\\x5d-\\x7e\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]|(\\\\[\\x01-\\x09\\x0b\\x0c\\x0d-\\x7f\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]))*$")
	emailUserUTF8Part = regexp.MustCompile("(?i)^[a-z\\d!#$%&'*+\\-/=?^_`{|}~\\x{00A1}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]+$")
	fqdnTLDRe         = regexp.MustCompile("(?i)^([a-z\\x{00A1}-\\x{00A8}\\x{00AA}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]{2,}|xn[a-z0-9-]{2,})$")
	fqdnPartRe        = regexp.MustCompile("(?i)^[a-z_\\x{00A1}-\\x{FFFF}0-9-]+$")
	fullWidthRe       = regexp.MustCompile("[\\x{FF01}-\\x{FF5E}]")
)

func validatorIsEmail(value string) bool {
	if len(value) > 254 {
		return false
	}
	at := strings.LastIndex(value, "@")
	if at < 0 {
		return validatorIsFQDN(value)
	}
	user := value[:at]
	domain := value[at+1:]
	if len(user) == 0 || len(user) > 64 {
		return false
	}
	if len(domain) == 0 || len(domain) > 254 {
		return false
	}
	if !validatorIsFQDN(domain) {
		return false
	}
	if strings.HasPrefix(user, `"`) && strings.HasSuffix(user, `"`) && len(user) >= 2 {
		return quotedEmailUserRe.MatchString(user[1 : len(user)-1])
	}
	for _, part := range strings.Split(user, ".") {
		if part == "" || !emailUserUTF8Part.MatchString(part) {
			return false
		}
	}
	return true
}

// validatorIsFQDN mirrors validator.js isFQDN with require_tld=true,
// allow_underscores=false, allow_numeric_tld=false, allow_trailing_dot=false.
func validatorIsFQDN(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	tld := parts[len(parts)-1]
	if !fqdnTLDRe.MatchString(tld) {
		return false
	}
	if strings.ContainsAny(tld, " \t\n\r\f\v") {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > 63 {
			return false
		}
		if !fqdnPartRe.MatchString(part) {
			return false
		}
		if fullWidthRe.MatchString(part) {
			return false
		}
		if strings.HasPrefix(part, "-") || strings.HasSuffix(part, "-") {
			return false
		}
		if strings.Contains(part, "_") {
			return false
		}
	}
	return true
}
