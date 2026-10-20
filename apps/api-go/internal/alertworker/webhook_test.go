package alertworker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// newSampleAlertWebhookPayload is reused by the POST tests.
func newSampleAlertWebhookPayload() AlertWebhookPayload {
	threshold := 90.0
	message := "cpu above threshold"
	return AlertWebhookPayload{
		AlertID:      "evt_123",
		RuleName:     "CPU 高负载",
		Metric:       "cpu_usage",
		CurrentValue: 95.5,
		Threshold:    &threshold,
		TriggeredAt:  "2026-10-20T00:00:00.000Z",
		Severity:     "critical",
		Operator:     "GT",
		Message:      &message,
	}
}

// TestBuildAlertWebhookPayload checks the JSON keys and the threshold
// pass-through, including a zero threshold (which must not become null).
func TestBuildAlertWebhookPayload(t *testing.T) {
	threshold := 0.0
	message := "详情"
	payload := BuildAlertWebhookPayload(AlertWebhookInput{
		EventID:      "evt_1",
		RuleName:     "rule-a",
		Metric:       "cpu_usage",
		TriggeredAt:  "2026-10-20T00:00:00.000Z",
		Severity:     "warning",
		Operator:     "LTE",
		CurrentValue: 0.30000000000000004,
		Threshold:    &threshold,
		Message:      &message,
	})
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	assertAlertJSONValue(t, decoded, "alertId", "evt_1")
	assertAlertJSONValue(t, decoded, "ruleName", "rule-a")
	assertAlertJSONValue(t, decoded, "metric", "cpu_usage")
	assertAlertJSONValue(t, decoded, "currentValue", 0.30000000000000004)
	assertAlertJSONValue(t, decoded, "threshold", 0.0)
	assertAlertJSONValue(t, decoded, "triggeredAt", "2026-10-20T00:00:00.000Z")
	assertAlertJSONValue(t, decoded, "severity", "warning")
	assertAlertJSONValue(t, decoded, "operator", "LTE")
	assertAlertJSONValue(t, decoded, "message", "详情")

	// A nil threshold and message must still be present as JSON null, matching
	// the NestJS object literal (no undefined pruning).
	nullPayload := BuildAlertWebhookPayload(AlertWebhookInput{EventID: "evt_2"})
	nullBody, err := json.Marshal(nullPayload)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	compact := string(nullBody)
	if !strings.Contains(compact, `"threshold":null`) {
		t.Fatalf("payload %s does not contain a null threshold", compact)
	}
	if !strings.Contains(compact, `"message":null`) {
		t.Fatalf("payload %s does not contain a null message", compact)
	}
}

// assertAlertJSONValue compares one decoded JSON field.
func assertAlertJSONValue(t *testing.T, decoded map[string]any, key string, want any) {
	t.Helper()
	got, ok := decoded[key]
	if !ok {
		t.Fatalf("payload is missing %q: %v", key, decoded)
	}
	if got != want {
		t.Fatalf("payload[%q] = %#v, want %#v", key, got, want)
	}
}

// TestResolveSafeWebhookTargetRejections pins the exact SSRF error text that
// createWebhookTargetError produces.
func TestResolveSafeWebhookTargetRejections(t *testing.T) {
	cases := []struct {
		name   string
		target string
		want   string
	}{
		{
			name:   "loopback ip",
			target: "http://127.0.0.1/x",
			want:   "Unsafe webhook target: Localhost is not allowed: 127.0.0.1",
		},
		{
			name:   "localhost",
			target: "http://localhost/x",
			want:   "Unsafe webhook target: Localhost is not allowed: localhost",
		},
		{
			name:   "link local metadata ip",
			target: "http://169.254.169.254/latest",
			want:   "Unsafe webhook target: Private/internal IP address is not allowed: 169.254.169.254",
		},
		{
			name:   "rfc1918",
			target: "http://10.0.0.1/",
			want:   "Unsafe webhook target: Private/internal IP address is not allowed: 10.0.0.1",
		},
		{
			name:   "file scheme",
			target: "file:///etc/passwd",
			want:   "Unsafe webhook target: Invalid protocol: file:. Only http and https are allowed.",
		},
		{
			// The NestJS validator never inspects userinfo, so credentials alone do
			// not make a target unsafe: this case must fail on DNS, not on the URL.
			name:   "url credentials do not fail the URL checks",
			target: "http://user:pass@alert-webhook.invalid/",
			want:   "Unsafe webhook target: Hostname alert-webhook.invalid could not be resolved",
		},
		{
			name:   "cloud metadata hostname",
			target: "http://metadata.google.internal/computeMetadata/v1/",
			want:   "Unsafe webhook target: Cloud metadata endpoint is not allowed: metadata.google.internal",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := ResolveSafeWebhookTarget(context.Background(), testCase.target)
			if err == nil {
				t.Fatalf("ResolveSafeWebhookTarget(%q) returned no error", testCase.target)
			}
			if got := err.Error(); got != testCase.want {
				t.Fatalf("error = %q, want %q", got, testCase.want)
			}
			var targetErr *WebhookTargetError
			if !errors.As(err, &targetErr) {
				t.Fatalf("error %T is not *WebhookTargetError", err)
			}
		})
	}
}

