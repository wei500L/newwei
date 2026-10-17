package llmgatewayprofiles

import (
	"regexp"
	"strconv"
	"strings"
)

// This file reproduces validator.js isURL with the fixed option set of the
// LLM gateway DTO: @IsUrl({ require_protocol: true, require_tld: false }). Every
// other option keeps the library default (protocols http/https/ftp,
// require_host, require_valid_protocol, allow_fragments, allow_query_components,
// validate_length with max 2084). The port mirrors
// internal/crawlprofile/validate.go, which was verified line by line against
// validator.js 13.15.23; the helper cannot be imported because that package is
// not shared and must not be modified by this batch.

var urlProtocolPattern = regexp.MustCompile(`(?i)^([a-z][a-z0-9+\-.]*):`)
var urlValidAuthPattern = regexp.MustCompile(`^[a-zA-Z0-9\-_.%:]*$`)
var urlWrappedIPv6Pattern = regexp.MustCompile(`^\[([^\]]+)\](?::([0-9]+))?$`)
var urlIPv4Segment = `(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])`
var urlIPv4Address = `(?:` + urlIPv4Segment + `\.){3}` + urlIPv4Segment
var urlIPv6Segment = `(?:[0-9a-fA-F]{1,4})`
var urlIPv4Pattern = regexp.MustCompile(`^` + urlIPv4Address + `$`)
var urlIPv6Pattern = regexp.MustCompile(`^(` +
	`(?:` + urlIPv6Segment + `:){7}(?:` + urlIPv6Segment + `|:)|` +
	`(?:` + urlIPv6Segment + `:){6}(?:` + urlIPv4Address + `|:` + urlIPv6Segment + `|:)|` +
	`(?:` + urlIPv6Segment + `:){5}(?::` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,2}|:)|` +
	`(?:` + urlIPv6Segment + `:){4}(?:(:` + urlIPv6Segment + `){0,1}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,3}|:)|` +
	`(?:` + urlIPv6Segment + `:){3}(?:(:` + urlIPv6Segment + `){0,2}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,4}|:)|` +
	`(?:` + urlIPv6Segment + `:){2}(?:(:` + urlIPv6Segment + `){0,3}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,5}|:)|` +
	`(?:` + urlIPv6Segment + `:){1}(?:(:` + urlIPv6Segment + `){0,4}:` + urlIPv4Address + `|(:` + urlIPv6Segment + `){1,6}|:)|` +
	`(?::((?::` + urlIPv6Segment + `){0,5}:` + urlIPv4Address + `|(?::` + urlIPv6Segment + `){1,7}|:))` +
	`)(%[0-9a-zA-Z.]{1,})?$`)

// urlWhitespaceOrAnglePattern is JavaScript's \s set plus <>: the first isURL
// rejection.
var urlWhitespaceOrAnglePattern = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}<>]`)

// FQDN fragments (require_tld:false, allow_underscores:false,
// allow_numeric_tld:false).
var fqdnPartPattern = regexp.MustCompile(`(?i)^[a-z_\x{00a1}-\x{ffff}\x{10000}-\x{10ffff}0-9-]+$`)
var fqdnFullWidthPattern = regexp.MustCompile(`[\x{ff01}-\x{ff5e}]`)
var fqdnNumericTLDPattern = regexp.MustCompile(`^\d+$`)
var fqdnHyphenEdgePattern = regexp.MustCompile(`^-|-$`)
var urlPortPattern = regexp.MustCompile(`^[0-9]+$`)

