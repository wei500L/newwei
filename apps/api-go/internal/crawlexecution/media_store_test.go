package crawlexecution

// Unit tests for the media store: the pure CrawlMediaAsset row mapping, the S3
// object-key/upload/cleanup sequence, the MySQL blob dedupe decisions and the
// rollback cleanup. They use in-memory fakes only; no MySQL or S3 is involved.

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// ---- fakes ----

// fakeMediaRepository records the repository calls mediaStore makes.
type fakeMediaRepository struct {
	s3StorageKey *string
	s3Found      bool
	s3Err        error
	s3Lookups    []s3AssetLookup

	insertedRows []mediaAssetRow
	insertErr    error

	mysqlRows     []mediaAssetRow
	mysqlBlobs    []mediaBlobWrite
	mysqlErr      error
	mysqlErrCalls int

	rollbackAssets  []mediaRollbackAsset
	rollbackErr     error
	s3References    int
	referenceErr    error
	deletedResults  []string
	deletedRefCount map[string]int
	deleteErr       error
}

func (f *fakeMediaRepository) findReusableS3Asset(_ context.Context, lookup s3AssetLookup) (*string, bool, error) {
	f.s3Lookups = append(f.s3Lookups, lookup)
	if f.s3Err != nil {
		return nil, false, f.s3Err
	}
	return f.s3StorageKey, f.s3Found, nil
}

func (f *fakeMediaRepository) insertAsset(_ context.Context, row mediaAssetRow) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.insertedRows = append(f.insertedRows, row)
	return nil
}

func (f *fakeMediaRepository) storeMysqlAsset(_ context.Context, row mediaAssetRow, blob mediaBlobWrite) error {
	if f.mysqlErr != nil && f.mysqlErrCalls > 0 {
		f.mysqlErrCalls--
		return f.mysqlErr
	}
	f.mysqlRows = append(f.mysqlRows, row)
	f.mysqlBlobs = append(f.mysqlBlobs, blob)
	return nil
}

func (f *fakeMediaRepository) listAssetsByResultID(_ context.Context, resultID string) ([]mediaRollbackAsset, error) {
	if f.rollbackErr != nil {
		return nil, f.rollbackErr
	}
	return f.rollbackAssets, nil
}

func (f *fakeMediaRepository) countS3References(_ context.Context, orgID, storageKey, excludeResultID string) (int, error) {
	if f.referenceErr != nil {
		return 0, f.referenceErr
	}
	return f.s3References, nil
}

func (f *fakeMediaRepository) deleteAssetsAndBlobs(_ context.Context, resultID string, blobRefCounts map[string]int, now time.Time) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deletedResults = append(f.deletedResults, resultID)
	f.deletedRefCount = blobRefCounts
	return nil
}

// fakeMediaPut is one recorded PutObject call.
type fakeMediaPut struct {
	Key          string
	Body         string
	ContentType  string
	CacheControl string
}

// fakeMediaObjects records S3 uploads and deletions.
type fakeMediaObjects struct {
	puts        []fakeMediaPut
	putError    string
	deletes     []string
	deleteError string
}

func (f *fakeMediaObjects) PutObject(_ context.Context, objectKey, body, contentType, cacheControl string) objectstorage.CheckResult {
	f.puts = append(f.puts, fakeMediaPut{Key: objectKey, Body: body, ContentType: contentType, CacheControl: cacheControl})
	if f.putError != "" {
		return objectstorage.CheckResult{Error: f.putError}
	}
	return objectstorage.CheckResult{OK: true}
}

func (f *fakeMediaObjects) DeleteObject(_ context.Context, objectKey string) objectstorage.CheckResult {
	f.deletes = append(f.deletes, objectKey)
	if f.deleteError != "" {
		return objectstorage.CheckResult{Error: f.deleteError}
	}
	return objectstorage.CheckResult{OK: true}
}

// fakeMediaStorage resolves the storage snapshot and the provider setting.
type fakeMediaStorage struct {
	config      objectstorage.RuntimeConfig
	configErr   error
	provider    string
	providerErr error
}

func (f *fakeMediaStorage) StorageRuntimeConfig(context.Context) (objectstorage.RuntimeConfig, error) {
	return f.config, f.configErr
}

func (f *fakeMediaStorage) CrawlImageStorageProvider(context.Context) (string, error) {
	return f.provider, f.providerErr
}

// fakeSnapshotStorage only exposes the runtime snapshot (no provider method).
type fakeSnapshotStorage struct {
	config objectstorage.RuntimeConfig
}

func (f fakeSnapshotStorage) StorageRuntimeConfig(context.Context) (objectstorage.RuntimeConfig, error) {
	return f.config, nil
}

