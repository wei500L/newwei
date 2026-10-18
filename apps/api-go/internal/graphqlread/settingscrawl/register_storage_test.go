package settingscrawl

import (
	"context"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// fakeStorageConfigReader is the injected runtime storage configuration reader.
type fakeStorageConfigReader struct{}

// StorageRuntimeConfig implements objectstorage.ConfigReader.
func (fakeStorageConfigReader) StorageRuntimeConfig(context.Context) (objectstorage.RuntimeConfig, error) {
	return objectstorage.RuntimeConfig{Provider: objectstorage.ProviderS3}, nil
}

// TestNewCrawlReaderInjectsStorageConfig pins the second injection point: the
// GraphQL crawlTask root builds its own crawl read service, so it must receive
// the same runtime storage configuration reader as the REST handler. Without
// it the S3 previewUrl/downloadUrl members stay unset while the REST route
// signs them.
func TestNewCrawlReaderInjectsStorageConfig(t *testing.T) {
	reader := newCrawlReader(nil, &store{}, Options{StorageConfig: fakeStorageConfigReader{}})
	if reader == nil || reader.svc == nil {
		t.Fatal("newCrawlReader must build the crawl read service")
	}
	if !reader.svc.StorageReaderConfigured() {
		t.Fatal("Options.StorageConfig was not injected into the crawl read service")
	}
}

// TestNewCrawlReaderToleratesMissingStorageConfig pins the nil-reader branch:
// tests and the settings-write-only path may omit it, and the service must
// still be built (its S3 URLs are simply unset).
func TestNewCrawlReaderToleratesMissingStorageConfig(t *testing.T) {
	reader := newCrawlReader(nil, &store{}, Options{})
	if reader == nil || reader.svc == nil {
		t.Fatal("newCrawlReader must build the crawl read service")
	}
	if reader.svc.StorageReaderConfigured() {
		t.Fatal("no storage reader was configured")
	}
}