// TestResolveSafeWebhookTargetPublicIPLiteral checks the literal-IP branch,
// which is accepted without DNS. No connection is made.
func TestResolveSafeWebhookTargetPublicIPLiteral(t *testing.T) {
	target, err := ResolveSafeWebhookTarget(context.Background(), "http://93.184.216.34/hook")
	if err != nil {
		t.Fatalf("ResolveSafeWebhookTarget() error = %v", err)
	}
	if target.URL != "http://93.184.216.34/hook" {
		t.Fatalf("URL = %q", target.URL)
	}
	if target.Hostname != "93.184.216.34" {
		t.Fatalf("Hostname = %q", target.Hostname)
	}
	if len(target.Addresses) != 1 || target.Addresses[0] != (WebhookAddress{Address: "93.184.216.34", Family: 4}) {
		t.Fatalf("Addresses = %#v", target.Addresses)
	}

	ipv6Target, err := ResolveSafeWebhookTarget(context.Background(), "https://[2606:4700:4700::1111]/hook")
	if err != nil {
		t.Fatalf("ResolveSafeWebhookTarget(ipv6) error = %v", err)
	}
	if len(ipv6Target.Addresses) != 1 || ipv6Target.Addresses[0].Family != 6 {
		t.Fatalf("IPv6 Addresses = %#v", ipv6Target.Addresses)
	}
}

// TestResolveSafeWebhookTargetUnresolvable covers allowUnresolved=false on the
// runtime path. The .invalid TLD is reserved by RFC 2606 and never resolves.
func TestResolveSafeWebhookTargetUnresolvable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := ResolveSafeWebhookTarget(ctx, "https://does-not-exist.invalid/hook")
	if err == nil {
		t.Fatal("ResolveSafeWebhookTarget() returned no error for .invalid")
	}
	if !strings.HasPrefix(err.Error(), "Unsafe webhook target") {
		t.Fatalf("error = %q, want the Unsafe webhook target prefix", err.Error())
	}
	if !strings.Contains(err.Error(), "could not be resolved") {
		t.Fatalf("error = %q, want an unresolved-hostname reason", err.Error())
	}
}

// TestPinnedDialRejectsUnexpectedHostname exercises createPinnedLookup's
// hostname guard directly, without any network access.
func TestPinnedDialRejectsUnexpectedHostname(t *testing.T) {
	dial := pinnedDialContext("hooks.example.com", []WebhookAddress{{Address: "93.184.216.34", Family: 4}})
	_, err := dial(context.Background(), "tcp", "evil.example.com:443")
	if err == nil {
		t.Fatal("pinned dialer accepted an unexpected hostname")
	}
	want := "Pinned lookup rejected unexpected hostname: evil.example.com"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}

	empty := pinnedDialContext("hooks.example.com", nil)
	_, err = empty(context.Background(), "tcp", "hooks.example.com:443")
	if err == nil {
		t.Fatal("pinned dialer accepted an empty address list")
	}
	if !strings.Contains(err.Error(), "no usable addresses") {
		t.Fatalf("error = %q, want a no-usable-addresses reason", err.Error())
	}
}

// TestDialWithoutPinnedTarget documents the fail-closed transport hook.
func TestDialWithoutPinnedTarget(t *testing.T) {
	_, err := dialPinnedWebhookTarget(context.Background(), "tcp", "127.0.0.1:80")
	if err == nil {
		t.Fatal("dialer accepted a request without a pinned target")
	}
	if !strings.Contains(err.Error(), "no validated target") {
		t.Fatalf("error = %q", err.Error())
	}
}

