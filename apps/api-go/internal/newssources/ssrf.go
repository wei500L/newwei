package newssources

import (
	"context"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// 对齐 apps/api/src/common/validators/ssrf-url.validator.ts。
// 同步检查先于 DNS。DNS 失败默认放行，和 validateSsrfUrlAsync 的
// allowUnresolved 默认值一致。不发起 HTTP，也不走 crawl4ai。
//
// The NestJS validator inspects `new URL(url).hostname`, i.e. the WHATWG host
// parser output. That parser lower-cases the host, applies the UTS #46 mapping
// and parses a host that ends in a number as IPv4 (decimal, octal or hex), so
// "127.1", "017700000001" and "ｍｅｔａｄａｔａ.google.internal" all reach the rules as
// 127.0.0.1 / metadata.google.internal. net/url keeps them as opaque names that
// net.ParseIP does not recognise, which is why the checks below canonicalise the
// host first instead of trusting url.Hostname verbatim. A percent-encoded ASCII
// host does not need the same treatment: RFC 3986 only allows %-escapes for
// non-ASCII host bytes, so net/url rejects "%31%32%37.0.0.1" while parsing.

// ssrfHostIDNA is the UTS #46 profile the WHATWG host parser applies: map
// compatibility spellings (full-width forms and the like) to their ASCII
// equivalent, keep the non-transitional mapping and drop the STD3/hyphen
// restrictions browser parsing does not enforce.
var ssrfHostIDNA = idna.New(
	idna.MapForLookup(),
	idna.Transitional(false),
	idna.StrictDomainName(false),
	idna.CheckHyphens(false),
)

var cloudMetadataHosts = []string{
	"169.254.169.254",
	"metadata.google.internal",
	"metadata.goog",
	"metadata",
	"instance-data",
	"169.254.170.2",
	"fd00:ec2::254",
}

var cloudMetadataPaths = []string{
	"/latest/meta-data",
	"/latest/user-data",
	"/latest/dynamic",
	"/computeMetadata",
	"/metadata/instance",
	"/metadata/v1",
	"/openstack",
	"/opc/v1",
	"/opc/v2",
}

func validateSourceURL(ctx context.Context, raw string) (string, bool) {
	parsed, reason := parseSSRFURL(raw)
	if reason != "" {
		return reason, false
	}
	host, hostReason := canonicalSSRFHost(parsed)
	if hostReason != "" {
		return hostReason, false
	}
	if reason := validateSSRFHost(host, parsed.Path); reason != "" {
		return reason, false
	}
	// IP literals and the numeric host forms below never take part in name
	// resolution, so there is no DNS re-check to do. The rules above already
	// rejected the private ones.
	if isIPAddress(host) {
		return "", true
	}
	if _, numeric, _ := parseWHATWGIPv4Host(host); numeric {
		return "", true
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return "", true
	}
	for _, ip := range ips {
		if isPrivateIP(ip.String()) {
			return "Hostname " + host + " resolves to private IP: " + ip.String(), false
		}
	}
	return "", true
}

func validateSSRFSync(raw string) string {
	parsed, reason := parseSSRFURL(raw)
	if reason != "" {
		return reason
	}
	host, hostReason := canonicalSSRFHost(parsed)
	if hostReason != "" {
		return hostReason
	}
	return validateSSRFHost(host, parsed.Path)
}

// parseSSRFURL parses the target and applies the scheme rule both entry points
// share.
func parseSSRFURL(raw string) (*url.URL, string) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, "Invalid URL: " + err.Error()
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, "Invalid protocol: " + parsed.Scheme + ":. Only http and https are allowed."
	}
	return parsed, ""
}

// canonicalSSRFHost returns the host the rules must inspect: the WHATWG host
// parser lower-cases it, applies the UTS #46 mapping and drops one trailing
// dot before the NestJS validator sees it.
func canonicalSSRFHost(parsed *url.URL) (string, string) {
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", "Empty hostname is not allowed."
	}
	if !isASCII(host) {
		mapped, err := ssrfHostIDNA.ToASCII(host)
		if err != nil {
			return "", "Invalid hostname is not allowed: " + host
		}
		host = mapped
	}
	if len(host) > 1 && strings.HasSuffix(host, ".") {
		host = strings.TrimSuffix(host, ".")
	}
	return host, ""
}

// validateSSRFHost applies the shared host rules. The numeric branch covers the
// IPv4 spellings net.ParseIP refuses but a URL parser resolves, e.g. "127.1" or
// "017700000001"; a numeric host that does not parse is an invalid URL in Node.
func validateSSRFHost(host, path string) string {
	if isLocalhostVariation(host) {
		return "Localhost is not allowed: " + host
	}
	if isIPAddress(host) {
		if isPrivateIP(host) {
			return "Private/internal IP address is not allowed: " + host
		}
	} else if ip, numeric, ok := parseWHATWGIPv4Host(host); numeric {
		if !ok {
			return "Invalid IPv4 address is not allowed: " + host
		}
		if isPrivateIP(ip.String()) {
			return "Private/internal IP address is not allowed: " + host
		}
	}
	if isCloudMetadata(host, path) {
		return "Cloud metadata endpoint is not allowed: " + host
	}
	return ""
}

func isASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] >= 0x80 {
			return false
		}
	}
	return true
}