// fakeMediaBlobStore records the CrawlMediaBlob decisions.
type fakeMediaBlobStore struct {
	existingID   string
	findCalls    int
	racedID      string
	conflict     bool
	findErr      error
	createErr    error
	incrementErr error
	created      []mediaBlobWrite
	increments   []string
}

func (f *fakeMediaBlobStore) findBlobID(_ context.Context, orgID, sha256 string) (string, bool, error) {
	f.findCalls++
	if f.findErr != nil {
		return "", false, f.findErr
	}
	if f.conflict && f.findCalls >= 2 {
		return f.racedID, true, nil
	}
	if f.existingID != "" {
		return f.existingID, true, nil
	}
	return "", false, nil
}

func (f *fakeMediaBlobStore) createBlob(_ context.Context, blob mediaBlobWrite) error {
	if f.conflict {
		return &mysqlDriver.MySQLError{Number: 1062, Message: "Duplicate entry"}
	}
	if f.createErr != nil {
		return f.createErr
	}
	f.created = append(f.created, blob)
	return nil
}

func (f *fakeMediaBlobStore) incrementRefCount(_ context.Context, blobID string, _ time.Time) error {
	if f.incrementErr != nil {
		return f.incrementErr
	}
	f.increments = append(f.increments, blobID)
	return nil
}

// ---- helpers ----

func mediaTestNow() time.Time {
	return time.Date(2026, 10, 21, 12, 0, 0, 123000000, time.UTC)
}

func newTestMediaStore(repository mediaAssetRepository, storageConfig mediaStorageConfigReader, objects mediaObjectWriter, client *http.Client) *mediaStore {
	counter := 0
	return &mediaStore{
		storageConfig: storageConfig,
		repository:    repository,
		httpClient:    client,
		now:           mediaTestNow,
		newID: func() (string, error) {
			counter++
			return fmt.Sprintf("c%024x", counter), nil
		},
		newObjects: func(objectstorage.RuntimeConfig) (mediaObjectWriter, error) {
			if objects == nil {
				return nil, errors.New("no object writer")
			}
			return objects, nil
		},
	}
}

func mediaTestAsset() downloadedMediaAsset {
	contentType := "image/jpg"
	alt := "alt text"
	title := "title text"
	width := 640
	height := 480
	format := "image/jpeg"
	return downloadedMediaAsset{
		Kind:        "images",
		SourceURL:   "https://cdn.example/a.jpg",
		Bytes:       4,
		ContentType: &contentType,
		Data:        []byte{0x01, 0x02, 0x03, 0x04},
		Width:       &width,
		Height:      &height,
		Alt:         &alt,
		Title:       &title,
		Format:      &format,
		Metadata:    mediaRawExtras{{Key: "class", Value: json.RawMessage(`"hero"`)}},
	}
}

// ---- CrawlMediaAsset row mapping ----

func TestBuildMediaAssetRow(t *testing.T) {
	asset := mediaTestAsset()
	contentType := "image/jpeg"
	now := mediaTestNow()
	row, err := buildMediaAssetRow(mediaAssetRowInput{
		ID:          "casset",
		OrgID:       "org-1",
		TaskID:      "task-1",
		ResultID:    "result-1",
		Provider:    objectstorage.ProviderMySQL,
		Asset:       asset,
		ContentType: &contentType,
		Now:         now,
	})
	if err != nil {
		t.Fatalf("build row: %v", err)
	}
	if row.ID != "casset" || row.ResultID != "result-1" || row.OrgID != "org-1" || row.TaskID != "task-1" {
		t.Fatalf("identity columns = %#v", row)
	}
	if row.Provider != objectstorage.ProviderMySQL || row.Kind != "images" || row.SourceURL != "https://cdn.example/a.jpg" || row.Bytes != 4 {
		t.Fatalf("content columns = %#v", row)
	}
	if row.ContentType == nil || *row.ContentType != "image/jpeg" {
		t.Fatalf("contentType = %#v", row.ContentType)
	}
	if row.BlobID != nil || row.StorageKey != nil {
		t.Fatalf("provider-specific columns must start nil: blobId=%#v storageKey=%#v", row.BlobID, row.StorageKey)
	}
	if row.Width == nil || *row.Width != 640 || row.Height == nil || *row.Height != 480 {
		t.Fatalf("dimensions = %#v/%#v", row.Width, row.Height)
	}
	if row.Alt == nil || *row.Alt != "alt text" || row.Title == nil || *row.Title != "title text" {
		t.Fatalf("text columns = %#v/%#v", row.Alt, row.Title)
	}
	if row.Format == nil || *row.Format != "image/jpeg" {
		t.Fatalf("format = %#v", row.Format)
	}
	if string(row.Metadata) != `{"class":"hero"}` {
		t.Fatalf("metadata = %s", row.Metadata)
	}
	if !row.CreatedAt.Equal(now) || !row.UpdatedAt.Equal(now) {
		t.Fatalf("timestamps = %v/%v", row.CreatedAt, row.UpdatedAt)
	}

	empty, err := buildMediaAssetRow(mediaAssetRowInput{
		ID: "casset2", OrgID: "org-1", TaskID: "task-1", ResultID: "result-1",
		Provider: objectstorage.ProviderS3,
		Asset:    downloadedMediaAsset{Kind: "images", SourceURL: "data-uri:inline", Bytes: 0},
		Now:      now,
	})
	if err != nil {
		t.Fatalf("build empty row: %v", err)
	}
	if string(empty.Metadata) != "{}" {
		t.Fatalf("nil metadata must default to {}: %s", empty.Metadata)
	}
	if empty.ContentType != nil {
		t.Fatalf("nil content type must stay nil: %#v", empty.ContentType)
	}
}

