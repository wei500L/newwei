package crawlreadtelemetry

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// fakeStorageConfigReader is the injected storage configuration reader.
type fakeStorageConfigReader struct {
	config objectstorage.RuntimeConfig
	err    error
}

// StorageRuntimeConfig implements objectstorage.ConfigReader.
func (r fakeStorageConfigReader) StorageRuntimeConfig(context.Context) (objectstorage.RuntimeConfig, error) {
	return r.config, r.err
}

// completeS3Config is a complete S3 snapshot pointing at a fake endpoint.
func completeS3Config() objectstorage.RuntimeConfig {
	return objectstorage.RuntimeConfig{
		Provider:               objectstorage.ProviderS3,
		AccessKeyID:            "test-access-key",
		SecretAccessKey:        "test-secret-key",
		Region:                 "us-east-1",
		Bucket:                 "media-bucket",
		Endpoint:               "http://minio.local:9000",
		PublicBaseURL:          "http://cdn.local/media-bucket",
		ForcePathStyle:         true,
		PresignedURLTTLSeconds: 600,
	}
}

// TestResolveDeliveryMySQLBlobFallback pins the existing MySQL branch: the
// joined CrawlMediaBlob payload wins, then the legacy inline blob, then 404.
func TestResolveDeliveryMySQLBlobFallback(t *testing.T) {
	service := &Service{jwtSecret: testJWTSecret}
	base := crawlMediaDeliveryRecord{
		ID:          "asset-1",
		Provider:    string(CrawlImageStorageProviderMySQL),
		Kind:        "image",
		ContentType: sql.NullString{String: "image/png", Valid: true},
		Bytes:       4,
	}
	joined := base
	joined.JoinedBlob = []byte("join")
	joined.LegacyBlob = []byte("legacy")
	payload, err := service.resolveDelivery(context.Background(), joined, CrawlMediaAccessModePreview)
	if err != nil {
		t.Fatal(err)
	}
	if payload == nil || string(payload.Data) != "join" || payload.Bytes != 4 || payload.RedirectURL != "" {
		t.Fatalf("joined payload = %+v", payload)
	}
	if payload.ContentType != "image/png" || !payload.InlineSafe || payload.FileName != "image-asset-1.png" {
		t.Fatalf("joined metadata = %+v", payload)
	}

	legacy := base
	legacy.LegacyBlob = []byte("legacy-data")
	payload, err = service.resolveDelivery(context.Background(), legacy, CrawlMediaAccessModeDownload)
	if err != nil {
		t.Fatal(err)
	}
	if payload == nil || string(payload.Data) != "legacy-data" {
		t.Fatalf("legacy payload = %+v", payload)
	}

	empty, err := service.resolveDelivery(context.Background(), base, CrawlMediaAccessModeDownload)
	if err != nil {
		t.Fatal(err)
	}
	if empty != nil {
		t.Fatalf("missing payload must resolve to nil, got %+v", empty)
	}
}

