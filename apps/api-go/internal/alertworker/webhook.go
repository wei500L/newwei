package alertworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// This file ports AlertService.sendWebhook plus resolveSafeWebhookTarget and
// createPinnedLookup from apps/api/src/modules/alerts/alerts.service.ts, and
// the validator in apps/api/src/common/validators/ssrf-url.validator.ts.
//
// The delivery flow is:
//  1. synchronous URL checks (scheme, credentials, localhost, private IPs,
//     cloud metadata hosts/paths) before any network access;
//  2. a DNS resolution check for hostnames, with allowUnresolved=false on the
//     runtime send path, so every resolved address must be public;
//  3. a POST through an HTTP client whose dialer only connects to the
//     addresses that were validated in step 2. The request URL keeps the
//     original hostname, so the Host header and TLS SNI/certificate
//     verification stay on that hostname while the TCP connection goes to the
//     pinned IP. This is what defeats DNS rebinding between validation and
//     dialing.
//
// Every check and every reason string mirrors the TypeScript validator: the
// protocol, the empty hostname, the localhost variations, the literal private
// address, the cloud metadata host/path and the URL-encoded private address. A
// URL with a userinfo component stays valid here for the same reason it is
// valid there (the validator never inspects it).

const (
	// defaultAlertWebhookTimeout matches ALERT_WEBHOOK_TIMEOUT_MS's default.
	defaultAlertWebhookTimeout = 5 * time.Second
)

