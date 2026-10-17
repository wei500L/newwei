package modelaccesssettings

import (
	"strconv"
	"strings"
)

// normalizeHTTPURL reproduces the normalisation the NestJS service applies to a
// non-empty stored baseUrl:
//
//	const parsed = new URL(value);
//	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw ...;
//	return parsed.toString().replace(/\/$/, "");
//
// Go's net/url does not implement the WHATWG URL Standard: it keeps the scheme
// and host case, keeps default ports, does not resolve "." / ".." segments, does
// not treat "\" as a separator for special schemes and does not add the empty
// path "/". Using it directly (or strings.TrimRight) would produce stored values
// NestJS would normalise differently.
//
// The supported subset covers every form the console and the smoke suite send:
// scheme case, missing/extra solidus after the scheme, userinfo, IPv6 hosts,
// percent-encoded hosts, default ports, dot segments, backslash separators,
// spaces in the path, query and fragment. Non-ASCII hosts (IDNA punycode) and
// non-UTF-8 percent-decoding are deliberately out of scope and are documented as
// a known boundary rather than silently guessed.
func normalizeHTTPURL(value string) (string, error) {
	input := trimC0AndSpace(value)
	schemeEnd := strings.IndexByte(input, ':')
	if schemeEnd <= 0 || !isValidScheme(input[:schemeEnd]) {
		return "", errInvalidBaseURL
	}
	scheme := strings.ToLower(input[:schemeEnd])
	if scheme != "http" && scheme != "https" {
		return "", errInvalidBaseURL
	}
	rest := input[schemeEnd+1:]

	// Special schemes skip every leading "/" and "\" after the scheme.
	authorityStart := 0
	for authorityStart < len(rest) && (rest[authorityStart] == '/' || rest[authorityStart] == '\\') {
		authorityStart++
	}
	rest = rest[authorityStart:]

	authorityEnd := len(rest)
	for index := 0; index < len(rest); index++ {
		if rest[index] == '/' || rest[index] == '\\' || rest[index] == '?' || rest[index] == '#' {
			authorityEnd = index
			break
		}
	}
	authority := rest[:authorityEnd]
	remainder := rest[authorityEnd:]
	if authority == "" {
		return "", errInvalidBaseURL
	}

	userinfo := ""
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		userinfo = authority[:at+1]
		authority = authority[at+1:]
	}

	host, port, err := splitAuthorityHostPort(authority)
	if err != nil {
		return "", err
	}
	host = strings.ToLower(percentDecode(host))
	if host == "" {
		return "", errInvalidBaseURL
	}
	if port != "" {
		normalized, ok := normalizePort(port, scheme)
		if !ok {
			return "", errInvalidBaseURL
		}
		port = normalized
	}
	if port != "" {
		port = ":" + port
	}

	pathPart := remainder
	fragment := ""
	query := ""
	hasQuery := false
	hasFragment := false
	if hash := strings.IndexByte(pathPart, '#'); hash >= 0 {
		hasFragment = true
		fragment = pathPart[hash+1:]
		pathPart = pathPart[:hash]
	}
	if mark := strings.IndexByte(pathPart, '?'); mark >= 0 {
		hasQuery = true
		query = pathPart[mark+1:]
		pathPart = pathPart[:mark]
	}

	path := normalizeURLPath(pathPart)

	var builder strings.Builder
	builder.WriteString(scheme)
	builder.WriteString("://")
	builder.WriteString(userinfo)
	builder.WriteString(host)
	builder.WriteString(port)
	builder.WriteString(path)
	if hasQuery {
		builder.WriteString("?")
		builder.WriteString(encodeURLQueryOrFragment(query))
	}
	if hasFragment {
		builder.WriteString("#")
		builder.WriteString(encodeURLQueryOrFragment(fragment))
	}
	result := builder.String()
	// parsed.toString().replace(/\/$/, ""): exactly one trailing slash.
	if strings.HasSuffix(result, "/") {
		result = result[:len(result)-1]
	}
	return result, nil
}

// errInvalidBaseURL is the 400 the service raises for an unusable baseUrl. It is
// read-only: writeServiceError only inspects its status and message.
var errInvalidBaseURL = &httpError{status: 400, message: "baseUrl must be a valid http(s) URL"}