// TestResolveDeliveryS3Redirect pins the S3 branch: a 302 redirect target built
// from the record's own storageKey with the signed response parameters and no
// server-side download.
func TestResolveDeliveryS3Redirect(t *testing.T) {
	service := &Service{
		jwtSecret:     testJWTSecret,
		storageConfig: fakeStorageConfigReader{config: completeS3Config()},
	}
	record := crawlMediaDeliveryRecord{
		ID:          "asset-9",
		Provider:    string(CrawlImageStorageProviderS3),
		Kind:        "image",
		ContentType: sql.NullString{String: "image/png", Valid: true},
		Bytes:       1234,
		StorageKey:  sql.NullString{String: "crawl-media/org-1/任务 1+a%b.png", Valid: true},
	}

	preview, err := service.resolveDelivery(context.Background(), record, CrawlMediaAccessModePreview)
	if err != nil {
		t.Fatal(err)
	}
	if preview == nil || preview.RedirectURL == "" {
		t.Fatalf("preview payload = %+v", preview)
	}
	if preview.Data != nil {
		t.Fatal("S3 delivery must not download the media")
	}
	if preview.Bytes != 1234 || preview.ContentType != "image/png" || !preview.InlineSafe {
		t.Fatalf("preview metadata = %+v", preview)
	}
	if preview.FileName != "image-asset-9.png" {
		t.Fatalf("preview file name = %q", preview.FileName)
	}
	parsed, err := url.Parse(preview.RedirectURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != "minio.local:9000" || !strings.HasPrefix(parsed.EscapedPath(), "/media-bucket/") {
		t.Fatalf("presigned target = %s", preview.RedirectURL)
	}
	if !strings.HasSuffix(parsed.Path, "/crawl-media/org-1/任务 1+a%b.png") {
		t.Fatalf("presigned target lost the record key: %q", parsed.Path)
	}
	query := parsed.Query()
	if query.Get("X-Amz-Expires") != "600" {
		t.Fatalf("X-Amz-Expires = %q, want the configured TTL", query.Get("X-Amz-Expires"))
	}
	if query.Get("X-Amz-Signature") == "" {
		t.Fatal("redirect target is not signed")
	}
	if got := query.Get("response-content-disposition"); got != `inline; filename="image-asset-9.png"` {
		t.Fatalf("preview disposition = %q", got)
	}
	if got := query.Get("response-cache-control"); got != "private, max-age=300" {
		t.Fatalf("cache control = %q", got)
	}

	download, err := service.resolveDelivery(context.Background(), record, CrawlMediaAccessModeDownload)
	if err != nil {
		t.Fatal(err)
	}
	downloadQuery, err := url.Parse(download.RedirectURL)
	if err != nil {
		t.Fatal(err)
	}
	if got := downloadQuery.Query().Get("response-content-disposition"); got != `attachment; filename="image-asset-9.png"` {
		t.Fatalf("download disposition = %q", got)
	}
}

// TestResolveDeliveryS3SVGStaysAttachment pins the inline allow list: SVG is
// served as an attachment even in preview mode.
func TestResolveDeliveryS3SVGStaysAttachment(t *testing.T) {
	service := &Service{
		jwtSecret:     testJWTSecret,
		storageConfig: fakeStorageConfigReader{config: completeS3Config()},
	}
	record := crawlMediaDeliveryRecord{
		ID:          "asset-3",
		Provider:    string(CrawlImageStorageProviderS3),
		Kind:        "image",
		ContentType: sql.NullString{String: "image/svg+xml", Valid: true},
		Bytes:       10,
		StorageKey:  sql.NullString{String: "crawl-media/org-1/asset.svg", Valid: true},
	}
	payload, err := service.resolveDelivery(context.Background(), record, CrawlMediaAccessModePreview)
	if err != nil {
		t.Fatal(err)
	}
	if payload == nil || payload.InlineSafe {
		t.Fatalf("svg payload = %+v", payload)
	}
	parsed, err := url.Parse(payload.RedirectURL)
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Query().Get("response-content-disposition"); got != `attachment; filename="image-asset-3.svg"` {
		t.Fatalf("svg disposition = %q", got)
	}
}

// TestResolveDeliveryS3MissingKeyAndIncompleteConfig pins the two failure
// contracts: a record without a storage key is "not found", while an incomplete
// configuration is a 400 and never a fake 404.
func TestResolveDeliveryS3MissingKeyAndIncompleteConfig(t *testing.T) {
	service := &Service{
		jwtSecret:     testJWTSecret,
		storageConfig: fakeStorageConfigReader{config: completeS3Config()},
	}
	noKey := crawlMediaDeliveryRecord{
		ID:          "asset-4",
		Provider:    string(CrawlImageStorageProviderS3),
		Kind:        "file",
		ContentType: sql.NullString{String: "application/pdf", Valid: true},
	}
	payload, err := service.resolveDelivery(context.Background(), noKey, CrawlMediaAccessModeDownload)
	if err != nil || payload != nil {
		t.Fatalf("missing storage key = %+v / %v", payload, err)
	}

	incomplete := completeS3Config()
	incomplete.SecretAccessKey = ""
	broken := &Service{
		jwtSecret:     testJWTSecret,
		storageConfig: fakeStorageConfigReader{config: incomplete},
	}
	withKey := noKey
	withKey.StorageKey = sql.NullString{String: "crawl-media/org-1/file.pdf", Valid: true}
	payload, err = broken.resolveDelivery(context.Background(), withKey, CrawlMediaAccessModeDownload)
	if payload != nil {
		t.Fatalf("incomplete configuration produced a payload: %+v", payload)
	}
	var status *statusError
	if !errors.As(err, &status) || status.status != 400 || status.message != "Storage configuration is incomplete" {
		t.Fatalf("incomplete configuration error = %v", err)
	}

	// An unreadable configuration keeps the existing service error semantics
	// (generic 500) instead of pretending the asset does not exist.
	readFailure := errors.New("redis and mysql unavailable")
	unreadable := &Service{
		jwtSecret:     testJWTSecret,
		storageConfig: fakeStorageConfigReader{err: readFailure},
	}
	payload, err = unreadable.resolveDelivery(context.Background(), withKey, CrawlMediaAccessModeDownload)
	if payload != nil {
		t.Fatalf("unreadable configuration produced a payload: %+v", payload)
	}
	if !errors.Is(err, readFailure) {
		t.Fatalf("unreadable configuration error = %v", err)
	}
	var notStatus *statusError
	if errors.As(err, &notStatus) {
		t.Fatalf("unreadable configuration must keep the service error, got %v", err)
	}
}

// TestStorageSigningContextUsesSnapshotTTL pins the TTL fix: the detail path
// reads the whole configuration snapshot, so the environment TTL fallback and
// the 30..86400 clamp both apply, and one snapshot serves one detail request.
func TestStorageSigningContextUsesSnapshotTTL(t *testing.T) {
	cases := []struct {
		name     string
		snapshot objectstorage.RuntimeConfig
		want     int
	}{
		{"configured ttl", completeS3Config(), 600},
		{"clamped low", func() objectstorage.RuntimeConfig {
			config := completeS3Config()
			config.PresignedURLTTLSeconds = 5
			return config
		}(), minSignedURLTTLSeconds},
		{"clamped high", func() objectstorage.RuntimeConfig {
			config := completeS3Config()
			config.PresignedURLTTLSeconds = 100000
			return config
		}(), maxSignedURLTTLSeconds},
		{"env fallback ttl", func() objectstorage.RuntimeConfig {
			config := completeS3Config()
			config.PresignedURLTTLSeconds = 900
			return config
		}(), 900},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := &Service{
				jwtSecret:     testJWTSecret,
				storageConfig: fakeStorageConfigReader{config: tc.snapshot},
			}
			ttl, client := service.storageSigningContext(context.Background())
			if ttl != tc.want {
				t.Fatalf("ttl = %d, want %d", ttl, tc.want)
			}
			if client == nil {
				t.Fatal("a complete snapshot must yield a signing client")
			}
		})
	}

	// A readable but incomplete snapshot still yields the TTL so the MySQL/HMAC
	// URLs of the same response keep working, but no S3 client.
	incomplete := completeS3Config()
	incomplete.Bucket = ""
	service := &Service{
		jwtSecret:     testJWTSecret,
		storageConfig: fakeStorageConfigReader{config: incomplete},
	}
	ttl, client := service.storageSigningContext(context.Background())
	if ttl != 600 || client != nil {
		t.Fatalf("incomplete snapshot = ttl %d client %v", ttl, client)
	}

	// A configuration read failure keeps the NestJS default and disables S3
	// signing.
	failing := &Service{
		jwtSecret:     testJWTSecret,
		storageConfig: fakeStorageConfigReader{err: errors.New("settings read failed")},
	}
	ttl, client = failing.storageSigningContext(context.Background())
	if ttl != defaultSignedURLTTLSeconds || client != nil {
		t.Fatalf("failed snapshot = ttl %d client %v", ttl, client)
	}

	// Without any injected reader the TTL still falls back to the default.
	bare := &Service{jwtSecret: testJWTSecret}
	ttl, client = bare.storageSigningContext(context.Background())
	if ttl != defaultSignedURLTTLSeconds || client != nil {
		t.Fatalf("missing reader = ttl %d client %v", ttl, client)
	}
}