var (
	// cloudMetadataHosts are the hostnames/IPs that must never be dialed.
	cloudMetadataHosts = []string{
		"169.254.169.254",
		"metadata.google.internal",
		"metadata.goog",
		"metadata",
		"instance-data",
		"169.254.170.2",
		"fd00:ec2::254",
	}
	// cloudMetadataPaths are the URL path prefixes used by metadata services.
	cloudMetadataPaths = []string{
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
)

// AlertWebhookPayload is the JSON body of an alert delivery webhook.
type AlertWebhookPayload struct {
	// AlertID is the triggering alert/event id.
	AlertID string `json:"alertId"`
	// RuleName is the alert rule name.
	RuleName string `json:"ruleName"`
	// Metric is the normalized metric slug.
	Metric string `json:"metric"`
	// CurrentValue is the metric value that triggered the alert.
	CurrentValue float64 `json:"currentValue"`
	// Threshold is the threshold that fired, or null when none applied.
	Threshold *float64 `json:"threshold"`
	// TriggeredAt is the ISO-8601 timestamp supplied by the caller.
	TriggeredAt string `json:"triggeredAt"`
	// Severity is the alert severity enum value.
	Severity string `json:"severity"`
	// Operator is the rule comparison operator.
	Operator string `json:"operator"`
	// Message is the optional event message, or null.
	Message *string `json:"message"`
}

// AlertWebhookInput is the delivery data needed to build the payload.
type AlertWebhookInput struct {
	// EventID maps to payload.alertId.
	EventID string
	// RuleName maps to payload.ruleName.
	RuleName string
	// Metric maps to payload.metric.
	Metric string
	// TriggeredAt maps to payload.triggeredAt; the caller formats ISO-8601.
	TriggeredAt string
	// Severity maps to payload.severity.
	Severity string
	// Operator maps to payload.operator.
	Operator string
	// CurrentValue maps to payload.currentValue.
	CurrentValue float64
	// Threshold maps to payload.threshold; nil serializes as null.
	Threshold *float64
	// Message maps to payload.message; nil serializes as null.
	Message *string
}

// BuildAlertWebhookPayload assembles the JSON body exactly like sendWebhook.
// The threshold fallback chain (thresholdValue -> upper -> lower -> null) is
// resolved by the caller, which passes the chosen value in Threshold; this
// builder only forwards it so a value of zero is preserved.
func BuildAlertWebhookPayload(input AlertWebhookInput) AlertWebhookPayload {
	return AlertWebhookPayload{
		AlertID:      input.EventID,
		RuleName:     input.RuleName,
		Metric:       input.Metric,
		CurrentValue: input.CurrentValue,
		Threshold:    input.Threshold,
		TriggeredAt:  input.TriggeredAt,
		Severity:     input.Severity,
		Operator:     input.Operator,
		Message:      input.Message,
	}
}

// WebhookTargetError is `Unsafe webhook target: <reason>` / `Unsafe webhook
// target`. It is the Go equivalent of the runtime Error created by
// createWebhookTargetError.
type WebhookTargetError struct {
	// Reason is the validator message; an empty Reason yields the bare text.
	Reason string
}

// Error implements error.
func (e *WebhookTargetError) Error() string {
	if e == nil || strings.TrimSpace(e.Reason) == "" {
		return "Unsafe webhook target"
	}
	return "Unsafe webhook target: " + e.Reason
}

// ResolvedWebhookTarget is a validated target with the pinned addresses.
type ResolvedWebhookTarget struct {
	// URL is the original URL that will be requested.
	URL string
	// Hostname is the lower-cased URL hostname the pin belongs to.
	Hostname string
	// Addresses are the validated public addresses to dial instead of DNS.
	Addresses []WebhookAddress
}

// WebhookAddress is one validated address and its IP family.
type WebhookAddress struct {
	// Address is the textual IPv4/IPv6 address.
	Address string
	// Family is 4 or 6.
	Family int
}

// ResolveSafeWebhookTarget validates raw (sync + DNS) and returns the pinned
// target. The runtime send path uses allowUnresolved=false, so a hostname that
// cannot be resolved is an error rather than a deferred failure.
func ResolveSafeWebhookTarget(ctx context.Context, raw string) (ResolvedWebhookTarget, error) {
	if reason := validateWebhookSSRFSync(raw); reason != "" {
		return ResolvedWebhookTarget{}, &WebhookTargetError{Reason: reason}
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ResolvedWebhookTarget{}, &WebhookTargetError{Reason: "Invalid URL: " + err.Error()}
	}
	hostname := strings.ToLower(parsed.Hostname())
	if isWebhookIPAddress(hostname) {
		// The literal was already checked synchronously; skip DNS exactly like
		// resolveValidatedSsrfUrlAsync does for IP literals.
		cleanAddress := strings.Trim(hostname, "[]")
		family := 4
		if strings.Contains(cleanAddress, ":") {
			family = 6
		}
		return ResolvedWebhookTarget{
			URL:      raw,
			Hostname: hostname,
			Addresses: []WebhookAddress{
				{Address: cleanAddress, Family: family},
			},
		}, nil
	}
	addresses, err := net.DefaultResolver.LookupIP(ctx, "ip", hostname)
	if err != nil {
		return ResolvedWebhookTarget{}, &WebhookTargetError{
			Reason: "Hostname " + hostname + " could not be resolved",
		}
	}
	if len(addresses) == 0 {
		return ResolvedWebhookTarget{}, &WebhookTargetError{Reason: "Hostname could not be resolved"}
	}
	resolved := make([]WebhookAddress, 0, len(addresses))
	for _, address := range addresses {
		if isPrivateWebhookIP(address.String()) {
			return ResolvedWebhookTarget{}, &WebhookTargetError{
				Reason: "Hostname " + hostname + " resolves to private IP: " + address.String(),
			}
		}
		family := 4
		if address.To4() == nil {
			family = 6
		}
		resolved = append(resolved, WebhookAddress{Address: address.String(), Family: family})
	}
	return ResolvedWebhookTarget{URL: raw, Hostname: hostname, Addresses: resolved}, nil
}

// NewPinnedHTTPClient returns the caller-held HTTP client used for alert
// webhooks: the caller's timeout, no redirects (CheckRedirect returns
// http.ErrUseLastResponse) and keep-alive disabled, so every POST performs a
// fresh dial.
//
// The transport's dial function reads the ResolvedWebhookTarget that
// SendAlertWebhook stores in the request context. Keeping the pin in the
// request context makes the client a shareable singleton without mutable
// per-target state: concurrent deliveries to different hosts each dial their
// own validated addresses. A request that carries no pin is rejected instead
// of falling back to the system resolver.
//
// TLS is left to the transport. Because the request URL is unchanged, the
// transport derives the SNI and certificate hostname from the URL (not from
// the pinned IP string), so verification still targets the original hostname.
func NewPinnedHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			// Never use an environment proxy: a proxy would connect on our
			// behalf and bypass the pinned dialer.
			Proxy:             nil,
			DialContext:       dialPinnedWebhookTarget,
			DisableKeepAlives: true,
			ForceAttemptHTTP2: false,
			// TLSClientConfig stays nil, so the standard verification applies
			// against the URL hostname.
			TLSClientConfig: nil,
		},
	}
}

