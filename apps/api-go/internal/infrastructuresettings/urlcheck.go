package infrastructuresettings

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// This file reproduces validator.js 13.15.23 `isURL(value, {require_protocol:
// true})`, which is what class-validator's @IsUrl calls for the storage DTO.
//
// The rules are transcribed from the locked dependency source rather than
// approximated with net/url: the default protocol list is http/https/ftp (not
// just http/https), require_tld is true (so "http://localhost:9000" is
// rejected while "http://127.0.0.1:9000" passes through the IP branch), the
// length cap is 2084, whitespace and angle brackets are rejected up front, and
// the host/port/IPv6 grammar is exactly the dependency's.

var (
	urlWhitespaceRe = regexp.MustCompile(`[\s<>]`)
	urlProtocolRe   = regexp.MustCompile(`(?i)^([a-z][a-z0-9+\-.]*):`)
	urlAuthCharsRe  = regexp.MustCompile(`^[a-zA-Z0-9\-_.%:]*$`)
	urlDigitsRe     = regexp.MustCompile(`^[0-9]+$`)
	urlWrappedIPv6  = regexp.MustCompile(`^\[([^\]]+)\](?::([0-9]+))?$`)

	urlIPv4Segment = `(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])`
	urlIPv4Address = "(" + urlIPv4Segment + "[.]){3}" + urlIPv4Segment
	urlIPv4Re      = regexp.MustCompile("^" + urlIPv4Address + "$")

	urlIPv6Segment = `(?:[0-9a-fA-F]{1,4})`
	urlIPv6Re      = regexp.MustCompile("^(" +
		"(?:" + urlIPv6Segment + ":){7}(?:" + urlIPv6Segment + "|:)|" +
		"(?:" + urlIPv6Segment + ":){6}(?:" + urlIPv4Address + "|:" + urlIPv6Segment + "|:)|" +
		"(?:" + urlIPv6Segment + ":){5}(?::" + urlIPv4Address + "|(:" + urlIPv6Segment + "){1,2}|:)|" +
		"(?:" + urlIPv6Segment + ":){4}(?:(?::" + urlIPv6Segment + "){0,1}:" + urlIPv4Address + "|(:" + urlIPv6Segment + "){1,3}|:)|" +
		"(?:" + urlIPv6Segment + ":){3}(?:(?::" + urlIPv6Segment + "){0,2}:" + urlIPv4Address + "|(:" + urlIPv6Segment + "){1,4}|:)|" +
		"(?:" + urlIPv6Segment + ":){2}(?:(?::" + urlIPv6Segment + "){0,3}:" + urlIPv4Address + "|(:" + urlIPv6Segment + "){1,5}|:)|" +
		"(?:" + urlIPv6Segment + ":){1}(?:(?::" + urlIPv6Segment + "){0,4}:" + urlIPv4Address + "|(:" + urlIPv6Segment + "){1,6}|:)|" +
		"(?::((?::" + urlIPv6Segment + "){0,5}:" + urlIPv4Address + "|(?::" + urlIPv6Segment + "){1,7}|:))" +
		")(%[0-9a-zA-Z.]{1,})?$")

	fqdnTLDRe      = regexp.MustCompile(`(?i)^([a-z\x{00A1}-\x{00A8}\x{00AA}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFEF}]{2,}|xn[a-z0-9-]{2,})$`)
	fqdnPartRe     = regexp.MustCompile(`(?i)^[a-z_\x{00a1}-\x{ffff}0-9-]+$`)
	fqdnFullWidth  = regexp.MustCompile(`[\x{ff01}-\x{ff5e}]`)
	fqdnNumericTLD = regexp.MustCompile(`^[0-9]+$`)
	fqdnEdgeHyphen = regexp.MustCompile(`^-|-$`)
	fqdnSpaceRe    = regexp.MustCompile(`[\s]`)
)

// urlDefaultProtocols is validator's default protocol allowlist. It includes
// ftp, so the storage DTO must not be narrowed to http/https.
var urlDefaultProtocols = []string{"http", "https", "ftp"}

// urlConstraint validates @IsUrl({require_protocol: true}). Non-strings fail,
// exactly like isURL's assertString.
func urlConstraint(v *validationErrors, raw json.RawMessage, field string) (string, bool) {
	text, ok := stringConstraint(&validationErrors{}, raw, field, false)
	if !ok || !isURLValue(text) {
		v.add(field + " must be a URL address")
		return "", false
	}
	return text, true
}

