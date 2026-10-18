package infrastructuresettings

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// storageTestEnv are the environment defaults used by the diagnostics tests.
func storageTestEnv() Config {
	return Config{
		S3AccessKeyID:            "env-access-key",
		S3SecretAccessKey:        "env-secret-key",
		S3Region:                 "us-east-1",
		S3Bucket:                 "env-bucket",
		S3Endpoint:               "",
		S3PublicBaseURL:          "http://env-cdn/env-bucket",
		S3ForcePathStyle:         false,
		S3PresignedURLTTLSeconds: 900,
	}
}

// s3StorageSettings seeds the nine storage rows with a complete S3 setup.
func s3StorageSettings() map[string]string {
	return map[string]string{
		settingKeyCrawlImageStorage:       `"s3"`,
		settingKeyS3AccessKeyID:           `"db-access-key"`,
		settingKeyS3SecretAccessKey:       `"db-secret-key"`,
		settingKeyS3Region:                `"eu-central-1"`,
		settingKeyS3Bucket:                `"db-bucket"`,
		settingKeyS3Endpoint:              `"http://minio.local:9000"`,
		settingKeyS3PublicBaseURL:         `"http://cdn.local/db-bucket/"`,
		settingKeyS3ForcePathStyle:        `true`,
		settingKeyS3PresignedURLTTLSecond: `600`,
	}
}

// fakeStorageProbe records the three diagnostic calls.
type fakeStorageProbe struct {
	head, put, deleted objectstorage.CheckResult

	headCalls   int
	putKeys     []string
	putBodies   []string
	putTypes    []string
	putCaches   []string
	deletedKeys []string
}

func (p *fakeStorageProbe) HeadBucket(context.Context) objectstorage.CheckResult {
	p.headCalls++
	return p.head
}

func (p *fakeStorageProbe) PutObject(_ context.Context, objectKey, body, contentType, cacheControl string) objectstorage.CheckResult {
	p.putKeys = append(p.putKeys, objectKey)
	p.putBodies = append(p.putBodies, body)
	p.putTypes = append(p.putTypes, contentType)
	p.putCaches = append(p.putCaches, cacheControl)
	return p.put
}

func (p *fakeStorageProbe) DeleteObject(_ context.Context, objectKey string) objectstorage.CheckResult {
	p.deletedKeys = append(p.deletedKeys, objectKey)
	return p.deleted
}

// newDiagnosticsHandler builds a handler over the fake store with an injected
// probe.
func newDiagnosticsHandler(t *testing.T, settings map[string]string, probe storageProbe) (*StorageDiagnosticsHandler, *fakeMySQL) {
	t.Helper()
	store := newFakeMySQL(settings)
	service := NewService(store.db(), nil, storageTestEnv())
	handler := NewStorageDiagnosticsHandler(nil, service)
	handler.probeFactory = func(objectstorage.RuntimeConfig) (storageProbe, error) { return probe, nil }
	return handler, store
}