// SendAlertWebhook validates, pins and POSTs the payload; a non-2xx response is
// an error. The client must be the caller-held singleton from
// NewPinnedHTTPClient (a nil client falls back to a default-timeout pinned
// client); other clients would not enforce the pin.
func SendAlertWebhook(ctx context.Context, client *http.Client, rawURL string, payload AlertWebhookPayload) error {
	target, err := ResolveSafeWebhookTarget(ctx, rawURL)
	if err != nil {
		return err
	}
	if client == nil {
		client = NewPinnedHTTPClient(defaultAlertWebhookTimeout)
	}
	return postWebhook(withPinnedWebhookTarget(ctx, target), client, target.URL, payload)
}

// pinnedWebhookTargetKey is the private context key of the pinned target.
type pinnedWebhookTargetKey struct{}

// withPinnedWebhookTarget stores the validated target for the dialer. The value
// is immutable, so sharing it with the transport goroutine is safe.
func withPinnedWebhookTarget(ctx context.Context, target ResolvedWebhookTarget) context.Context {
	return context.WithValue(ctx, pinnedWebhookTargetKey{}, target)
}

// pinnedWebhookTargetFromContext returns the pin installed by SendAlertWebhook.
func pinnedWebhookTargetFromContext(ctx context.Context) (ResolvedWebhookTarget, bool) {
	if ctx == nil {
		return ResolvedWebhookTarget{}, false
	}
	target, ok := ctx.Value(pinnedWebhookTargetKey{}).(ResolvedWebhookTarget)
	return target, ok
}

// dialPinnedWebhookTarget is the Transport.DialContext hook. net/http keeps
// request context values when it detaches the dial from request cancellation,
// so the pin installed by SendAlertWebhook is visible here.
func dialPinnedWebhookTarget(ctx context.Context, network, address string) (net.Conn, error) {
	target, ok := pinnedWebhookTargetFromContext(ctx)
	if !ok {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			host = address
		}
		return nil, fmt.Errorf("Pinned lookup has no validated target for %s", host)
	}
	return dialPinnedWebhookAddress(ctx, network, address, target.Hostname, target.Addresses)
}

// pinnedDialContext builds a dialer bound to one validated hostname. It is the
// Go counterpart of createPinnedLookup and is factored out so tests can call
// the rejection path directly.
func pinnedDialContext(expectedHostname string, addresses []WebhookAddress) func(ctx context.Context, network, address string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		return dialPinnedWebhookAddress(ctx, network, address, expectedHostname, addresses)
	}
}

// dialPinnedWebhookAddress dials only one of the pinned addresses. The
// hostname in address must match the validated hostname; otherwise the request
// is rejected with the createPinnedLookup error text.
func dialPinnedWebhookAddress(ctx context.Context, network, address, expectedHostname string, addresses []WebhookAddress) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("Pinned lookup rejected unexpected hostname: %s", address)
	}
	normalizedHost := strings.ToLower(strings.Trim(host, "[]"))
	if normalizedHost != strings.ToLower(strings.TrimSpace(expectedHostname)) {
		return nil, fmt.Errorf("Pinned lookup rejected unexpected hostname: %s", host)
	}
	dialer := &net.Dialer{}
	var lastErr error
	for _, candidate := range addresses {
		connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.Address, port))
		if dialErr == nil {
			return connection, nil
		}
		lastErr = dialErr
	}
	if lastErr == nil {
		return nil, fmt.Errorf("Pinned lookup has no usable addresses for %s", host)
	}
	return nil, fmt.Errorf("Pinned lookup has no usable addresses for %s: %w", host, lastErr)
}