// TestBuildStoredMediaAssetS3SignsPerMode pins the detail projection: the S3
// asset is signed from its own storageKey, preview only when inline-safe, and
// a signing failure omits the URL without dropping the asset.
func TestBuildStoredMediaAssetS3SignsPerMode(t *testing.T) {
	service := &Service{jwtSecret: testJWTSecret}
	client, err := objectstorage.NewClient(completeS3Config())
	if err != nil {
		t.Fatal(err)
	}
	row := crawlMediaAssetRow{
		ID:          "asset-7",
		ResultID:    "result-1",
		Provider:    string(CrawlImageStorageProviderS3),
		Kind:        "image",
		SourceURL:   "https://example.test/a.png",
		Bytes:       2048,
		ContentType: sql.NullString{String: "image/png", Valid: true},
		StorageKey:  sql.NullString{String: "crawl-media/org-1/asset-7.png", Valid: true},
	}
	asset := service.buildStoredMediaAsset(context.Background(), row, 0, "org-1", "user-1", 300, client)
	if asset.StorageProvider != CrawlImageStorageProviderS3 || asset.StorageKey == nil || *asset.StorageKey != "crawl-media/org-1/asset-7.png" {
		t.Fatalf("asset identity = %+v", asset)
	}
	if asset.PreviewURL == nil || asset.DownloadURL == nil {
		t.Fatalf("S3 urls missing: %+v", asset)
	}
	previewQuery, err := url.Parse(*asset.PreviewURL)
	if err != nil {
		t.Fatal(err)
	}
	if previewQuery.Query().Get("X-Amz-Expires") != "300" {
		t.Fatalf("preview expires = %q", previewQuery.Query().Get("X-Amz-Expires"))
	}
	if got := previewQuery.Query().Get("response-content-disposition"); got != `inline; filename="image-asset-7.png"` {
		t.Fatalf("preview disposition = %q", got)
	}
	downloadQuery, err := url.Parse(*asset.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	if got := downloadQuery.Query().Get("response-content-disposition"); got != `attachment; filename="image-asset-7.png"` {
		t.Fatalf("download disposition = %q", got)
	}

	// SVG keeps its download URL and gets no inline preview.
	svgRow := row
	svgRow.ContentType = sql.NullString{String: "image/svg+xml", Valid: true}
	svg := service.buildStoredMediaAsset(context.Background(), svgRow, 0, "org-1", "user-1", 300, client)
	if svg.PreviewURL != nil || svg.DownloadURL == nil {
		t.Fatalf("svg asset = %+v", svg)
	}

	// No client (incomplete or unreadable configuration): both URLs are omitted
	// and the asset is still returned with its identity.
	unsigned := service.buildStoredMediaAsset(context.Background(), row, 0, "org-1", "user-1", 300, nil)
	if unsigned.PreviewURL != nil || unsigned.DownloadURL != nil {
		t.Fatalf("unsigned asset = %+v", unsigned)
	}
	if unsigned.ID != row.ID || unsigned.StorageKey == nil {
		t.Fatalf("unsigned asset lost its identity: %+v", unsigned)
	}

	// A record without its own storage key never gets a fabricated URL.
	noKey := row
	noKey.StorageKey = sql.NullString{}
	keyless := service.buildStoredMediaAsset(context.Background(), noKey, 0, "org-1", "user-1", 300, client)
	if keyless.PreviewURL != nil || keyless.DownloadURL != nil || keyless.StorageKey != nil {
		t.Fatalf("keyless asset = %+v", keyless)
	}
}

// TestBuildStoredMediaAssetMySQLKeepsHMAC pins the existing MySQL projection:
// HMAC URLs (no S3 client involved) and an unknown provider stays URL-less.
func TestBuildStoredMediaAssetMySQLKeepsHMAC(t *testing.T) {
	service := &Service{jwtSecret: testJWTSecret}
	row := crawlMediaAssetRow{
		ID:          "asset-8",
		ResultID:    "result-1",
		Provider:    string(CrawlImageStorageProviderMySQL),
		Kind:        "image",
		Bytes:       10,
		ContentType: sql.NullString{String: "image/png", Valid: true},
	}
	expiresAtMs := int64(1_700_000_000_000)
	asset := service.buildStoredMediaAsset(context.Background(), row, expiresAtMs, "org-1", "user-1", 300, nil)
	if asset.PreviewURL == nil || asset.DownloadURL == nil {
		t.Fatalf("mysql urls missing: %+v", asset)
	}
	if !strings.HasPrefix(*asset.PreviewURL, crawlMediaAssetsPrefix+"asset-8/preview?") {
		t.Fatalf("preview url = %q", *asset.PreviewURL)
	}
	if !strings.HasPrefix(*asset.DownloadURL, crawlMediaAssetsPrefix+"asset-8/download?") {
		t.Fatalf("download url = %q", *asset.DownloadURL)
	}

	unknown := row
	unknown.Provider = "other"
	asset = service.buildStoredMediaAsset(context.Background(), unknown, expiresAtMs, "org-1", "user-1", 300, nil)
	if asset.PreviewURL != nil || asset.DownloadURL != nil {
		t.Fatalf("unknown provider asset = %+v", asset)
	}
}

// TestNewServiceWiresStorageConfig pins the REST-side injection: the handler
// constructor receives the shared runtime storage configuration reader and the
// service exposes it.
func TestNewServiceWiresStorageConfig(t *testing.T) {
	service := NewService(nil, nil, nil, testJWTSecret, fakeStorageConfigReader{config: completeS3Config()})
	if !service.StorageReaderConfigured() {
		t.Fatal("NewService must store the injected storage reader")
	}
	if bare := NewService(nil, nil, nil, testJWTSecret, nil); bare.StorageReaderConfigured() {
		t.Fatal("a nil reader must stay unconfigured")
	}
}