// TestStorageRuntimeConfigPrefersDatabaseAndFallsBackToEnv pins the reader
// contract: database values win, absent values use the S3_* environment
// defaults (including the presigned TTL, which the old direct-key read missed).
func TestStorageRuntimeConfigPrefersDatabaseAndFallsBackToEnv(t *testing.T) {
	store := newFakeMySQL(s3StorageSettings())
	service := NewService(store.db(), nil, storageTestEnv())

	config, err := service.StorageRuntimeConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if config.Provider != objectstorage.ProviderS3 {
		t.Fatalf("provider = %q", config.Provider)
	}
	if config.AccessKeyID != "db-access-key" || config.SecretAccessKey != "db-secret-key" {
		t.Fatalf("credentials = %q/%q", config.AccessKeyID, config.SecretAccessKey)
	}
	if config.Region != "eu-central-1" || config.Bucket != "db-bucket" {
		t.Fatalf("region/bucket = %q/%q", config.Region, config.Bucket)
	}
	if config.Endpoint != "http://minio.local:9000" {
		t.Fatalf("endpoint = %q", config.Endpoint)
	}
	if config.PublicBaseURL != "http://cdn.local/db-bucket/" {
		t.Fatalf("publicBaseUrl = %q", config.PublicBaseURL)
	}
	if config.NormalizedPublicBaseURL() != "http://cdn.local/db-bucket" {
		t.Fatalf("normalized publicBaseUrl = %q", config.NormalizedPublicBaseURL())
	}
	if !config.ForcePathStyle {
		t.Fatal("forcePathStyle must come from the database value")
	}
	if config.PresignedURLTTLSeconds != 600 {
		t.Fatalf("ttl = %v", config.PresignedURLTTLSeconds)
	}

	// No rows at all: every field falls back to the environment defaults and
	// the provider defaults to mysql.
	emptyStore := newFakeMySQL(nil)
	fallbackService := NewService(emptyStore.db(), nil, storageTestEnv())
	fallback, err := fallbackService.StorageRuntimeConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fallback.Provider != objectstorage.ProviderMySQL {
		t.Fatalf("default provider = %q", fallback.Provider)
	}
	if fallback.AccessKeyID != "env-access-key" || fallback.SecretAccessKey != "env-secret-key" {
		t.Fatalf("env credentials = %q/%q", fallback.AccessKeyID, fallback.SecretAccessKey)
	}
	if fallback.Region != "us-east-1" || fallback.Bucket != "env-bucket" {
		t.Fatalf("env region/bucket = %q/%q", fallback.Region, fallback.Bucket)
	}
	if fallback.Endpoint != "" {
		t.Fatalf("env endpoint = %q, want empty", fallback.Endpoint)
	}
	if fallback.ForcePathStyle {
		t.Fatal("env forcePathStyle must default to false")
	}
	if fallback.PresignedURLTTLSeconds != 900 {
		t.Fatalf("env ttl = %v, want the S3_PRESIGNED_URL_TTL_SECONDS fallback", fallback.PresignedURLTTLSeconds)
	}
}

// TestStorageDiagnosticsMySQLMode pins the SELECT 1 branch: no S3 fields and no
// S3 calls.
func TestStorageDiagnosticsMySQLMode(t *testing.T) {
	probe := &fakeStorageProbe{}
	handler, store := newDiagnosticsHandler(t, nil, probe)
	result, err := handler.checkStorageConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Mode == nil || *result.Mode != objectstorage.ProviderMySQL {
		t.Fatalf("mysql result = %+v", result)
	}
	if result.Checks == nil || result.Checks.MySQL == nil || !result.Checks.MySQL.OK {
		t.Fatalf("mysql checks = %+v", result.Checks)
	}
	if result.Bucket != nil || result.Region != nil || result.Checks.HeadBucket != nil {
		t.Fatalf("mysql result leaked S3 fields: %+v", result)
	}
	if probe.headCalls != 0 || len(probe.putKeys) != 0 || len(probe.deletedKeys) != 0 {
		t.Fatalf("mysql mode performed S3 calls: %+v", probe)
	}
	found := false
	for _, statement := range store.state.snapshot() {
		if strings.TrimSpace(statement) == "SELECT 1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("SELECT 1 not executed: %v", store.state.snapshot())
	}
}