// TestPostWebhookSuccess asserts the POST method, Content-Type and JSON body.
func TestPostWebhookSuccess(t *testing.T) {
	type capturedRequest struct {
		method      string
		contentType string
		body        []byte
	}
	captured := make(chan capturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		captured <- capturedRequest{
			method:      request.Method,
			contentType: request.Header.Get("Content-Type"),
			body:        body,
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := &http.Client{Timeout: 2 * time.Second}
	payload := newSampleAlertWebhookPayload()
	if err := postWebhook(context.Background(), client, server.URL+"/hook", payload); err != nil {
		t.Fatalf("postWebhook() error = %v", err)
	}
	request := <-captured
	if request.method != http.MethodPost {
		t.Fatalf("method = %q, want POST", request.method)
	}
	if request.contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", request.contentType)
	}
	var decoded map[string]any
	if err := json.Unmarshal(request.body, &decoded); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	assertAlertJSONValue(t, decoded, "alertId", "evt_123")
	assertAlertJSONValue(t, decoded, "ruleName", "CPU 高负载")
	assertAlertJSONValue(t, decoded, "currentValue", 95.5)
	assertAlertJSONValue(t, decoded, "threshold", 90.0)
}

// TestPostWebhookNon2xx treats every non-2xx response as a delivery failure.
func TestPostWebhookNon2xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := &http.Client{Timeout: 2 * time.Second}
	err := postWebhook(context.Background(), client, server.URL, newSampleAlertWebhookPayload())
	if err == nil {
		t.Fatal("postWebhook() accepted a 500 response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("error = %q, want the HTTP status", err.Error())
	}
}

// TestPostWebhookTimeout verifies the caller's client timeout is not swallowed.
func TestPostWebhookTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := &http.Client{Timeout: 20 * time.Millisecond}
	if err := postWebhook(context.Background(), client, server.URL, newSampleAlertWebhookPayload()); err == nil {
		t.Fatal("postWebhook() ignored the client timeout")
	}
}

// TestPostWebhookNilClient is a guardrail for the exported send path.
func TestPostWebhookNilClient(t *testing.T) {
	if err := postWebhook(context.Background(), nil, "http://example.com/", newSampleAlertWebhookPayload()); err == nil {
		t.Fatal("postWebhook() accepted a nil client")
	}
}

// TestPostWebhookPinnedClient exercises the context-to-dialer pin end to end
// against loopback. This bypasses SSRF validation deliberately; the validator
// itself is covered above. It also proves net/http retains request context
// values for DialContext.
func TestPostWebhookPinnedClient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	target := ResolvedWebhookTarget{
		URL:      server.URL,
		Hostname: parsed.Hostname(),
		Addresses: []WebhookAddress{
			{Address: parsed.Hostname(), Family: 4},
		},
	}
	ctx := withPinnedWebhookTarget(context.Background(), target)
	client := NewPinnedHTTPClient(2 * time.Second)
	if err := postWebhook(ctx, client, server.URL, newSampleAlertWebhookPayload()); err != nil {
		t.Fatalf("pinned postWebhook() error = %v", err)
	}
}

// TestSendAlertWebhookRejectsLoopback ensures the exported send path validates
// before dialing.
func TestSendAlertWebhookRejectsLoopback(t *testing.T) {
	client := NewPinnedHTTPClient(time.Second)
	err := SendAlertWebhook(context.Background(), client, "http://127.0.0.1:8080/hook", newSampleAlertWebhookPayload())
	if err == nil {
		t.Fatal("SendAlertWebhook() accepted a loopback target")
	}
	want := "Unsafe webhook target: Localhost is not allowed: 127.0.0.1"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
}

// TestNewPinnedHTTPClientConfiguration pins the no-redirect and no-keep-alive
// contract.
func TestNewPinnedHTTPClientConfiguration(t *testing.T) {
	client := NewPinnedHTTPClient(3 * time.Second)
	if client.Timeout != 3*time.Second {
		t.Fatalf("Timeout = %v", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport = %T, want *http.Transport", client.Transport)
	}
	if !transport.DisableKeepAlives {
		t.Fatal("DisableKeepAlives = false, want true")
	}
	if transport.Proxy != nil {
		t.Fatal("Transport uses a proxy, want direct connections")
	}
	request, err := http.NewRequest(http.MethodGet, "http://example.com/", nil)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	if err := client.CheckRedirect(request, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("CheckRedirect() = %v, want http.ErrUseLastResponse", err)
	}
}