func TestBuildMediaStorageKey(t *testing.T) {
	contentType := "image/jpeg"
	key := buildMediaStorageKey("org-1", "task-1", "result-1", &contentType, mediaTestNow(), "11111111-2222-4333-8444-555555555555")
	want := "crawl-media/org-1/task-1/result-1/1792584000123-11111111-2222-4333-8444-555555555555.jpg"
	if key != want {
		t.Fatalf("storage key = %q, want %q", key, want)
	}
	if withoutExtension := buildMediaStorageKey("org-1", "task-1", "result-1", nil, mediaTestNow(), "uuid"); withoutExtension != "crawl-media/org-1/task-1/result-1/1792584000123-uuid" {
		t.Fatalf("storage key without content type = %q", withoutExtension)
	}
	nonMedia := "text/html"
	if withoutExtension := buildMediaStorageKey("org-1", "task-1", "result-1", &nonMedia, mediaTestNow(), "uuid"); withoutExtension != "crawl-media/org-1/task-1/result-1/1792584000123-uuid" {
		t.Fatalf("storage key for non-media content type = %q", withoutExtension)
	}
}

// ---- provider selection ----

func TestResolveProvider(t *testing.T) {
	t.Run("provider setting wins over snapshot", func(t *testing.T) {
		store := newTestMediaStore(&fakeMediaRepository{}, &fakeMediaStorage{
			config:   objectstorage.RuntimeConfig{Provider: objectstorage.ProviderMySQL},
			provider: "S3",
		}, nil, nil)
		provider, _, err := store.resolveProvider(context.Background())
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if provider != objectstorage.ProviderS3 {
			t.Fatalf("provider = %q", provider)
		}
	})
	t.Run("snapshot fallback and mysql default", func(t *testing.T) {
		store := newTestMediaStore(&fakeMediaRepository{}, fakeSnapshotStorage{
			config: objectstorage.RuntimeConfig{Provider: objectstorage.ProviderS3},
		}, nil, nil)
		if provider, _, err := store.resolveProvider(context.Background()); err != nil || provider != objectstorage.ProviderS3 {
			t.Fatalf("snapshot provider = %q err=%v", provider, err)
		}
		store = newTestMediaStore(&fakeMediaRepository{}, fakeSnapshotStorage{}, nil, nil)
		if provider, _, err := store.resolveProvider(context.Background()); err != nil || provider != objectstorage.ProviderMySQL {
			t.Fatalf("default provider = %q err=%v", provider, err)
		}
	})
	t.Run("configuration error propagates", func(t *testing.T) {
		store := newTestMediaStore(&fakeMediaRepository{}, &fakeMediaStorage{configErr: errors.New("settings unavailable")}, nil, nil)
		if _, _, err := store.resolveProvider(context.Background()); err == nil {
			t.Fatal("expected configuration error")
		}
	})
}

// ---- MySQL branch ----

