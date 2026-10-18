package workspacewrite

import (
	"context"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// This file mirrors apps/api/src/common/validators/ssrf-url.validator.ts for the
// alert channel webhook target. The sync hostname check runs before DNS, and a
// DNS failure is accepted at save time, exactly like the validator's
// allowUnresolved default (true). No HTTP probe is made.
//
// apps/api-go/internal/newssources/ssrf.go is the sibling implementation for
// the news source routes. The two are separate because that package keeps its
// helpers unexported; this one re-checks the URL details against the NestJS
// validator and is not claimed to be byte-for-byte equal for exotic URLs.

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

// assertSafeWebhookTarget rejects an unsafe webhook URL with the service-layer
// BadRequestException message. The IsSafeUrl DTO check runs first for
// createAlertChannel and reports the bare reason; this one is the layer that
// updateAlertChannel reaches as well.
func assertSafeWebhookTarget(ctx context.Context, target string) error {
	if reason := dtoWebhookTargetReason(ctx, target); reason != "" {
		return badRequest("Unsafe webhook target: " + reason)
	}
	return nil
}

// dtoWebhookTargetReason is the IsSafeUrl constraint result: the sync hostname
// check first, then DNS, returning the NestJS reason or an empty string.
func dtoWebhookTargetReason(ctx context.Context, target string) string {
	if reason := validateSSRFSync(target); reason != "" {
		return reason
	}
	if reason, ok := validateSSRFResolved(ctx, target); !ok {
		return reason
	}
	return ""
}

// validateSSRFSync runs the hostname-only checks and returns the NestJS reason,
// or an empty string when the URL passes. It matches validateSsrfUrl.
func validateSSRFSync(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "Invalid URL: " + err.Error()
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "Invalid protocol: " + parsed.Scheme + ":. Only http and https are allowed."
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "Empty hostname is not allowed."
	}
	if isLocalhostVariation(host) {
		return "Localhost is not allowed: " + host
	}
	if isIPAddress(host) && isPrivateIP(host) {
		return "Private/internal IP address is not allowed: " + host
	}
	if isCloudMetadataEndpoint(host, parsed.Path) {
		return "Cloud metadata endpoint is not allowed: " + host
	}
	if decoded, err := url.PathUnescape(host); err == nil && decoded != host && isIPAddress(decoded) && isPrivateIP(decoded) {
		return "URL-encoded private IP address is not allowed: " + host
	}
	return ""
}

// validateSSRFResolved resolves the hostname and rejects it when any address is
// private. An IP literal is accepted without resolution and a lookup failure is
// accepted, matching resolveValidatedSsrfUrlAsync with allowUnresolved=true.
func validateSSRFResolved(ctx context.Context, raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "Invalid URL: " + err.Error(), false
	}
	host := strings.ToLower(parsed.Hostname())
	if isIPAddress(host) {
		return "", true
	}
	addresses, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		// The saved configuration keeps an unresolvable hostname; only the
		// runtime send path treats that as a failure.
		return "", true
	}
	for _, address := range addresses {
		if isPrivateIP(address.String()) {
			return "Hostname " + host + " resolves to private IP: " + address.String(), false
		}
	}
	return "", true
}

// isCloudMetadataEndpoint mirrors isCloudMetadataEndpoint.
func isCloudMetadataEndpoint(host, path string) bool {
	for _, blocked := range cloudMetadataHosts {
		if host == blocked {
			return true
		}
	}
	if strings.Contains(host, "metadata") || strings.Contains(host, "instance-data") {
		return true
	}
	lowerPath := strings.ToLower(path)
	for _, blocked := range cloudMetadataPaths {
		if strings.HasPrefix(lowerPath, blocked) {
			return true
		}
	}
	return false
}

// isLocalhostVariation mirrors isLocalhostVariation.
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
		number, err := strconv.ParseInt(host, 10, 64)
		if err == nil && ((number >= 2130706433 && number <= 2147483647) || number == 0) {
			return true
		}
	}
	return false
}

// isIPAddress mirrors isIPAddress: a bracketed host is an IPv6 literal.
func isIPAddress(host string) bool {
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return net.ParseIP(strings.Trim(host, "[]")) != nil
	}
	return net.ParseIP(host) != nil
}

// isPrivateIP mirrors isPrivateIP. An address that cannot be parsed is treated
// as private, like the NestJS fallback.
func isPrivateIP(address string) bool {
	parsed := net.ParseIP(strings.Trim(address, "[]"))
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

func privateIPv6(address string) bool {
	normalized := strings.ToLower(address)
	switch normalized {
	case "::1", "0:0:0:0:0:0:0:1", "::", "0:0:0:0:0:0:0:0":
		return true
	}
	if strings.HasPrefix(normalized, "fe8") || strings.HasPrefix(normalized, "fe9") ||
		strings.HasPrefix(normalized, "fea") || strings.HasPrefix(normalized, "feb") {
		return true
	}
	if strings.HasPrefix(normalized, "fc") || strings.HasPrefix(normalized, "fd") || strings.HasPrefix(normalized, "ff") {
		return true
	}
	if strings.HasPrefix(normalized, "::ffff:") {
		return isPrivateIP(strings.TrimPrefix(normalized, "::ffff:"))
	}
	if strings.HasPrefix(normalized, "64:ff9b:") || strings.HasPrefix(normalized, "100:") ||
		strings.HasPrefix(normalized, "2001:db8:") {
		return true
	}
	return false
}
