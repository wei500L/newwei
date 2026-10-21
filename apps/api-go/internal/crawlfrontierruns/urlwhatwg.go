package crawlfrontierruns

// This file reproduces the URL normalisation the NestJS create-run path applies
// to seedUrl:
//
//	const seedUrl = this.normalizeUrl(input.seedUrl);   // crawl-frontier.service.ts:5153
//	private normalizeUrl(value: string) {
//	  try { return new URL(value).toString(); }
//	  catch { throw new BadRequestException("seedUrl must be a valid absolute URL"); }
//	}
//
// `new URL(value).toString()` is the WHATWG URL serialisation, not
// net/url.String(): the hostname is lower-cased and IDNA-punycoded, an empty
// path becomes "/", the scheme's default port disappears, "." / ".." segments
// resolve, "\" acts as a separator for special schemes, and the WHATWG
// percent-encode sets are applied to the path, query and fragment.
//
// The value that reaches this function has already passed the DTO's
// @IsUrl({require_tld:false, require_protocol:true}) check (see
// crawlprofile.IsURLValid), and validator.js isURL only accepts the http, https
// and ftp protocols, so those are the three schemes implemented here. Every
// other input is reported as not normalisable and becomes the same 400 message
// NestJS throws from the catch branch.
//
// Deliberate boundaries, all unreachable from the HTTP DTO and documented
// rather than guessed:
//   - a value containing any JavaScript whitespace or "<"/">" is rejected by
//     isURL before normalisation, so C0/space trimming here is only a guard;
//   - userinfo is serialised verbatim instead of being re-encoded, because
//     isURL restricts it to [a-zA-Z0-9\-_.%:] which WHATWG leaves unchanged;
//   - IPv6 literals keep their bracketed form and are lower-cased, matching
//     WHATWG's IPv6 serialiser for already-canonical input.

import (
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// seedURLSchemePorts maps the special schemes isURL accepts to their default
// port. A port equal to the default is dropped by URL serialisation.
var seedURLSchemePorts = map[string]string{
	"http":  "80",
	"https": "443",
	"ftp":   "21",
}

// normalizeSeedURL returns new URL(value).toString() and false when the WHATWG
// parser would throw. The result always has a scheme, an authority and an
// absolute path.
func normalizeSeedURL(value string) (string, bool) {
	input := trimURLControlSpace(value)
	schemeEnd := strings.IndexByte(input, ':')
	if schemeEnd <= 0 || !isURLSchemeText(input[:schemeEnd]) {
		return "", false
	}
	scheme := strings.ToLower(input[:schemeEnd])
	defaultPort, special := seedURLSchemePorts[scheme]
	if !special {
		return "", false
	}

	rest := input[schemeEnd+1:]
	// Special URLs skip every leading solidus and reverse solidus after the
	// scheme, so "https:example.com" and "https:///example.com" both parse.
	leading := 0
	for leading < len(rest) && (rest[leading] == '/' || rest[leading] == '\\') {
		leading++
	}
	rest = rest[leading:]

	authorityEnd := len(rest)
	for index := 0; index < len(rest); index++ {
		current := rest[index]
		if current == '/' || current == '\\' || current == '?' || current == '#' {
			authorityEnd = index
			break
		}
	}
	authority := rest[:authorityEnd]
	remainder := rest[authorityEnd:]
	if authority == "" {
		return "", false
	}

	userinfo := ""
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		userinfo = authority[:at+1]
		authority = authority[at+1:]
	}
	host, port, ok := splitSeedURLAuthority(authority)
	if !ok {
		return "", false
	}
	// Serialisation writes the parsed numeric port, so "0080" becomes "80" and
	// the scheme default disappears entirely.
	if port == defaultPort {
		port = ""
	}
	if port != "" {
		port = ":" + port
	}

	path, query, fragment, hasQuery, hasFragment := splitSeedURLRemainder(remainder)

	var builder strings.Builder
	builder.WriteString(scheme)
	builder.WriteString("://")
	builder.WriteString(userinfo)
	builder.WriteString(host)
	builder.WriteString(port)
	builder.WriteString(normalizeSeedURLPath(path))
	if hasQuery {
		builder.WriteByte('?')
		builder.WriteString(encodeSeedURLQuery(query, true))
	}
	if hasFragment {
		builder.WriteByte('#')
		builder.WriteString(encodeSeedURLQuery(fragment, false))
	}
	return builder.String(), true
}