// TestStorageDiagnosticsS3AllChecksPass pins the successful three-step run and
// the unique probe key.
func TestStorageDiagnosticsS3AllChecksPass(t *testing.T) {
	probe := &fakeStorageProbe{
		head:    objectstorage.CheckResult{OK: true},
		put:     objectstorage.CheckResult{OK: true},
		deleted: objectstorage.CheckResult{OK: true},
	}
	handler, _ := newDiagnosticsHandler(t, s3StorageSettings(), probe)
	result, err := handler.checkStorageConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Error != nil {
		t.Fatalf("result = %+v", result)
	}
	if result.Mode == nil || *result.Mode != objectstorage.ProviderS3 {
		t.Fatalf("mode = %v", result.Mode)
	}
	if result.Bucket == nil || *result.Bucket != "db-bucket" ||
		result.Region == nil || *result.Region != "eu-central-1" ||
		result.Endpoint == nil || *result.Endpoint != "http://minio.local:9000" ||
		result.PublicBaseURL == nil || *result.PublicBaseURL != "http://cdn.local/db-bucket" ||
		result.ForcePathStyle == nil || !*result.ForcePathStyle ||
		result.PresignedURLTTLSeconds == nil || *result.PresignedURLTTLSeconds != 600 {
		t.Fatalf("s3 config echo = %+v", result)
	}
	if len(probe.putKeys) != 1 || len(probe.deletedKeys) != 1 {
		t.Fatalf("probe calls = %+v", probe)
	}
	if probe.putKeys[0] != probe.deletedKeys[0] {
		t.Fatalf("delete key %q does not match put key %q", probe.deletedKeys[0], probe.putKeys[0])
	}
	if !strings.HasPrefix(probe.putKeys[0], storageTestObjectPrefix) || !strings.HasSuffix(probe.putKeys[0], ".txt") {
		t.Fatalf("probe key = %q", probe.putKeys[0])
	}
	if probe.putKeys[0] == "__healthcheck__/storage-connection.txt" {
		t.Fatalf("fixed NestJS probe key must not be reused: %q", probe.putKeys[0])
	}
	if !strings.HasPrefix(probe.putBodies[0], storageTestObjectBodyPrefix) {
		t.Fatalf("probe body = %q", probe.putBodies[0])
	}
	if probe.putTypes[0] != "text/plain" || probe.putCaches[0] != "no-store" {
		t.Fatalf("probe headers = %q/%q", probe.putTypes[0], probe.putCaches[0])
	}
	if result.Checks == nil || result.Checks.HeadBucket == nil || !result.Checks.HeadBucket.OK ||
		result.Checks.PutObject == nil || !result.Checks.PutObject.OK ||
		result.Checks.DeleteObject == nil || !result.Checks.DeleteObject.OK {
		t.Fatalf("checks = %+v", result.Checks)
	}
}

// TestStorageDiagnosticsS3AggregatesIndependentFailures pins the three-step
// semantics: a failing head or put never skips the later steps, every check is
// reported and the aggregate error is the first head -> put -> delete error.
func TestStorageDiagnosticsS3AggregatesIndependentFailures(t *testing.T) {
	status := 403
	requestID := "req-403"
	probe := &fakeStorageProbe{
		head: objectstorage.CheckResult{OK: false, Error: "AccessDenied: denied", HTTPStatusCode: &status, RequestID: &requestID},
		put:  objectstorage.CheckResult{OK: true},
		deleted: objectstorage.CheckResult{OK: false, Error: "AccessDenied: denied",
			HTTPStatusCode: &status},
	}
	handler, _ := newDiagnosticsHandler(t, s3StorageSettings(), probe)
	result, err := handler.checkStorageConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.OK {
		t.Fatal("aggregate ok must be false when one step fails")
	}
	if result.Error == nil || *result.Error != "AccessDenied: denied" {
		t.Fatalf("error = %v", result.Error)
	}
	// The put still ran even though head failed, and delete still ran after
	// both.
	if len(probe.putKeys) != 1 || len(probe.deletedKeys) != 1 {
		t.Fatalf("later steps were skipped: %+v", probe)
	}
	checks := result.Checks
	if checks == nil || checks.HeadBucket == nil || checks.PutObject == nil || checks.DeleteObject == nil {
		t.Fatalf("checks = %+v", checks)
	}
	if checks.HeadBucket.OK || checks.HeadBucket.HTTPStatusCode == nil || *checks.HeadBucket.HTTPStatusCode != 403 {
		t.Fatalf("headBucket check = %+v", checks.HeadBucket)
	}
	if checks.HeadBucket.RequestID == nil || *checks.HeadBucket.RequestID != "req-403" {
		t.Fatalf("headBucket requestId = %v", checks.HeadBucket.RequestID)
	}
	if !checks.PutObject.OK || checks.PutObject.Error != nil {
		t.Fatalf("putObject check = %+v", checks.PutObject)
	}
	if checks.DeleteObject.OK || checks.DeleteObject.RequestID != nil {
		t.Fatalf("deleteObject check = %+v", checks.DeleteObject)
	}

	// A put-only failure reports the put error.
	onlyPut := &fakeStorageProbe{
		head:    objectstorage.CheckResult{OK: true},
		put:     objectstorage.CheckResult{OK: false, Error: "InvalidAccessKeyId: bad key"},
		deleted: objectstorage.CheckResult{OK: true},
	}
	handler, _ = newDiagnosticsHandler(t, s3StorageSettings(), onlyPut)
	result, err = handler.checkStorageConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Error == nil || *result.Error != "InvalidAccessKeyId: bad key" {
		t.Fatalf("put-only error = %v", result.Error)
	}
}

