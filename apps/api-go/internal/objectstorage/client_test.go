package objectstorage

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// testConfig is a complete snapshot pointing at a fake S3-compatible endpoint.
func testConfig() RuntimeConfig {
	return RuntimeConfig{
		Provider:               ProviderS3,
		AccessKeyID:            "test-access-key",
		SecretAccessKey:        "test-secret-key",
		Region:                 "us-east-1",
		Bucket:                 "my-bucket",
		Endpoint:               "http://minio.local:9000",
		PublicBaseURL:          "http://cdn.local/my-bucket/",
		ForcePathStyle:         true,
		PresignedURLTTLSeconds: 300,
	}
}

// TestNewClientRejectsIncompleteConfig pins the refreshClient completeness
// condition: any missing member fails closed with ErrIncompleteConfig.
func TestNewClientRejectsIncompleteConfig(t *testing.T) {
	complete := testConfig()
	if _, err := NewClient(complete); err != nil {
		t.Fatalf("complete config rejected: %v", err)
	}
	cases := []struct {
		name   string
		mutate func(*RuntimeConfig)
	}{
		{"missing access key", func(c *RuntimeConfig) { c.AccessKeyID = "" }},
		{"missing secret", func(c *RuntimeConfig) { c.SecretAccessKey = "" }},
		{"missing bucket", func(c *RuntimeConfig) { c.Bucket = "" }},
		{"missing public base url", func(c *RuntimeConfig) { c.PublicBaseURL = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig()
			tc.mutate(&cfg)
			if _, err := NewClient(cfg); !errors.Is(err, ErrIncompleteConfig) {
				t.Fatalf("NewClient error = %v, want ErrIncompleteConfig", err)
			}
		})
	}
	if IncompleteConfigText != "BadRequestException: Storage configuration is incomplete" {
		t.Fatalf("IncompleteConfigText = %q", IncompleteConfigText)
	}
}