// isURLValue reports whether value passes validator's isURL with
// require_protocol enabled and every other option at its default.
func isURLValue(value string) bool {
	if value == "" || urlWhitespaceRe.MatchString(value) {
		return false
	}
	if strings.HasPrefix(value, "mailto:") {
		return false
	}
	if utf16Length(value) > 2084 {
		return false
	}

	// Fragments and query components are allowed, so they are stripped before
	// authority parsing (first '#' then first '?').
	url := value
	if index := strings.Index(url, "#"); index >= 0 {
		url = url[:index]
	}
	if index := strings.Index(url, "?"); index >= 0 {
		url = url[:index]
	}

	hadExplicitProtocol := false
	match := urlProtocolRe.FindStringSubmatchIndex(url)
	if match == nil {
		// require_protocol, so a URL without a scheme is invalid.
		return false
	}
	potentialProtocol := url[match[2]:match[3]]
	afterColon := url[match[1]:]
	consumeProtocol := func() bool {
		protocol := strings.ToLower(potentialProtocol)
		if !containsString(urlDefaultProtocols, protocol) {
			return false
		}
		hadExplicitProtocol = true
		url = url[match[1]:]
		return true
	}
	if strings.HasPrefix(afterColon, "//") {
		if !consumeProtocol() {
			return false
		}
	} else {
		beforeSlash := afterColon
		if index := strings.Index(afterColon, "/"); index >= 0 {
			beforeSlash = afterColon[:index]
		}
		if atIndex := strings.Index(beforeSlash, "@"); atIndex >= 0 {
			if urlAuthCharsRe.MatchString(beforeSlash[:atIndex]) {
				// user:password@host, not a protocol. require_protocol is on, so
				// this is invalid.
				return false
			}
			if !consumeProtocol() {
				return false
			}
		} else if len(afterColon) > 0 && afterColon[0] >= '0' && afterColon[0] <= '9' {
			// hostname:port, not a protocol. require_protocol is on.
			return false
		} else if !consumeProtocol() {
			return false
		}
	}

	if strings.HasPrefix(url, "//") {
		if !hadExplicitProtocol {
			return false
		}
		url = url[2:]
	}
	if url == "" {
		return false
	}
	if index := strings.Index(url, "/"); index >= 0 {
		url = url[:index]
	}

	hostname := url
	atParts := strings.Split(url, "@")
	if len(atParts) > 1 {
		if atParts[0] == "" {
			return false
		}
		auth := atParts[0]
		if strings.Contains(auth, ":") && len(strings.Split(auth, ":")) > 2 {
			return false
		}
		colonParts := strings.SplitN(auth, ":", 2)
		user := colonParts[0]
		password := ""
		if len(colonParts) > 1 {
			password = colonParts[1]
		}
		if user == "" && password == "" {
			return false
		}
		hostname = strings.Join(atParts[1:], "@")
	}

	host := ""
	ipv6 := ""
	portStr := ""
	hasPort := false
	if wrapped := urlWrappedIPv6.FindStringSubmatch(hostname); wrapped != nil {
		ipv6 = wrapped[1]
		if wrapped[2] != "" {
			portStr = wrapped[2]
			hasPort = true
		}
	} else {
		parts := strings.Split(hostname, ":")
		host = parts[0]
		if len(parts) > 1 {
			portStr = strings.Join(parts[1:], ":")
			hasPort = true
		}
	}
	if hasPort && len(portStr) > 0 {
		if !urlDigitsRe.MatchString(portStr) {
			return false
		}
		port, err := strconv.Atoi(portStr)
		if err != nil || port <= 0 || port > 65535 {
			return false
		}
	}

	if !isIPValue(host) && !isFQDNValue(host) && !(ipv6 != "" && isIPv6Value(ipv6)) {
		return false
	}
	return true
}

// isIPValue mirrors isIP(ipAddress) without an explicit version: IPv4 or IPv6.
func isIPValue(value string) bool {
	return urlIPv4Re.MatchString(value) || urlIPv6Re.MatchString(value)
}

// isIPv6Value mirrors isIP(ipAddress, 6).
func isIPv6Value(value string) bool { return urlIPv6Re.MatchString(value) }

// isFQDNValue mirrors isFQDN(value, options) with the isURL options merged over
// the FQDN defaults: require_tld true, allow_underscores false,
// allow_trailing_dot false, allow_numeric_tld false, ignore_max_length false.
func isFQDNValue(value string) bool {
	parts := strings.Split(value, ".")
	tld := parts[len(parts)-1]
	if len(parts) < 2 {
		return false
	}
	if !fqdnTLDRe.MatchString(tld) {
		return false
	}
	if fqdnSpaceRe.MatchString(tld) {
		return false
	}
	if fqdnNumericTLD.MatchString(tld) {
		return false
	}
	for _, part := range parts {
		if utf16Length(part) > 63 {
			return false
		}
		if !fqdnPartRe.MatchString(part) {
			return false
		}
		if fqdnFullWidth.MatchString(part) {
			return false
		}
		if fqdnEdgeHyphen.MatchString(part) {
			return false
		}
		if strings.Contains(part, "_") {
			return false
		}
	}
	return true
}

// containsString reports whether list contains value.
func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