func TestStoreAssetMySQL(t *testing.T) {
	repository := &fakeMediaRepository{}
	storage := &fakeMediaStorage{
		config:   objectstorage.RuntimeConfig{Provider: objectstorage.ProviderS3},
		provider: objectstorage.ProviderMySQL,
	}
	store := newTestMediaStore(repository, storage, nil, nil)
	if err := store.storeAsset(context.Background(), testTask(), "result-1", mediaTestAsset()); err != nil {
		t.Fatalf("store asset: %v", err)
	}
	if len(repository.mysqlRows) != 1 || len(repository.mysqlBlobs) != 1 {
		t.Fatalf("mysql rows = %d blobs = %d", len(repository.mysqlRows), len(repository.mysqlBlobs))
	}
	row := repository.mysqlRows[0]
	if row.Provider != objectstorage.ProviderMySQL || row.BlobID != nil || row.StorageKey != nil {
		t.Fatalf("mysql row = %#v", row)
	}
	if row.ContentType == nil || *row.ContentType != "image/jpeg" {
		t.Fatalf("sanitized contentType = %#v", row.ContentType)
	}
	if string(row.Metadata) != `{"class":"hero"}` {
		t.Fatalf("metadata = %s", row.Metadata)
	}
	blob := repository.mysqlBlobs[0]
	if blob.OrgID != "org-1" || blob.Bytes != 4 || string(blob.Data) != string([]byte{0x01, 0x02, 0x03, 0x04}) {
		t.Fatalf("blob = %#v", blob)
	}
	if blob.ContentType == nil || *blob.ContentType != "image/jpeg" {
		t.Fatalf("blob contentType = %#v", blob.ContentType)
	}
	// sha256(0x01 0x02 0x03 0x04) is a fixed digest.
	if blob.SHA256 != "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a" {
		t.Fatalf("blob sha256 = %q", blob.SHA256)
	}
	if len(repository.insertedRows) != 0 {
		t.Fatalf("mysql branch must not insert outside the transaction: %d", len(repository.insertedRows))
	}
}

func TestStoreAssetMysqlFailurePropagates(t *testing.T) {
	repository := &fakeMediaRepository{mysqlErr: errors.New("deadlock"), mysqlErrCalls: 1}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderMySQL}, nil, nil)
	if err := store.storeAsset(context.Background(), testTask(), "result-1", mediaTestAsset()); err == nil {
		t.Fatal("expected store error")
	}
}

// ---- S3 branch ----

func TestStoreAssetS3UploadsAndInsertsRow(t *testing.T) {
	repository := &fakeMediaRepository{}
	objects := &fakeMediaObjects{}
	storage := &fakeMediaStorage{provider: objectstorage.ProviderS3}
	store := newTestMediaStore(repository, storage, objects, nil)
	if err := store.storeAsset(context.Background(), testTask(), "result-1", mediaTestAsset()); err != nil {
		t.Fatalf("store asset: %v", err)
	}
	if len(repository.s3Lookups) != 1 {
		t.Fatalf("dedupe lookups = %d", len(repository.s3Lookups))
	}
	lookup := repository.s3Lookups[0]
	if lookup.OrgID != "org-1" || lookup.Kind != "images" || lookup.SourceURL != "https://cdn.example/a.jpg" || lookup.Bytes != 4 {
		t.Fatalf("lookup = %#v", lookup)
	}
	if lookup.ContentType == nil || *lookup.ContentType != "image/jpeg" {
		t.Fatalf("lookup contentType = %#v", lookup.ContentType)
	}
	if len(objects.puts) != 1 {
		t.Fatalf("uploads = %d", len(objects.puts))
	}
	put := objects.puts[0]
	if !strings.HasPrefix(put.Key, "crawl-media/org-1/task-1/result-1/") || !strings.HasSuffix(put.Key, ".jpg") {
		t.Fatalf("object key = %q", put.Key)
	}
	if put.Body != string([]byte{0x01, 0x02, 0x03, 0x04}) {
		t.Fatalf("uploaded body = %q", put.Body)
	}
	if put.ContentType != "image/jpeg" {
		t.Fatalf("upload contentType = %q", put.ContentType)
	}
	if put.CacheControl != "public, max-age=31536000, immutable" {
		t.Fatalf("upload cacheControl = %q", put.CacheControl)
	}
	if len(repository.insertedRows) != 1 {
		t.Fatalf("inserted rows = %d", len(repository.insertedRows))
	}
	row := repository.insertedRows[0]
	if row.Provider != objectstorage.ProviderS3 || row.StorageKey == nil || *row.StorageKey != put.Key {
		t.Fatalf("inserted row = %#v", row)
	}
	if row.BlobID != nil {
		t.Fatalf("s3 row must not carry a blob id: %#v", row.BlobID)
	}
	if len(objects.deletes) != 0 {
		t.Fatalf("unexpected object cleanup: %v", objects.deletes)
	}
}

func TestStoreAssetS3DeduplicatesExistingKey(t *testing.T) {
	existing := "crawl-media/org-1/task-1/result-0/123-existing.png"
	repository := &fakeMediaRepository{s3StorageKey: &existing, s3Found: true}
	objects := &fakeMediaObjects{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderS3}, objects, nil)
	if err := store.storeAsset(context.Background(), testTask(), "result-1", mediaTestAsset()); err != nil {
		t.Fatalf("store asset: %v", err)
	}
	if len(objects.puts) != 0 {
		t.Fatalf("deduplicated asset must not upload again: %v", objects.puts)
	}
	if len(repository.insertedRows) != 1 || repository.insertedRows[0].StorageKey == nil || *repository.insertedRows[0].StorageKey != existing {
		t.Fatalf("inserted row = %#v", repository.insertedRows)
	}
}