// postWebhook performs the POST without SSRF validation. It is separated from
// SendAlertWebhook so tests can target an httptest server on loopback, which
// the validator correctly refuses.
func postWebhook(ctx context.Context, client *http.Client, target string, payload AlertWebhookPayload) error {
	if client == nil {
		return errors.New("alert webhook: http client is nil")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("alert webhook: encode payload: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("alert webhook: build request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("alert webhook: send request: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("alert webhook: unexpected HTTP status %d", response.StatusCode)
	}
	return nil
}

// validateWebhookSSRFSync runs the hostname-only checks and returns the NestJS
// reason, or an empty string when the URL passes.
func validateWebhookSSRFSync(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "Invalid URL: " + err.Error()
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "Invalid protocol: " + parsed.Scheme + ":. Only http and https are allowed."
	}
	// URL credentials are deliberately NOT rejected: the NestJS validator reads
	// only protocol, hostname and pathname, so a target with userinfo is a valid
	// target there and the Go port keeps that contract.
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "Empty hostname is not allowed."
	}
	if isWebhookLocalhostVariation(host) {
		return "Localhost is not allowed: " + host
	}
	if isWebhookIPAddress(host) && isPrivateWebhookIP(host) {
		return "Private/internal IP address is not allowed: " + host
	}
	if isCloudMetadataWebhookEndpoint(host, parsed.Path) {
		return "Cloud metadata endpoint is not allowed: " + host
	}
	if decoded, err := url.PathUnescape(host); err == nil && decoded != host &&
		isWebhookIPAddress(decoded) && isPrivateWebhookIP(decoded) {
		return "URL-encoded private IP address is not allowed: " + host
	}
	return ""
}

// isCloudMetadataWebhookEndpoint mirrors isCloudMetadataEndpoint.
func isCloudMetadataWebhookEndpoint(host, path string) bool {
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

// isWebhookLocalhostVariation mirrors isLocalhostVariation.
func isWebhookLocalhostVariation(host string) bool {
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

// isWebhookIPAddress mirrors isIPAddress: a bracketed host is an IPv6 literal.
func isWebhookIPAddress(host string) bool {
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return net.ParseIP(strings.Trim(host, "[]")) != nil
	}
	return net.ParseIP(host) != nil
}

// isPrivateWebhookIP mirrors isPrivateIP. An address that cannot be parsed is
// treated as private, matching the NestJS safety fallback.
func isPrivateWebhookIP(address string) bool {
	parsed := net.ParseIP(strings.Trim(address, "[]"))
	if parsed == nil {
		return true
	}
	if v4 := parsed.To4(); v4 != nil {
		return privateWebhookIPv4(v4)
	}
	return privateWebhookIPv6(parsed.String())
}

// privateWebhookIPv4 mirrors the IPv4 branches of isPrivateIP.
func privateWebhookIPv4(ip net.IP) bool {
	a, b, c := int(ip[0]), int(ip[1]), int(ip[2])
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
	// Multicast and the reserved 240.0.0.0/4 range (this also covers the
	// broadcast address, which the TS checks explicitly).
	return a >= 224
}

// privateWebhookIPv6 mirrors the IPv6 branches of isPrivateIP.
func privateWebhookIPv6(address string) bool {
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
		return isPrivateWebhookIP(strings.TrimPrefix(normalized, "::ffff:"))
	}
	if strings.HasPrefix(normalized, "64:ff9b:") || strings.HasPrefix(normalized, "100:") ||
		strings.HasPrefix(normalized, "2001:db8:") {
		return true
	}
	return false
}