// validatorIsURL reports whether the string passes isURL with the DTO options.
// class-validator's @IsUrl first checks typeof string and returns false for any
// other type without throwing, so callers only pass decoded strings.
func validatorIsURL(value string) bool {
	if value == "" || urlWhitespaceOrAnglePattern.MatchString(value) {
		return false
	}
	if strings.HasPrefix(value, "mailto:") {
		return false
	}
	if jsLengthUTF16(value) > 2084 {
		return false
	}
	// Fragment and query stripping (allow_fragments / allow_query_components
	// default to true).
	trimmed := value
	if idx := strings.Index(trimmed, "#"); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	if idx := strings.Index(trimmed, "?"); idx >= 0 {
		trimmed = trimmed[:idx]
	}

	match := urlProtocolPattern.FindStringSubmatch(trimmed)
	if match == nil {
		return false // require_protocol
	}
	potentialProtocol := match[1]
	afterColon := trimmed[len(match[0]):]
	startsWithSlashes := strings.HasPrefix(afterColon, "//")
	if !startsWithSlashes {
		firstSlash := strings.Index(afterColon, "/")
		beforeSlash := afterColon
		if firstSlash >= 0 {
			beforeSlash = afterColon[:firstSlash]
		}
		if atPosition := strings.Index(beforeSlash, "@"); atPosition >= 0 {
			if urlValidAuthPattern.MatchString(beforeSlash[:atPosition]) {
				return false
			}
			trimmed = trimmed[len(match[0]):]
			if !urlAllowedProtocol(potentialProtocol) {
				return false
			}
		} else if len(afterColon) > 0 && afterColon[0] >= '0' && afterColon[0] <= '9' {
			return false
		} else {
			trimmed = trimmed[len(match[0]):]
			if !urlAllowedProtocol(potentialProtocol) {
				return false
			}
		}
	} else {
		trimmed = trimmed[len(match[0]):]
		if !urlAllowedProtocol(potentialProtocol) {
			return false
		}
	}

	if strings.HasPrefix(trimmed, "//") {
		trimmed = trimmed[2:]
	}
	if trimmed == "" {
		return false
	}
	if idx := strings.Index(trimmed, "/"); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	if idx := strings.Index(trimmed, "@"); idx >= 0 {
		auth := trimmed[:idx]
		if auth == "" {
			return false
		}
		if strings.Contains(auth, ":") && strings.Count(auth, ":")+1 > 2 {
			return false
		}
		user, password := auth, ""
		if colon := strings.Index(auth, ":"); colon >= 0 {
			user, password = auth[:colon], auth[colon+1:]
		}
		if user == "" && password == "" {
			return false
		}
		trimmed = trimmed[idx+1:]
	}

	hostname := trimmed
	portStr := ""
	ipv6 := ""
	if wrapped := urlWrappedIPv6Pattern.FindStringSubmatch(hostname); wrapped != nil {
		ipv6 = wrapped[1]
		if wrapped[2] != "" {
			portStr = wrapped[2]
		}
		hostname = ""
	} else if idx := strings.LastIndex(hostname, ":"); idx >= 0 {
		hostname, portStr = hostname[:idx], hostname[idx+1:]
	}
	if portStr != "" {
		port, err := strconv.Atoi(portStr)
		if !urlPortPattern.MatchString(portStr) || err != nil || port <= 0 || port > 65535 {
			return false
		}
	}
	if hostname == "" {
		return ipv6 != "" && urlIPv6Pattern.MatchString(ipv6)
	}
	if urlIPv4Pattern.MatchString(hostname) || isFQDN(hostname) {
		return true
	}
	return ipv6 != "" && urlIPv6Pattern.MatchString(ipv6)
}

// urlAllowedProtocol is the library's default protocol allowlist.
func urlAllowedProtocol(candidate string) bool {
	switch strings.ToLower(candidate) {
	case "http", "https", "ftp":
		return true
	}
	return false
}

// isFQDN reproduces validator.js isFQDN with require_tld:false.
func isFQDN(value string) bool {
	parts := strings.Split(value, ".")
	tld := parts[len(parts)-1]
	if fqdnNumericTLDPattern.MatchString(tld) {
		return false
	}
	for _, part := range parts {
		if jsLengthUTF16(part) > 63 {
			return false
		}
		if !fqdnPartPattern.MatchString(part) {
			return false
		}
		if fqdnFullWidthPattern.MatchString(part) {
			return false
		}
		if fqdnHyphenEdgePattern.MatchString(part) {
			return false
		}
		if strings.Contains(part, "_") {
			return false
		}
	}
	return true
}