func TestStoreAssetS3MatchedRowWithoutKeySkipsUpload(t *testing.T) {
	repository := &fakeMediaRepository{s3Found: true}
	objects := &fakeMediaObjects{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderS3}, objects, nil)
	if err := store.storeAsset(context.Background(), testTask(), "result-1", mediaTestAsset()); err != nil {
		t.Fatalf("store asset: %v", err)
	}
	// The NestJS `existing?.storageKey ?? buildStorageKey` path: a matched row
	// without a key gets a new key but skips the upload.
	if len(objects.puts) != 0 {
		t.Fatalf("matched row must skip the upload: %v", objects.puts)
	}
	if len(repository.insertedRows) != 1 || repository.insertedRows[0].StorageKey == nil {
		t.Fatalf("inserted row = %#v", repository.insertedRows)
	}
}

func TestStoreAssetS3CleansUpObjectOnInsertFailure(t *testing.T) {
	repository := &fakeMediaRepository{insertErr: errors.New("foreign key")}
	objects := &fakeMediaObjects{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderS3}, objects, nil)
	err := store.storeAsset(context.Background(), testTask(), "result-1", mediaTestAsset())
	if err == nil {
		t.Fatal("expected insert error")
	}
	if len(objects.puts) != 1 {
		t.Fatalf("uploads = %d", len(objects.puts))
	}
	if len(objects.deletes) != 1 || objects.deletes[0] != objects.puts[0].Key {
		t.Fatalf("cleanup deletes = %v (uploaded %v)", objects.deletes, objects.puts[0].Key)
	}
}

func TestStoreAssetS3UploadFailureSkipsInsert(t *testing.T) {
	repository := &fakeMediaRepository{}
	objects := &fakeMediaObjects{putError: "AccessDenied: denied"}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderS3}, objects, nil)
	if err := store.storeAsset(context.Background(), testTask(), "result-1", mediaTestAsset()); err == nil {
		t.Fatal("expected upload error")
	}
	if len(repository.insertedRows) != 0 {
		t.Fatalf("insert must not run after a failed upload: %#v", repository.insertedRows)
	}
}

func TestStoreAssetS3NonMediaContentType(t *testing.T) {
	repository := &fakeMediaRepository{}
	objects := &fakeMediaObjects{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderS3}, objects, nil)
	asset := mediaTestAsset()
	html := "text/html; charset=utf-8"
	asset.ContentType = &html
	if err := store.storeAsset(context.Background(), testTask(), "result-1", asset); err != nil {
		t.Fatalf("store asset: %v", err)
	}
	if len(repository.insertedRows) != 1 || repository.insertedRows[0].ContentType != nil {
		t.Fatalf("non-media content type must be stored as NULL: %#v", repository.insertedRows)
	}
	if len(objects.puts) != 1 || objects.puts[0].ContentType != "application/octet-stream" {
		t.Fatalf("upload content type = %#v", objects.puts)
	}
	if strings.Contains(objects.puts[0].Key, ".") {
		t.Fatalf("content type without extension mapping must not add a suffix: %q", objects.puts[0].Key)
	}
}

// ---- MySQL blob dedupe ----

func TestResolveMediaBlobID(t *testing.T) {
	blob := mediaBlobWrite{
		ID: "cblob-new", OrgID: "org-1", SHA256: "abc", Bytes: 4,
		Data: []byte{0x01, 0x02, 0x03, 0x04}, Now: mediaTestNow(),
	}
	t.Run("existing blob increments refCount", func(t *testing.T) {
		store := &fakeMediaBlobStore{existingID: "cblob-existing"}
		id, err := resolveMediaBlobID(context.Background(), store, blob)
		if err != nil || id != "cblob-existing" {
			t.Fatalf("id=%q err=%v", id, err)
		}
		if len(store.created) != 0 {
			t.Fatalf("existing blob must not be created again: %#v", store.created)
		}
		if len(store.increments) != 1 || store.increments[0] != "cblob-existing" {
			t.Fatalf("increments = %v", store.increments)
		}
	})
	t.Run("new blob is created with refCount 1", func(t *testing.T) {
		store := &fakeMediaBlobStore{}
		id, err := resolveMediaBlobID(context.Background(), store, blob)
		if err != nil || id != "cblob-new" {
			t.Fatalf("id=%q err=%v", id, err)
		}
		if len(store.created) != 1 || store.created[0].ID != "cblob-new" || store.created[0].SHA256 != "abc" {
			t.Fatalf("created = %#v", store.created)
		}
		if len(store.increments) != 0 {
			t.Fatalf("fresh blob must not take the increment path: %v", store.increments)
		}
	})
	t.Run("unique conflict reads the winner and increments it", func(t *testing.T) {
		store := &fakeMediaBlobStore{conflict: true, racedID: "cblob-raced"}
		id, err := resolveMediaBlobID(context.Background(), store, blob)
		if err != nil || id != "cblob-raced" {
			t.Fatalf("id=%q err=%v", id, err)
		}
		if store.findCalls != 2 {
			t.Fatalf("find calls = %d", store.findCalls)
		}
		if len(store.increments) != 1 || store.increments[0] != "cblob-raced" {
			t.Fatalf("increments = %v", store.increments)
		}
	})
	t.Run("non-conflict create error propagates", func(t *testing.T) {
		store := &fakeMediaBlobStore{createErr: errors.New("disk full")}
		if _, err := resolveMediaBlobID(context.Background(), store, blob); err == nil {
			t.Fatal("expected create error")
		}
	})
}