// trimURLControlSpace strips the leading and trailing C0 controls and spaces the
// WHATWG parser removes before parsing.
func trimURLControlSpace(value string) string {
	start := 0
	end := len(value)
	for start < end && value[start] <= 0x20 {
		start++
	}
	for end > start && value[end-1] <= 0x20 {
		end--
	}
	return value[start:end]
}

// isURLSchemeText reports whether value matches [A-Za-z][A-Za-z0-9+.-]*.
func isURLSchemeText(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		current := value[index]
		switch {
		case current >= 'a' && current <= 'z':
		case current >= 'A' && current <= 'Z':
		case current >= '0' && current <= '9' && index > 0:
		case (current == '+' || current == '-' || current == '.') && index > 0:
		default:
			return false
		}
	}
	return true
}

// splitSeedURLAuthority lower-cases and punycodes the host and canonicalises the
// port. A port that is not a run of decimal digits, or exceeds 65535, makes the
// WHATWG parser fail.
func splitSeedURLAuthority(authority string) (string, string, bool) {
	host := authority
	port := ""
	if strings.HasPrefix(authority, "[") {
		close := strings.IndexByte(authority, ']')
		if close < 0 {
			return "", "", false
		}
		host = authority[:close+1]
		rest := authority[close+1:]
		if rest != "" {
			if !strings.HasPrefix(rest, ":") {
				return "", "", false
			}
			port = rest[1:]
		}
		// An IPv6 literal is already ASCII; it is lower-cased like WHATWG's
		// IPv6 serialiser does and never goes through IDNA.
		return strings.ToLower(host), canonicalSeedURLPort(port), true
	}
	if colon := strings.LastIndexByte(authority, ':'); colon >= 0 {
		host = authority[:colon]
		port = authority[colon+1:]
	}
	host = strings.ToLower(percentDecodeSeedURLHost(host))
	if host == "" {
		return "", "", false
	}
	// WHATWG runs "domain to ASCII", which maps a non-ASCII host through UTS46
	// and makes the whole URL invalid when the host cannot be converted. The
	// repository already normalises all other URL hosts with idna.Lookup, so the
	// same profile is used here to keep host spellings consistent.
	ascii, err := idna.Lookup.ToASCII(host)
	if err != nil || ascii == "" {
		return "", "", false
	}
	host = ascii
	canonical, ok := canonicalSeedURLPortChecked(port)
	if !ok {
		return "", "", false
	}
	return host, canonical, true
}

// canonicalSeedURLPort is the unchecked form used for a bracketed IPv6 literal,
// where the port syntax has already been separated by the caller.
func canonicalSeedURLPort(port string) string {
	canonical, _ := canonicalSeedURLPortChecked(port)
	return canonical
}

// canonicalSeedURLPortChecked accepts an empty port or a decimal port up to
// 65535 and returns it without leading zeros, which is what serialisation
// writes.
func canonicalSeedURLPortChecked(port string) (string, bool) {
	if port == "" {
		return "", true
	}
	value := 0
	for index := 0; index < len(port); index++ {
		current := port[index]
		if current < '0' || current > '9' {
			return "", false
		}
		value = value*10 + int(current-'0')
		if value > 65535 {
			return "", false
		}
	}
	return strconv.Itoa(value), true
}

// percentDecodeSeedURLHost decodes %XX sequences in a host, leaving an invalid
// sequence verbatim, which is the URL parser's behaviour before IDNA.
func percentDecodeSeedURLHost(value string) string {
	if !strings.ContainsRune(value, '%') {
		return value
	}
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] == '%' && index+2 < len(value) {
			high, highOK := seedURLHexDigit(value[index+1])
			low, lowOK := seedURLHexDigit(value[index+2])
			if highOK && lowOK {
				builder.WriteByte(high<<4 | low)
				index += 2
				continue
			}
		}
		builder.WriteByte(value[index])
	}
	return builder.String()
}