// isValidScheme reports whether value matches [A-Za-z][A-Za-z0-9+.-]*.
func isValidScheme(value string) bool {
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

// trimC0AndSpace strips leading and trailing C0 controls and spaces, which the
// WHATWG URL parser does before parsing.
func trimC0AndSpace(value string) string {
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

// splitAuthorityHostPort splits a WHATWG host into its host and port parts,
// keeping an IPv6 literal bracketed.
func splitAuthorityHostPort(authority string) (string, string, error) {
	if strings.HasPrefix(authority, "[") {
		close := strings.IndexByte(authority, ']')
		if close < 0 {
			return "", "", errInvalidBaseURL
		}
		host := authority[:close+1]
		rest := authority[close+1:]
		if rest == "" {
			return host, "", nil
		}
		if !strings.HasPrefix(rest, ":") {
			return "", "", errInvalidBaseURL
		}
		return host, rest[1:], nil
	}
	if colon := strings.LastIndexByte(authority, ':'); colon >= 0 {
		return authority[:colon], authority[colon+1:], nil
	}
	return authority, "", nil
}

// normalizePort parses a port and drops it when it is the scheme default.
func normalizePort(port, scheme string) (string, bool) {
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
	if (scheme == "http" && value == 80) || (scheme == "https" && value == 443) {
		return "", true
	}
	if value == 0 {
		// ":0" stays ":0" in WHATWG, but it is not a usable endpoint; keeping the
		// literal is still closer than dropping it.
		return "0", true
	}
	return strconv.Itoa(value), true
}

// normalizeURLPath resolves dot segments and percent-encodes the path, always
// returning a path that starts with "/".
func normalizeURLPath(raw string) string {
	path := strings.ReplaceAll(raw, "\\", "/")
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	parts := strings.Split(path[1:], "/")
	out := make([]string, 0, len(parts))
	for index, part := range parts {
		switch part {
		case ".":
			if index == len(parts)-1 {
				out = append(out, "")
			}
		case "..":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if index == len(parts)-1 {
				out = append(out, "")
			}
		default:
			out = append(out, encodeURLPathSegment(part))
		}
	}
	return "/" + strings.Join(out, "/")
}

// encodeURLPathSegment percent-encodes the characters the WHATWG path
// percent-encode set covers. The remaining unreserved/sub-delimiter characters
// are already emitted verbatim by toString().
func encodeURLPathSegment(segment string) string {
	var builder strings.Builder
	for index := 0; index < len(segment); index++ {
		current := segment[index]
		if needsPathEncoding(current) {
			builder.WriteString(percentEncodeByte(current))
			continue
		}
		builder.WriteByte(current)
	}
	return builder.String()
}

// encodeURLQueryOrFragment percent-encodes the characters the WHATWG query and
// fragment percent-encode sets cover.
func encodeURLQueryOrFragment(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		current := value[index]
		if needsQueryEncoding(current) {
			builder.WriteString(percentEncodeByte(current))
			continue
		}
		builder.WriteByte(current)
	}
	return builder.String()
}

// needsPathEncoding reports whether b is in the path percent-encode set.
func needsPathEncoding(b byte) bool {
	if b <= 0x20 || b == 0x7f {
		return true
	}
	switch b {
	case '"', '#', '<', '>', '?', '`', '{', '}':
		return true
	default:
		return false
	}
}

// needsQueryEncoding reports whether b is in the query/fragment percent-encode
// set (the query set is the C0 control set plus space, '"', '#', '<', '>').
func needsQueryEncoding(b byte) bool {
	if b <= 0x20 || b == 0x7f {
		return true
	}
	switch b {
	case '"', '#', '<', '>':
		return true
	default:
		return false
	}
}

// percentEncodeByte renders one byte as %XX with uppercase hex digits, which is
// what the WHATWG serializer emits.
func percentEncodeByte(b byte) string {
	const digits = "0123456789ABCDEF"
	return string([]byte{'%', digits[b>>4], digits[b&0x0f]})
}

// percentDecode decodes %XX sequences; an invalid sequence is left verbatim,
// matching the URL parser's behaviour for hosts.
func percentDecode(value string) string {
	if !strings.ContainsRune(value, '%') {
		return value
	}
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] == '%' && index+2 < len(value) {
			high, highOK := hexDigit(value[index+1])
			low, lowOK := hexDigit(value[index+2])
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

// hexDigit decodes one ASCII hex digit.
func hexDigit(b byte) (byte, bool) {
	switch {
	case b >= '0' && b <= '9':
		return b - '0', true
	case b >= 'a' && b <= 'f':
		return b - 'a' + 10, true
	case b >= 'A' && b <= 'F':
		return b - 'A' + 10, true
	default:
		return 0, false
	}
}