// TestEffectiveTTLSeconds pins the createObjectReadUrl TTL rules: an explicit
// positive TTL is floored and raised to 30s, anything else uses the configured
// TTL unchanged.
func TestEffectiveTTLSeconds(t *testing.T) {
	cfg := testConfig()
	cfg.PresignedURLTTLSeconds = 300
	zero, negative, ten, long := 0, -5, 10, 900
	cases := []struct {
		name string
		opts ReadURLOptions
		want float64
	}{
		{"absent uses config", ReadURLOptions{}, 300},
		{"explicit zero uses config", ReadURLOptions{ExpiresInSeconds: &zero}, 300},
		{"negative uses config", ReadURLOptions{ExpiresInSeconds: &negative}, 300},
		{"positive below floor is raised", ReadURLOptions{ExpiresInSeconds: &ten}, MinExplicitTTLSeconds},
		{"positive above floor is kept", ReadURLOptions{ExpiresInSeconds: &long}, 900},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cfg.effectiveTTLSeconds(tc.opts); got != tc.want {
				t.Fatalf("effectiveTTLSeconds = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestPresignExpiry covers the duration conversion, including the non-positive
// values that leave the SDK default in place.
func TestPresignExpiry(t *testing.T) {
	cases := map[float64]time.Duration{
		0:     0,
		-1:    0,
		300:   300 * time.Second,
		300.9: 300 * time.Second,
		86400: 86400 * time.Second,
	}
	for value, want := range cases {
		if got := presignExpiry(value); got != want {
			t.Fatalf("presignExpiry(%v) = %v, want %v", value, got, want)
		}
	}
}

// TestCreateObjectReadURLSignsEndpointPathStyleAndResponseParams verifies the
// presigned URL without any network round trip: the custom endpoint, the
// path-style switch and every response-* parameter are part of the signature.
func TestCreateObjectReadURLSignsEndpointPathStyleAndResponseParams(t *testing.T) {
	client, err := NewClient(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := client.CreateObjectReadURL(context.Background(), "crawl-media/org-1/task-1/asset-1.png", ReadURLOptions{
		ResponseContentType:        "image/png",
		ResponseContentDisposition: `inline; filename="image-asset-1.png"`,
		ResponseCacheControl:       "private, max-age=300",
	})
	if err != nil {
		t.Fatalf("CreateObjectReadURL: %v", err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("presigned url does not parse: %v", err)
	}
	if parsed.Scheme != "http" || parsed.Host != "minio.local:9000" {
		t.Fatalf("endpoint not honoured: %s", raw)
	}
	if !strings.HasPrefix(parsed.EscapedPath(), "/my-bucket/") {
		t.Fatalf("path style not honoured: %s", parsed.EscapedPath())
	}
	query := parsed.Query()
	if got := query.Get("X-Amz-Expires"); got != "300" {
		t.Fatalf("X-Amz-Expires = %q, want 300", got)
	}
	if query.Get("X-Amz-Signature") == "" {
		t.Fatalf("unsigned url: %s", raw)
	}
	if got := query.Get("response-content-type"); got != "image/png" {
		t.Fatalf("response-content-type = %q", got)
	}
	if got := query.Get("response-content-disposition"); got != `inline; filename="image-asset-1.png"` {
		t.Fatalf("response-content-disposition = %q", got)
	}
	if got := query.Get("response-cache-control"); got != "private, max-age=300" {
		t.Fatalf("response-cache-control = %q", got)
	}
}

// TestCreateObjectReadURLExplicitTTLOverridesConfig pins the 30..N explicit TTL
// rule through the signature.
func TestCreateObjectReadURLExplicitTTLOverridesConfig(t *testing.T) {
	client, err := NewClient(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	short := 10
	raw, err := client.CreateObjectReadURL(context.Background(), "k.png", ReadURLOptions{ExpiresInSeconds: &short})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Query().Get("X-Amz-Expires"); got != "30" {
		t.Fatalf("X-Amz-Expires = %q, want 30", got)
	}
}

// TestCreateObjectReadURLUsesVirtualHostWhenPathStyleIsOff pins the addressing
// switch: the bucket moves from the path into the host prefix.
func TestCreateObjectReadURLUsesVirtualHostWhenPathStyleIsOff(t *testing.T) {
	cfg := testConfig()
	cfg.ForcePathStyle = false
	client, err := NewClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := client.CreateObjectReadURL(context.Background(), "asset.png", ReadURLOptions{})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(parsed.Host, "my-bucket.") {
		t.Fatalf("virtual-host style not honoured: %s", parsed.Host)
	}
	if strings.HasPrefix(parsed.EscapedPath(), "/my-bucket/") {
		t.Fatalf("unexpected path-style bucket segment: %s", parsed.EscapedPath())
	}
}

// TestCreateObjectReadURLEncodesKeyOnce covers the storageKey contract: Chinese
// characters, spaces, plus signs, percent signs and slashes are encoded exactly
// once by the SDK and never re-escaped by this package.
func TestCreateObjectReadURLEncodesKeyOnce(t *testing.T) {
	client, err := NewClient(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	key := "crawl-media/org-1/任务 1+a%b.png"
	raw, err := client.CreateObjectReadURL(context.Background(), key, ReadURLOptions{})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(parsed.Path, "/"+key) {
		t.Fatalf("decoded key mismatch: %q", parsed.Path)
	}
	escaped := parsed.EscapedPath()
	// The decoded path above already proves the key survives a single
	// percent-encoding round trip; the escaped form must at least carry the
	// percent-encoded Chinese characters and must never be escaped twice.
	if !strings.Contains(escaped, "%E4%BB%BB%E5%8A%A1") {
		t.Fatalf("Chinese characters not percent-encoded: %s", escaped)
	}
	if strings.Contains(escaped, "%2525") {
		t.Fatalf("key was double-escaped: %s", escaped)
	}
}

// TestCheckResultFormatsAPIErrors pins the formatAwsError mapping, the HTTP
// status and the request id extraction.
func TestCheckResultFormatsAPIErrors(t *testing.T) {
	if got := checkResult(nil); !got.OK || got.Error != "" || got.HTTPStatusCode != nil || got.RequestID != nil {
		t.Fatalf("successful check = %+v", got)
	}
	apiErr := &smithy.GenericAPIError{Code: "NoSuchBucket", Message: "The specified bucket does not exist"}
	wrapped := &smithyhttp.ResponseError{
		Response: &smithyhttp.Response{Response: &http.Response{
			StatusCode: http.StatusNotFound,
			Header:     http.Header{"x-amz-request-id": []string{"req-42"}},
		}},
		Err: apiErr,
	}
	failed := checkResult(wrapped)
	if failed.OK {
		t.Fatal("failed check reported ok")
	}
	if failed.Error != "NoSuchBucket: The specified bucket does not exist" {
		t.Fatalf("error text = %q", failed.Error)
	}
	if failed.HTTPStatusCode == nil || *failed.HTTPStatusCode != http.StatusNotFound {
		t.Fatalf("status = %v", failed.HTTPStatusCode)
	}
	if failed.RequestID == nil || *failed.RequestID != "req-42" {
		t.Fatalf("request id = %v", failed.RequestID)
	}

	// A transport-level failure has neither a status nor a request id and
	// keeps the generic "Error" name.
	plain := checkResult(errors.New("dial tcp 127.0.0.1:9000: connect: connection refused"))
	if plain.HTTPStatusCode != nil || plain.RequestID != nil {
		t.Fatalf("transport failure = %+v", plain)
	}
	if !strings.HasPrefix(plain.Error, "Error: ") {
		t.Fatalf("transport error text = %q", plain.Error)
	}
}

// TestNormalizedPublicBaseURL pins the single trailing-slash removal.
func TestNormalizedPublicBaseURL(t *testing.T) {
	cfg := RuntimeConfig{PublicBaseURL: "http://cdn.local/bucket/"}
	if got := cfg.NormalizedPublicBaseURL(); got != "http://cdn.local/bucket" {
		t.Fatalf("NormalizedPublicBaseURL = %q", got)
	}
}