// seedURLHexDigit decodes one ASCII hex digit.
func seedURLHexDigit(value byte) (byte, bool) {
	switch {
	case value >= '0' && value <= '9':
		return value - '0', true
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10, true
	case value >= 'A' && value <= 'F':
		return value - 'A' + 10, true
	default:
		return 0, false
	}
}

// splitSeedURLRemainder separates the path from the query and fragment. The
// WHATWG parser splits the fragment first, then the query.
func splitSeedURLRemainder(remainder string) (path, query, fragment string, hasQuery, hasFragment bool) {
	path = remainder
	if hash := strings.IndexByte(path, '#'); hash >= 0 {
		hasFragment = true
		fragment = path[hash+1:]
		path = path[:hash]
	}
	if mark := strings.IndexByte(path, '?'); mark >= 0 {
		hasQuery = true
		query = path[mark+1:]
		path = path[:mark]
	}
	return path, query, fragment, hasQuery, hasFragment
}

// normalizeSeedURLPath resolves "." / ".." segments, treats "\" as a separator
// and percent-encodes the path percent-encode set. A special URL always
// serialises with at least "/".
func normalizeSeedURLPath(raw string) string {
	path := strings.ReplaceAll(raw, "\\", "/")
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	segments := strings.Split(path[1:], "/")
	out := make([]string, 0, len(segments))
	for index, segment := range segments {
		switch segment {
		case ".":
			// A trailing "." leaves the empty final segment behind, so
			// "/a/." serialises as "/a/".
			if index == len(segments)-1 {
				out = append(out, "")
			}
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if index == len(segments)-1 {
				out = append(out, "")
			}
		default:
			out = append(out, encodeSeedURLPathSegment(segment))
		}
	}
	return "/" + strings.Join(out, "/")
}

// encodeSeedURLPathSegment percent-encodes one path segment. WHATWG's path
// percent-encode set is the query set plus "?", "`", "{" and "}".
func encodeSeedURLPathSegment(segment string) string {
	var builder strings.Builder
	for index := 0; index < len(segment); index++ {
		current := segment[index]
		if needsSeedURLPathEncoding(current) {
			builder.WriteString(percentEncodeSeedURLByte(current))
			continue
		}
		builder.WriteByte(current)
	}
	return builder.String()
}

// encodeSeedURLQuery percent-encodes a query or fragment. For a special scheme
// the query uses the special-query set, which adds "'"; the fragment uses the
// plain fragment set.
func encodeSeedURLQuery(value string, specialQuery bool) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		current := value[index]
		if needsSeedURLQueryEncoding(current) || (specialQuery && current == '\'') {
			builder.WriteString(percentEncodeSeedURLByte(current))
			continue
		}
		builder.WriteByte(current)
	}
	return builder.String()
}

// needsSeedURLPathEncoding reports whether b is in the path percent-encode set.
// Both the C0 control set and the query set include every code point above
// 0x7E, so non-ASCII UTF-8 bytes are percent-encoded one byte at a time exactly
// like the WHATWG serialiser.
func needsSeedURLPathEncoding(b byte) bool {
	if b <= 0x20 || b >= 0x7f {
		return true
	}
	switch b {
	case '"', '#', '<', '>', '?', '`', '{', '}':
		return true
	default:
		return false
	}
}

// needsSeedURLQueryEncoding reports whether b is in the query percent-encode set
// (the C0 control set plus space, '"', "#", "<" and ">").
func needsSeedURLQueryEncoding(b byte) bool {
	if b <= 0x20 || b >= 0x7f {
		return true
	}
	switch b {
	case '"', '#', '<', '>':
		return true
	default:
		return false
	}
}

// percentEncodeSeedURLByte renders one byte as %XX with upper-case hex digits.
func percentEncodeSeedURLByte(b byte) string {
	const digits = "0123456789ABCDEF"
	return string([]byte{'%', digits[b>>4], digits[b&0x0f]})
}