// ---- rollback cleanup ----

func TestDeleteAssetsByResultID(t *testing.T) {
	blobA := "cblob-a"
	blobB := "cblob-b"
	keyShared := "crawl-media/org-1/task-1/result-0/shared.png"
	keyTarget := "crawl-media/org-1/task-1/result-1/target.png"
	repository := &fakeMediaRepository{
		rollbackAssets: []mediaRollbackAsset{
			{ID: "asset-s3-target", OrgID: "org-1", Provider: objectstorage.ProviderS3, StorageKey: &keyTarget},
			{ID: "asset-s3-shared", OrgID: "org-1", Provider: objectstorage.ProviderS3, StorageKey: &keyShared},
			{ID: "asset-mysql-a1", OrgID: "org-1", Provider: objectstorage.ProviderMySQL, BlobID: &blobA},
			{ID: "asset-mysql-a2", OrgID: "org-1", Provider: objectstorage.ProviderMySQL, BlobID: &blobA},
			{ID: "asset-mysql-b", OrgID: "org-1", Provider: objectstorage.ProviderMySQL, BlobID: &blobB},
			{ID: "asset-no-payload", OrgID: "org-1", Provider: objectstorage.ProviderS3},
		},
		s3References: 2,
	}
	objects := &fakeMediaObjects{}
	store := newTestMediaStore(repository, fakeSnapshotStorage{}, objects, nil)
	if err := store.deleteAssetsByResultID(context.Background(), testTask(), "result-1"); err != nil {
		t.Fatalf("delete assets: %v", err)
	}
	// Both S3 assets share one object key; with two other references the object
	// must survive. The count query runs once per S3 asset in the fake, so the
	// per-asset decision is what matters: no delete.
	if len(objects.deletes) != 0 {
		t.Fatalf("referenced S3 object must not be deleted: %v", objects.deletes)
	}
	if len(repository.deletedResults) != 1 || repository.deletedResults[0] != "result-1" {
		t.Fatalf("deleted results = %v", repository.deletedResults)
	}
	if repository.deletedRefCount[blobA] != 2 || repository.deletedRefCount[blobB] != 1 || len(repository.deletedRefCount) != 2 {
		t.Fatalf("blob refCounts = %v", repository.deletedRefCount)
	}
}

func TestDeleteAssetsByResultIDDeletesUnreferencedObject(t *testing.T) {
	key := "crawl-media/org-1/task-1/result-1/solo.png"
	repository := &fakeMediaRepository{
		rollbackAssets: []mediaRollbackAsset{
			{ID: "asset-s3", OrgID: "org-1", Provider: objectstorage.ProviderS3, StorageKey: &key},
		},
	}
	objects := &fakeMediaObjects{}
	store := newTestMediaStore(repository, fakeSnapshotStorage{}, objects, nil)
	if err := store.deleteAssetsByResultID(context.Background(), testTask(), "result-1"); err != nil {
		t.Fatalf("delete assets: %v", err)
	}
	if len(objects.deletes) != 1 || objects.deletes[0] != key {
		t.Fatalf("deletes = %v", objects.deletes)
	}
}

func TestDeleteAssetsByResultIDDeleteFailurePropagates(t *testing.T) {
	repository := &fakeMediaRepository{
		rollbackAssets: []mediaRollbackAsset{{ID: "asset", OrgID: "org-1", Provider: objectstorage.ProviderMySQL}},
		deleteErr:      errors.New("lock wait timeout"),
	}
	store := newTestMediaStore(repository, fakeSnapshotStorage{}, nil, nil)
	if err := store.deleteAssetsByResultID(context.Background(), testTask(), "result-1"); err == nil {
		t.Fatal("expected cleanup error")
	}
}

// ---- SQL argument construction (in-test database/sql driver) ----