// TestStorageDiagnosticsS3IncompleteConfiguration pins the refreshClient catch:
// the mode-level result is ok:false with the formatted BadRequestException and
// no checks, never a 500 and never a fabricated ok.
func TestStorageDiagnosticsS3IncompleteConfiguration(t *testing.T) {
	settings := s3StorageSettings()
	delete(settings, settingKeyS3Bucket)
	store := newFakeMySQL(settings)
	service := NewService(store.db(), nil, storageTestEnv())
	handler := NewStorageDiagnosticsHandler(nil, service)

	result, err := handler.checkStorageConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.OK {
		t.Fatal("incomplete configuration must not report ok")
	}
	if result.Mode == nil || *result.Mode != objectstorage.ProviderS3 {
		t.Fatalf("mode = %v", result.Mode)
	}
	if result.Error == nil || *result.Error != "BadRequestException: Storage configuration is incomplete" {
		t.Fatalf("error = %v", result.Error)
	}
	if result.Checks != nil {
		t.Fatalf("checks must be omitted, got %+v", result.Checks)
	}
	if result.Bucket != nil || result.Region != nil {
		t.Fatalf("no S3 config may be echoed on failure: %+v", result)
	}
}

// TestStorageDiagnosticsResultJSONShape pins the omission of undefined keys:
// successful steps carry no null error/status/requestId fields.
func TestStorageDiagnosticsResultJSONShape(t *testing.T) {
	handler, _ := newDiagnosticsHandler(t, nil, &fakeStorageProbe{})
	mysqlResult, err := handler.checkStorageConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(mysqlResult)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"ok":true,"mode":"mysql","checks":{"mysql":{"ok":true}}}`
	if string(encoded) != want {
		t.Fatalf("mysql result JSON = %s, want %s", encoded, want)
	}

	probe := &fakeStorageProbe{
		head:    objectstorage.CheckResult{OK: true},
		put:     objectstorage.CheckResult{OK: true},
		deleted: objectstorage.CheckResult{OK: true},
	}
	handler, _ = newDiagnosticsHandler(t, s3StorageSettings(), probe)
	s3Result, err := handler.checkStorageConnection(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err = json.Marshal(s3Result)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"endpoint":"http://minio.local:9000"`) ||
		!strings.Contains(string(encoded), `"presignedUrlTtlSeconds":600`) ||
		!strings.Contains(string(encoded), `"forcePathStyle":true`) ||
		!strings.Contains(string(encoded), `"publicBaseUrl":"http://cdn.local/db-bucket"`) {
		t.Fatalf("s3 result JSON = %s", encoded)
	}
	if strings.Contains(string(encoded), `"error":null`) || strings.Contains(string(encoded), `"requestId":null`) {
		t.Fatalf("undefined members must be omitted: %s", encoded)
	}
}

// TestStorageDiagnosticsDatabaseFailure pins the mysql check error text and the
// fail-closed path when no database handle was injected.
func TestStorageDiagnosticsDatabaseFailure(t *testing.T) {
	handler := NewStorageDiagnosticsHandler(nil, NewService(nil, nil, storageTestEnv()))
	check := handler.selectOne(context.Background())
	if check.OK || check.Error == nil || !strings.HasPrefix(*check.Error, "Error: ") {
		t.Fatalf("missing database check = %+v", check)
	}
}

// TestNewStorageTestObjectKeyIsUnique pins the per-run uniqueness and the shared
// prefix so parallel tests cannot collide.
func TestNewStorageTestObjectKeyIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 32 {
		key := newStorageTestObjectKey()
		if !strings.HasPrefix(key, storageTestObjectPrefix) {
			t.Fatalf("key %q lost the prefix", key)
		}
		if !strings.HasSuffix(key, ".txt") {
			t.Fatalf("key %q lost the suffix", key)
		}
		if seen[key] {
			t.Fatalf("duplicate probe key %q", key)
		}
		seen[key] = true
	}
}
