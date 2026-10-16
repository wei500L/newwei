package newssources

import (
	"context"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// 对齐 apps/api/src/common/validators/ssrf-url.validator.ts。
// 同步检查先于 DNS。DNS 失败默认放行，和 validateSsrfUrlAsync 的
// allowUnresolved 默认值一致。不发起 HTTP，也不走 crawl4ai。

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
	reason := validateSSRFSync(raw)
	if reason != "" {
		return reason, false
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "Invalid URL: " + err.Error(), false
	}
	host := strings.ToLower(parsed.Hostname())
	if isIPAddress(host) {
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
	if isCloudMetadata(host, parsed.Path) {
		return "Cloud metadata endpoint is not allowed: " + host
	}
	if decoded, err := url.PathUnescape(host); err == nil && decoded != host && isIPAddress(decoded) && isPrivateIP(decoded) {
		return "URL-encoded private IP address is not allowed: " + host
	}
	return ""
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
	return net.ParseIP(host) != nil
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