func TestInsertMediaAssetRowArguments(t *testing.T) {
	database := &fakeDatabase{}
	db := openFakeDB(t, database)
	contentType := "image/jpeg"
	storageKey := "crawl-media/org-1/task-1/result-1/123-uuid.jpg"
	title := "title"
	width := 640
	height := 480
	now := mediaTestNow()
	row := mediaAssetRow{
		ID:          "casset",
		ResultID:    "result-1",
		OrgID:       "org-1",
		TaskID:      "task-1",
		Provider:    objectstorage.ProviderS3,
		Kind:        "images",
		SourceURL:   "https://cdn.example/a.jpg",
		Bytes:       4,
		ContentType: &contentType,
		StorageKey:  &storageKey,
		Width:       &width,
		Height:      &height,
		Title:       &title,
		Format:      &contentType,
		Metadata:    json.RawMessage(`{"class":"hero"}`),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := insertMediaAssetRow(context.Background(), db, row); err != nil {
		t.Fatalf("insert row: %v", err)
	}
	if len(database.executes) != 1 {
		t.Fatalf("executes = %d", len(database.executes))
	}
	executed := database.executes[0]
	if !strings.Contains(executed.query, "INSERT INTO `CrawlMediaAsset`") {
		t.Fatalf("query = %s", executed.query)
	}
	if !strings.Contains(executed.query, "`desc`") {
		t.Fatalf("reserved column desc must be quoted: %s", executed.query)
	}
	if len(executed.args) != 21 {
		t.Fatalf("args = %d, want 21", len(executed.args))
	}
	stringArg := func(index int, want string) {
		t.Helper()
		value, ok := executed.args[index].(string)
		if !ok || value != want {
			t.Fatalf("arg[%d] = %#v, want %q", index, executed.args[index], want)
		}
	}
	stringArg(0, "casset")
	stringArg(1, "result-1")
	stringArg(2, "org-1")
	stringArg(3, "task-1")
	stringArg(4, objectstorage.ProviderS3)
	stringArg(5, "images")
	stringArg(6, "https://cdn.example/a.jpg")
	if value, ok := executed.args[7].(int64); !ok || value != 4 {
		t.Fatalf("arg[7] bytes = %#v", executed.args[7])
	}
	stringArg(8, "image/jpeg")
	if executed.args[9] != nil {
		t.Fatalf("arg[9] blobId = %#v, want nil", executed.args[9])
	}
	stringArg(10, storageKey)
	if value, ok := executed.args[11].(int64); !ok || value != 640 {
		t.Fatalf("arg[11] width = %#v", executed.args[11])
	}
	if value, ok := executed.args[12].(int64); !ok || value != 480 {
		t.Fatalf("arg[12] height = %#v", executed.args[12])
	}
	if executed.args[13] != nil {
		t.Fatalf("arg[13] alt = %#v, want nil", executed.args[13])
	}
	stringArg(14, "title")
	if executed.args[15] != nil || executed.args[16] != nil {
		t.Fatalf("arg[15]/arg[16] desc/poster = %#v/%#v", executed.args[15], executed.args[16])
	}
	stringArg(17, "image/jpeg")
	metadata, ok := executed.args[18].([]byte)
	if !ok || string(metadata) != `{"class":"hero"}` {
		t.Fatalf("arg[18] metadata = %#v", executed.args[18])
	}
	createdAt, ok := executed.args[19].(time.Time)
	if !ok || !createdAt.Equal(now) {
		t.Fatalf("arg[19] createdAt = %#v", executed.args[19])
	}
	updatedAt, ok := executed.args[20].(time.Time)
	if !ok || !updatedAt.Equal(now) {
		t.Fatalf("arg[20] updatedAt = %#v", executed.args[20])
	}
}

func TestFindReusableS3AssetQuery(t *testing.T) {
	t.Run("content type predicate is present", func(t *testing.T) {
		contentType := "image/png"
		database := &fakeDatabase{nextRows: []fakeRowSet{{
			columns: []string{"storageKey"},
			values:  [][]driver.Value{{"crawl-media/org-1/task-1/result-0/existing.png"}},
		}}}
		repository := &sqlMediaAssetRepository{db: openFakeDB(t, database)}
		storageKey, found, err := repository.findReusableS3Asset(context.Background(), s3AssetLookup{
			OrgID:       "org-1",
			Kind:        "images",
			SourceURL:   "https://cdn.example/a.png",
			ContentType: &contentType,
			Bytes:       4,
		})
		if err != nil || !found || storageKey == nil || *storageKey != "crawl-media/org-1/task-1/result-0/existing.png" {
			t.Fatalf("key=%v found=%v err=%v", storageKey, found, err)
		}
		if len(database.queried) != 1 || !strings.Contains(database.queried[0], "`contentType` = ?") {
			t.Fatalf("query = %v", database.queried)
		}
	})
	t.Run("nil content type omits the predicate", func(t *testing.T) {
		database := &fakeDatabase{}
		repository := &sqlMediaAssetRepository{db: openFakeDB(t, database)}
		if _, found, err := repository.findReusableS3Asset(context.Background(), s3AssetLookup{
			OrgID: "org-1", Kind: "images", SourceURL: "https://cdn.example/a.png", Bytes: 4,
		}); err != nil || found {
			t.Fatalf("found=%v err=%v", found, err)
		}
		if len(database.queried) != 1 || strings.Contains(database.queried[0], "`contentType` = ?") {
			t.Fatalf("a nil content type must omit the predicate: %v", database.queried)
		}
	})
}

func TestDeleteAssetsAndBlobsSQL(t *testing.T) {
	now := mediaTestNow()
	t.Run("exhausted refCount deletes the blob", func(t *testing.T) {
		database := &fakeDatabase{nextRows: []fakeRowSet{
			{columns: []string{"refCount"}, values: [][]driver.Value{{int64(1)}}},
			{columns: []string{"refCount"}, values: [][]driver.Value{{int64(1)}}},
		}}
		repository := &sqlMediaAssetRepository{db: openFakeDB(t, database)}
		if err := repository.deleteAssetsAndBlobs(context.Background(), "result-1", map[string]int{"blob-a": 1, "blob-b": 1}, now); err != nil {
			t.Fatalf("delete assets: %v", err)
		}
		assetDeletes := 0
		blobDeletes := 0
		blobUpdates := 0
		for _, executed := range database.executes {
			switch {
			case strings.Contains(executed.query, "DELETE FROM `CrawlMediaAsset`"):
				assetDeletes++
			case strings.Contains(executed.query, "DELETE FROM `CrawlMediaBlob`"):
				blobDeletes++
			case strings.Contains(executed.query, "UPDATE `CrawlMediaBlob`"):
				blobUpdates++
			}
		}
		if assetDeletes != 1 || blobDeletes != 2 || blobUpdates != 0 {
			t.Fatalf("assetDeletes=%d blobDeletes=%d blobUpdates=%d", assetDeletes, blobDeletes, blobUpdates)
		}
	})
	t.Run("shared refCount is decremented", func(t *testing.T) {
		database := &fakeDatabase{nextRows: []fakeRowSet{
			{columns: []string{"refCount"}, values: [][]driver.Value{{int64(5)}}},
			{columns: []string{"refCount"}, values: [][]driver.Value{{int64(5)}}},
		}}
		repository := &sqlMediaAssetRepository{db: openFakeDB(t, database)}
		if err := repository.deleteAssetsAndBlobs(context.Background(), "result-1", map[string]int{"blob-a": 2, "blob-b": 1}, now); err != nil {
			t.Fatalf("delete assets: %v", err)
		}
		blobDeletes := 0
		blobUpdates := 0
		for _, executed := range database.executes {
			switch {
			case strings.Contains(executed.query, "DELETE FROM `CrawlMediaBlob`"):
				blobDeletes++
			case strings.Contains(executed.query, "UPDATE `CrawlMediaBlob`"):
				blobUpdates++
				if len(executed.args) != 3 {
					t.Fatalf("update args = %#v", executed.args)
				}
			}
		}
		if blobDeletes != 0 || blobUpdates != 2 {
			t.Fatalf("blobDeletes=%d blobUpdates=%d", blobDeletes, blobUpdates)
		}
	})
}

func TestRollbackPersistedResultCleansMediaBeforeResultRow(t *testing.T) {
	database := &fakeDatabase{}
	db := openFakeDB(t, database)
	service := &Service{
		db:      db,
		storage: fakeSnapshotStorage{},
		now:     mediaTestNow,
	}
	service.rollbackPersistedResult(context.Background(), testTask(), "result-1")

	if len(database.queried) == 0 || !strings.Contains(database.queried[0], "FROM `CrawlMediaAsset`") {
		t.Fatalf("rollback must list the media assets first: %v", database.queried)
	}
	assetDeleteIndex := -1
	resultDeleteIndex := -1
	for index, executed := range database.executes {
		switch {
		case strings.Contains(executed.query, "DELETE FROM `CrawlMediaAsset`"):
			assetDeleteIndex = index
		case strings.Contains(executed.query, "DELETE FROM `CrawlResult`"):
			resultDeleteIndex = index
		}
	}
	if assetDeleteIndex < 0 || resultDeleteIndex < 0 {
		t.Fatalf("executes = %#v", database.executes)
	}
	if assetDeleteIndex > resultDeleteIndex {
		t.Fatalf("media assets must be deleted before the CrawlResult row: asset=%d result=%d", assetDeleteIndex, resultDeleteIndex)
	}
}
