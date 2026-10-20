package crawloptions

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// This file ports common/validators/ssrf-url.validator.ts. The synchronous
// checks and the DNS resolution branch are both preserved; an unresolvable
// hostname stays allowed (allowUnresolved defaults to true in NestJS).

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
	"/computemetadata",
	"/metadata/instance",
	"/metadata/v1",
	"/openstack",
	"/opc/v1",
	"/opc/v2",
}

// URLValidator checks one URL. A nil ResolveHost skips DNS resolution (tests);
// the production validator resolves through the system resolver.
type URLValidator struct {
	ResolveHost func(ctx context.Context, host string) ([]string, error)
}

// NewURLValidator builds the production validator.
func NewURLValidator() *URLValidator {
	return &URLValidator{ResolveHost: func(ctx context.Context, host string) ([]string, error) {
		addresses, err := net.DefaultResolver.LookupHost(ctx, host)
		if err != nil {
			return nil, err
		}
		return addresses, nil
	}}
}

// Validate returns the IsSafeUrl failure message, or "" when the URL is safe.
func (v *URLValidator) Validate(ctx context.Context, raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "Invalid URL: " + err.Error()
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Sprintf("Invalid protocol: %s:. Only http and https are allowed.", scheme)
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return "Empty hostname is not allowed."
	}
	if isLocalhostVariation(hostname) {
		return "Localhost is not allowed: " + hostname
	}
	if isIPAddress(hostname) {
		clean := strings.Trim(hostname, "[]")
		if isPrivateIP(clean) {
			return "Private/internal IP address is not allowed: " + hostname
		}
	}
	if isCloudMetadataEndpoint(hostname, parsed.Path) {
		return "Cloud metadata endpoint is not allowed: " + hostname
	}
	if decoded := decodeURIComponent(hostname); decoded != hostname && isIPAddress(decoded) {
		if isPrivateIP(strings.Trim(decoded, "[]")) {
			return "URL-encoded private IP address is not allowed: " + hostname
		}
	}
	if v == nil || v.ResolveHost == nil || isIPAddress(hostname) {
		return ""
	}
	addresses, err := v.ResolveHost(ctx, hostname)
	if err != nil {
		// DNS failure keeps the permissive behaviour.
		return ""
	}
	for _, address := range addresses {
		if isPrivateIP(address) {
			return "Hostname " + hostname + " resolves to private IP: " + address
		}
	}
	return ""
}

// isPrivateIP covers RFC 1918, loopback, link-local and the reserved ranges the
// NestJS validator blocks.
func isPrivateIP(ip string) bool {
	if strings.Contains(ip, ":") {
		return isPrivateIPv6(ip)
	}
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return true
	}
	values := make([]int, 4)
	for index, part := range parts {
		parsed, err := strconv.Atoi(part)
		if err != nil || parsed < 0 || parsed > 255 {
			return true
		}
		values[index] = parsed
	}
	a, b, c, d := values[0], values[1], values[2], values[3]
	switch {
	case a == 0:
		return true
	case a == 10:
		return true
	case a == 100 && b >= 64 && b <= 127:
		return true
	case a == 127:
		return true
	case a == 169 && b == 254:
		return true
	case a == 172 && b >= 16 && b <= 31:
		return true
	case a == 192 && b == 0 && c == 0:
		return true
	case a == 192 && b == 0 && c == 2:
		return true
	case a == 192 && b == 88 && c == 99:
		return true
	case a == 192 && b == 168:
		return true
	case a == 198 && (b == 18 || b == 19):
		return true
	case a == 198 && b == 51 && c == 100:
		return true
	case a == 203 && b == 0 && c == 113:
		return true
	case a >= 224 && a <= 239:
		return true
	case a >= 240:
		return true
	case a == 255 && b == 255 && c == 255 && d == 255:
		return true
	}
	return false
}

func isPrivateIPv6(ip string) bool {
	normalized := strings.ToLower(ip)
	if normalized == "::1" || normalized == "0:0:0:0:0:0:0:1" {
		return true
	}
	if normalized == "::" || normalized == "0:0:0:0:0:0:0:0" {
		return true
	}
	if strings.HasPrefix(normalized, "fe8") || strings.HasPrefix(normalized, "fe9") ||
		strings.HasPrefix(normalized, "fea") || strings.HasPrefix(normalized, "feb") {
		return true
	}
	if strings.HasPrefix(normalized, "fc") || strings.HasPrefix(normalized, "fd") {
		return true
	}
	if strings.HasPrefix(normalized, "ff") {
		return true
	}
	if strings.HasPrefix(normalized, "::ffff:") {
		ipv4Part := normalized[7:]
		if strings.Contains(ipv4Part, ".") {
			return isPrivateIP(ipv4Part)
		}
	}
	if strings.HasPrefix(normalized, "64:ff9b:") {
		return true
	}
	if strings.HasPrefix(normalized, "100:") {
		return true
	}
	if strings.HasPrefix(normalized, "2001:db8:") {
		return true
	}
	return false
}

func isCloudMetadataEndpoint(hostname, path string) bool {
	normalizedHost := strings.ToLower(hostname)
	for _, host := range cloudMetadataHosts {
		if normalizedHost == strings.ToLower(host) {
			return true
		}
	}
	if strings.Contains(normalizedHost, "metadata") || strings.Contains(normalizedHost, "instance-data") {
		return true
	}
	if path != "" {
		normalizedPath := strings.ToLower(path)
		for _, prefix := range cloudMetadataPaths {
			if strings.HasPrefix(normalizedPath, prefix) {
				return true
			}
		}
	}
	return false
}

func isIPAddress(hostname string) bool {
	if strings.HasPrefix(hostname, "[") && strings.HasSuffix(hostname, "]") {
		return true
	}
	parts := strings.Split(hostname, ".")
	if len(parts) == 4 {
		for _, part := range parts {
			if part == "" || len(part) > 3 {
				return false
			}
			for _, r := range part {
				if r < '0' || r > '9' {
					return false
				}
			}
		}
		return true
	}
	return strings.Contains(hostname, ":") && !strings.Contains(hostname, ".")
}

func isLocalhostVariation(hostname string) bool {
	normalized := strings.ToLower(hostname)
	switch normalized {
	case "localhost", "localhost.localdomain", "local", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "0":
		return true
	}
	if strings.HasSuffix(normalized, ".localhost") || strings.HasSuffix(normalized, ".local") {
		return true
	}
	if strings.HasPrefix(normalized, "0x7f") || strings.HasPrefix(normalized, "0177.") {
		return true
	}
	if isDigits(normalized) {
		if number, err := strconv.ParseInt(normalized, 10, 64); err == nil {
			if number >= 2130706433 && number <= 2147483647 {
				return true
			}
			if number == 0 {
				return true
			}
		}
	}
	return false
}

// decodeURIComponent decodes percent escapes and leaves an invalid sequence
// untouched, like the NestJS helper.
func decodeURIComponent(value string) string {
	if !strings.Contains(value, "%") {
		return value
	}
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return value
	}
	return decoded
}