// parseWHATWGIPv4Host mirrors the WHATWG IPv4 parser: a host whose last label
// ends in a number is an IPv4 address written in one to four decimal, octal or
// hexadecimal parts. numeric reports that the host must be read as IPv4; ok
// reports that the parse succeeded.
func parseWHATWGIPv4Host(host string) (ip net.IP, numeric bool, ok bool) {
	parts := strings.Split(host, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if !endsInNumber(parts) {
		return nil, false, false
	}
	if len(parts) > 4 {
		return nil, true, false
	}
	numbers := make([]uint64, 0, len(parts))
	for _, part := range parts {
		radix := 10
		digits := part
		switch {
		case len(part) > 2 && (strings.HasPrefix(part, "0x") || strings.HasPrefix(part, "0X")):
			radix, digits = 16, part[2:]
		case len(part) > 1 && part[0] == '0':
			radix, digits = 8, part[1:]
		}
		if digits == "" {
			return nil, true, false
		}
		value, err := strconv.ParseUint(digits, radix, 32)
		if err != nil {
			return nil, true, false
		}
		numbers = append(numbers, value)
	}
	for _, value := range numbers[:len(numbers)-1] {
		if value > 255 {
			return nil, true, false
		}
	}
	last := numbers[len(numbers)-1]
	if last >= uint64(1)<<(8*uint(5-len(numbers))) {
		return nil, true, false
	}
	address := last
	for index, value := range numbers[:len(numbers)-1] {
		address += value << (8 * uint(3-index))
	}
	return net.IPv4(byte(address>>24), byte(address>>16), byte(address>>8), byte(address)), true, true
}

// endsInNumber is the WHATWG "ends in a number" check applied to the last label.
func endsInNumber(parts []string) bool {
	if len(parts) == 0 {
		return false
	}
	last := parts[len(parts)-1]
	if len(last) > 2 && (strings.HasPrefix(last, "0x") || strings.HasPrefix(last, "0X")) {
		return isBaseDigits(last[2:], 16)
	}
	return isBaseDigits(last, 10)
}

func isBaseDigits(value string, radix int) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		switch {
		case char >= '0' && char <= '9':
			if int(char-'0') >= radix {
				return false
			}
		case radix == 16 && char >= 'a' && char <= 'f':
		case radix == 16 && char >= 'A' && char <= 'F':
		default:
			return false
		}
	}
	return true
}

func isCloudMetadata(host, path string) bool {
	for _, item := range cloudMetadataHosts {
		if host == item {
			return true
		}
	}
	if strings.Contains(host, "metadata") || strings.Contains(host, "instance-data") {
		return true
	}
	lowerPath := strings.ToLower(path)
	for _, item := range cloudMetadataPaths {
		if strings.HasPrefix(lowerPath, item) {
			return true
		}
	}
	return false
}

func isLocalhostVariation(host string) bool {
	switch host {
	case "localhost", "localhost.localdomain", "local", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "0":
		return true
	}
	if strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return true
	}
	if strings.HasPrefix(host, "0x7f") || strings.HasPrefix(host, "0177.") {
		return true
	}
	if host != "" && strings.Trim(host, "0123456789") == "" {
		num, err := strconv.ParseInt(host, 10, 64)
		if err == nil && ((num >= 2130706433 && num <= 2147483647) || num == 0) {
			return true
		}
	}
	return false
}

func isIPAddress(host string) bool {
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return net.ParseIP(strings.Trim(host, "[]")) != nil
	}
	if net.ParseIP(host) != nil {
		return true
	}
	if !strings.Contains(host, "%") {
		return false
	}
	// RFC 6874 zone identifiers ("[fe80::1%25eth0]") are valid IPv6 literals
	// that net.ParseIP refuses. Node keeps them IP literals, so they must not
	// fall through as host names; isPrivateIP then classifies the unparseable
	// value as private.
	address, err := netip.ParseAddr(host)
	return err == nil && address.Is6()
}

func isPrivateIP(ip string) bool {
	parsed := net.ParseIP(strings.Trim(ip, "[]"))
	if parsed == nil {
		return true
	}
	if v4 := parsed.To4(); v4 != nil {
		return privateIPv4(v4)
	}
	return privateIPv6(parsed.String())
}

func privateIPv4(ip net.IP) bool {
	a, b, c, d := int(ip[0]), int(ip[1]), int(ip[2]), int(ip[3])
	if a == 0 || a == 10 || a == 127 {
		return true
	}
	if a == 100 && b >= 64 && b <= 127 {
		return true
	}
	if a == 169 && b == 254 {
		return true
	}
	if a == 172 && b >= 16 && b <= 31 {
		return true
	}
	if a == 192 && b == 0 && c == 0 {
		return true
	}
	if a == 192 && b == 0 && c == 2 {
		return true
	}
	if a == 192 && b == 88 && c == 99 {
		return true
	}
	if a == 192 && b == 168 {
		return true
	}
	if a == 198 && (b == 18 || b == 19) {
		return true
	}
	if a == 198 && b == 51 && c == 100 {
		return true
	}
	if a == 203 && b == 0 && c == 113 {
		return true
	}
	if a >= 224 {
		return true
	}
	if a == 255 && b == 255 && c == 255 && d == 255 {
		return true
	}
	return false
}

func privateIPv6(ip string) bool {
	normalized := strings.ToLower(ip)
	switch normalized {
	case "::1", "0:0:0:0:0:0:0:1", "::", "0:0:0:0:0:0:0:0":
		return true
	}
	if strings.HasPrefix(normalized, "fe8") || strings.HasPrefix(normalized, "fe9") || strings.HasPrefix(normalized, "fea") || strings.HasPrefix(normalized, "feb") {
		return true
	}
	if strings.HasPrefix(normalized, "fc") || strings.HasPrefix(normalized, "fd") || strings.HasPrefix(normalized, "ff") {
		return true
	}
	if strings.HasPrefix(normalized, "::ffff:") {
		return isPrivateIP(strings.TrimPrefix(normalized, "::ffff:"))
	}
	if strings.HasPrefix(normalized, "64:ff9b:") || strings.HasPrefix(normalized, "100:") || strings.HasPrefix(normalized, "2001:db8:") {
		return true
	}
	return false
}
