package crawlexecution

// This file ports the storeAsset half of
// apps/api/src/modules/crawl/crawl-media-asset.service.ts: provider selection,
// content-type normalization, the S3 dedupe/upload/create/cleanup sequence and
// the MySQL sha256 blob dedupe with refCount bookkeeping.
//
// The MySQL surface is behind mediaAssetRepository so the orchestration can be
// unit tested without a database: the production implementation is a thin
// translation onto database/sql, and the query argument construction is the
// pure buildMediaAssetRow function.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// mediaUploadCacheControl is the Cache-Control of every crawl media object,
// matching uploadObject's `"public, max-age=31536000, immutable"`.
const mediaUploadCacheControl = "public, max-age=31536000, immutable"

// mediaAssetRow is one CrawlMediaAsset insert payload. blobData is always NULL
// (the S3 branch has no blob and the MySQL branch references CrawlMediaBlob).
type mediaAssetRow struct {
	ID          string
	ResultID    string
	OrgID       string
	TaskID      string
	Provider    string
	Kind        string
	SourceURL   string
	Bytes       int
	ContentType *string
	BlobID      *string
	StorageKey  *string
	Width       *int
	Height      *int
	Alt         *string
	Title       *string
	Desc        *string
	Poster      *string
	Format      *string
	// Metadata is the Prisma Json value; the empty extras object is "{}".
	Metadata  json.RawMessage
	CreatedAt time.Time
	UpdatedAt time.Time
}

// mediaAssetRowInput carries the downloaded asset plus the resolved provider for
// buildMediaAssetRow.
type mediaAssetRowInput struct {
	ID          string
	OrgID       string
	TaskID      string
	ResultID    string
	Provider    string
	Asset       downloadedMediaAsset
	ContentType *string
	Now         time.Time
}

// buildMediaAssetRow is buildCreateData: the CrawlMediaAsset column values.
// contentType is already sanitized and metadata is `input.metadata ?? {}` as
// JSON. The function is pure so the column mapping is testable without SQL.
func buildMediaAssetRow(input mediaAssetRowInput) (mediaAssetRow, error) {
	metadata := json.RawMessage("{}")
	if len(input.Asset.Metadata) > 0 {
		encoded, err := encodeMediaRawExtras(input.Asset.Metadata)
		if err != nil {
			return mediaAssetRow{}, err
		}
		metadata = encoded
	}
	return mediaAssetRow{
		ID:          input.ID,
		ResultID:    input.ResultID,
		OrgID:       input.OrgID,
		TaskID:      input.TaskID,
		Provider:    input.Provider,
		Kind:        input.Asset.Kind,
		SourceURL:   input.Asset.SourceURL,
		Bytes:       input.Asset.Bytes,
		ContentType: input.ContentType,
		Width:       input.Asset.Width,
		Height:      input.Asset.Height,
		Alt:         input.Asset.Alt,
		Title:       input.Asset.Title,
		Desc:        input.Asset.Desc,
		Poster:      input.Asset.Poster,
		Format:      input.Asset.Format,
		Metadata:    metadata,
		CreatedAt:   input.Now,
		UpdatedAt:   input.Now,
	}, nil
}

// encodeMediaRawExtras renders CrawlMediaItem.raw as a JSON object with the
// original key order.
func encodeMediaRawExtras(extras mediaRawExtras) (json.RawMessage, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for index, field := range extras {
		if index > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(field.Key)
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		if json.Valid(field.Value) {
			buffer.Write(field.Value)
			continue
		}
		buffer.WriteString("null")
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// s3AssetLookup is the crawlMediaAsset.findFirst dedupe predicate of the S3
// branch. A nil ContentType omits the predicate, exactly like Prisma's
// `contentType: undefined` (which leaves the filter unset).
type s3AssetLookup struct {
	OrgID       string
	Kind        string
	SourceURL   string
	ContentType *string
	Bytes       int
}

// mediaBlobWrite is one CrawlMediaBlob row plus the content used for the sha256
// lookup.
type mediaBlobWrite struct {
	ID          string
	OrgID       string
	SHA256      string
	Bytes       int
	ContentType *string
	Data        []byte
	Now         time.Time
}

// mediaRollbackAsset is the deleteAssetsByResultId projection.
type mediaRollbackAsset struct {
	ID         string
	OrgID      string
	Provider   string
	BlobID     *string
	StorageKey *string
}

// mediaAssetRepository is the MySQL surface the media writer needs.
type mediaAssetRepository interface {
	// findReusableS3Asset returns the storage key of the oldest S3 asset that
	// matches the dedupe predicate. found reports whether a row matched; a
	// matched row may carry a NULL storage key (the NestJS coalesce case).
	findReusableS3Asset(ctx context.Context, lookup s3AssetLookup) (storageKey *string, found bool, err error)
	// insertAsset inserts one CrawlMediaAsset row.
	insertAsset(ctx context.Context, row mediaAssetRow) error
	// storeMysqlAsset runs the CrawlMediaBlob dedupe/refCount transaction and
	// inserts the asset row in the same transaction.
	storeMysqlAsset(ctx context.Context, row mediaAssetRow, blob mediaBlobWrite) error
	// listAssetsByResultID loads the assets of one result for the rollback
	// cleanup.
	listAssetsByResultID(ctx context.Context, resultID string) ([]mediaRollbackAsset, error)
	// countS3References counts the other assets of the same organisation that
	// share one S3 object key.
	countS3References(ctx context.Context, orgID, storageKey, excludeResultID string) (int, error)
	// deleteAssetsAndBlobs deletes the result's asset rows and releases the
	// MySQL blob references in one transaction.
	deleteAssetsAndBlobs(ctx context.Context, resultID string, blobRefCounts map[string]int, now time.Time) error
}

// mediaStore is CrawlMediaAssetService.storeAsset.
type mediaStore struct {
	storageConfig mediaStorageConfigReader
	repository    mediaAssetRepository
	httpClient    *http.Client
	now           func() time.Time
	newID         func() (string, error)
	newObjects    func(config objectstorage.RuntimeConfig) (mediaObjectWriter, error)
}

// newMediaStore builds the media writer from the Service wiring. A missing
// database handle or storage configuration reader is the NestJS
// "CrawlMediaAssetService is unavailable" branch: asset storage is skipped and
// the crawl result still persists.
func newMediaStore(service *Service) *mediaStore {
	db, storageConfig := service.mediaStorageDependencies()
	if db == nil || storageConfig == nil {
		return nil
	}
	now := service.now
	if now == nil {
		now = time.Now
	}
	return &mediaStore{
		storageConfig: storageConfig,
		repository:    &sqlMediaAssetRepository{db: db},
		httpClient:    &http.Client{},
		now:           now,
		newID:         newRowID,
		newObjects: func(config objectstorage.RuntimeConfig) (mediaObjectWriter, error) {
			return objectstorage.NewClient(config)
		},
	}
}

// resolveProvider reads the storage snapshot and the effective
// CrawlImageStorageProvider. A reader that exposes the provider method decides
// from `crawl_image_storage`; otherwise the snapshot provider is used (empty
// means mysql).
func (m *mediaStore) resolveProvider(ctx context.Context) (string, objectstorage.RuntimeConfig, error) {
	snapshot, err := m.storageConfig.StorageRuntimeConfig(ctx)
	if err != nil {
		return "", objectstorage.RuntimeConfig{}, err
	}
	if reader, ok := m.storageConfig.(mediaStorageProviderReader); ok {
		provider, providerErr := reader.CrawlImageStorageProvider(ctx)
		if providerErr != nil {
			return "", objectstorage.RuntimeConfig{}, providerErr
		}
		return normalizeMediaProvider(provider), snapshot, nil
	}
	return normalizeMediaProvider(snapshot.Provider), snapshot, nil
}

// storeAsset is storeAsset: sanitize the content type, build the row, then
// follow the S3 or MySQL branch.
func (m *mediaStore) storeAsset(ctx context.Context, task *taskRow, resultID string, downloaded downloadedMediaAsset) error {
	provider, snapshot, err := m.resolveProvider(ctx)
	if err != nil {
		return err
	}
	contentType := sanitizeStoredContentType(downloaded.ContentType)
	now := m.now().UTC().Truncate(time.Millisecond)
	assetID, err := m.newID()
	if err != nil {
		return err
	}
	row, err := buildMediaAssetRow(mediaAssetRowInput{
		ID:          assetID,
		OrgID:       task.OrgID,
		TaskID:      task.ID,
		ResultID:    resultID,
		Provider:    provider,
		Asset:       downloaded,
		ContentType: contentType,
		Now:         now,
	})
	if err != nil {
		return err
	}
	if provider == objectstorage.ProviderS3 {
		return m.storeS3Asset(ctx, snapshot, row, downloaded.Data)
	}
	blobID, err := m.newID()
	if err != nil {
		return err
	}
	digest := sha256.Sum256(downloaded.Data)
	return m.repository.storeMysqlAsset(ctx, row, mediaBlobWrite{
		ID:          blobID,
		OrgID:       task.OrgID,
		SHA256:      hex.EncodeToString(digest[:]),
		Bytes:       downloaded.Bytes,
		ContentType: contentType,
		Data:        downloaded.Data,
		Now:         now,
	})
}

// storeS3Asset is the S3 branch: reuse a matching object key, upload only when
// no row matched, insert the row, and delete the object when the insert fails.
//
// The dedupe is (orgId, kind, sourceUrl, contentType, bytes) like the NestJS
// findFirst; a matched row that carries a NULL storage key gets a fresh key but
// still skips the upload, and the cleanup on insert failure deletes the object
// even when it was reused — both are literal NestJS behaviours.
func (m *mediaStore) storeS3Asset(ctx context.Context, config objectstorage.RuntimeConfig, row mediaAssetRow, data []byte) error {
	existingKey, found, err := m.repository.findReusableS3Asset(ctx, s3AssetLookup{
		OrgID:       row.OrgID,
		Kind:        row.Kind,
		SourceURL:   row.SourceURL,
		ContentType: row.ContentType,
		Bytes:       row.Bytes,
	})
	if err != nil {
		return err
	}
	var objects mediaObjectWriter
	openObjects := func() (mediaObjectWriter, error) {
		if objects != nil {
			return objects, nil
		}
		writer, openErr := m.newObjects(config)
		if openErr != nil {
			return nil, openErr
		}
		objects = writer
		return writer, nil
	}

	storageKey := ""
	if found && existingKey != nil {
		// `existingAsset.storageKey ?? buildStorageKey`: only a NULL key falls
		// back to a fresh key, an empty string is kept verbatim.
		storageKey = *existingKey
	} else {
		unique, uniqueErr := newMediaUUIDv4()
		if uniqueErr != nil {
			return uniqueErr
		}
		storageKey = buildMediaStorageKey(row.OrgID, row.TaskID, row.ResultID, row.ContentType, row.CreatedAt, unique)
	}
	if !found {
		writer, openErr := openObjects()
		if openErr != nil {
			return openErr
		}
		contentType := defaultBinaryContentType
		if row.ContentType != nil && *row.ContentType != "" {
			contentType = *row.ContentType
		}
		if result := writer.PutObject(ctx, storageKey, string(data), contentType, mediaUploadCacheControl); !result.OK {
			return fmt.Errorf("crawlexecution: upload crawl media object %s: %s", storageKey, result.Error)
		}
	}
	row.StorageKey = &storageKey
	if insertErr := m.repository.insertAsset(ctx, row); insertErr != nil {
		log.Printf("crawlexecution: failed to persist crawl media DB record after S3 upload orgId=%s taskId=%s resultId=%s storageKey=%s: %v",
			row.OrgID, row.TaskID, row.ResultID, storageKey, insertErr)
		writer, openErr := openObjects()
		if openErr != nil {
			log.Printf("crawlexecution: failed to cleanup orphaned crawl media object storageKey=%s: %v", storageKey, openErr)
			return insertErr
		}
		if result := writer.DeleteObject(ctx, storageKey); !result.OK {
			log.Printf("crawlexecution: failed to cleanup orphaned crawl media object storageKey=%s: %s", storageKey, result.Error)
		}
		return insertErr
	}
	return nil
}

// buildMediaStorageKey is buildStorageKey:
// `crawl-media/<orgId>/<taskId>/<resultId>/<Date.now()>-<randomUUID><ext>`.
func buildMediaStorageKey(orgID, taskID, resultID string, contentType *string, now time.Time, unique string) string {
	suffix := ""
	if extension := pickExtension(contentType); extension != "" {
		suffix = "." + extension
	}
	return "crawl-media/" + orgID + "/" + taskID + "/" + resultID + "/" +
		strconv.FormatInt(now.UnixMilli(), 10) + "-" + unique + suffix
}

// deleteAssetsByResultID is deleteAssetsByResultId: release the S3 objects that
// no other asset references, then delete the asset rows and release the MySQL
// blob refCounts in one transaction. Per-object failures are logged and do not
// abort the cleanup, exactly like the NestJS try/catch around deleteObject.
func (m *mediaStore) deleteAssetsByResultID(ctx context.Context, task *taskRow, resultID string) error {
	assets, err := m.repository.listAssetsByResultID(ctx, resultID)
	if err != nil {
		return err
	}
	for _, asset := range assets {
		if asset.Provider != objectstorage.ProviderS3 || asset.StorageKey == nil || *asset.StorageKey == "" {
			continue
		}
		references, countErr := m.repository.countS3References(ctx, asset.OrgID, *asset.StorageKey, resultID)
		if countErr != nil {
			log.Printf("crawlexecution: failed to count crawl media S3 references taskId=%s orgId=%s resultId=%s storageKey=%s: %v",
				task.ID, asset.OrgID, resultID, *asset.StorageKey, countErr)
			continue
		}
		if references != 0 {
			continue
		}
		config, configErr := m.storageConfig.StorageRuntimeConfig(ctx)
		if configErr != nil {
			log.Printf("crawlexecution: failed to read storage configuration for crawl media cleanup storageKey=%s: %v", *asset.StorageKey, configErr)
			continue
		}
		writer, openErr := m.newObjects(config)
		if openErr != nil {
			log.Printf("crawlexecution: failed to build storage client for crawl media cleanup storageKey=%s: %v", *asset.StorageKey, openErr)
			continue
		}
		if result := writer.DeleteObject(ctx, *asset.StorageKey); !result.OK {
			log.Printf("crawlexecution: failed to cleanup S3 crawl media asset during rollback resultId=%s assetId=%s orgId=%s storageKey=%s: %s",
				resultID, asset.ID, asset.OrgID, *asset.StorageKey, result.Error)
		}
	}
	blobRefCounts := make(map[string]int, len(assets))
	for _, asset := range assets {
		if asset.Provider != objectstorage.ProviderMySQL || asset.BlobID == nil {
			continue
		}
		blobRefCounts[*asset.BlobID]++
	}
	return m.repository.deleteAssetsAndBlobs(ctx, resultID, blobRefCounts, m.now().UTC().Truncate(time.Millisecond))
}

// newMediaUUIDv4 builds a canonical random UUID v4, the shape randomUUID()
// produces for the S3 object name.
func newMediaUUIDv4() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	value := hex.EncodeToString(buffer[:])
	return value[0:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:32], nil
}

// sqlMediaAssetRepository is the database/sql implementation.
type sqlMediaAssetRepository struct {
	db *sql.DB
}

// mediaSQLExecutor is the subset shared by *sql.DB and *sql.Tx.
type mediaSQLExecutor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// findReusableS3Asset is the crawlMediaAsset.findFirst of the S3 branch.
func (r *sqlMediaAssetRepository) findReusableS3Asset(ctx context.Context, lookup s3AssetLookup) (*string, bool, error) {
	query := "SELECT `storageKey` FROM `CrawlMediaAsset` WHERE `orgId` = ? AND `kind` = ? AND `sourceUrl` = ? AND `bytes` = ? AND `provider` = ?"
	args := []any{lookup.OrgID, lookup.Kind, lookup.SourceURL, lookup.Bytes, objectstorage.ProviderS3}
	if lookup.ContentType != nil {
		query += " AND `contentType` = ?"
		args = append(args, *lookup.ContentType)
	}
	query += " ORDER BY `createdAt` ASC LIMIT 1"
	var storageKey sql.NullString
	err := r.db.QueryRowContext(ctx, query, args...).Scan(&storageKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("crawlexecution: find reusable crawl media asset: %w", err)
	}
	if !storageKey.Valid {
		return nil, true, nil
	}
	return &storageKey.String, true, nil
}

// insertAsset inserts the CrawlMediaAsset row (blobData stays NULL).
func (r *sqlMediaAssetRepository) insertAsset(ctx context.Context, row mediaAssetRow) error {
	return insertMediaAssetRow(ctx, r.db, row)
}

// storeMysqlAsset is storeMysqlAsset: one transaction resolves the
// (orgId, sha256) blob, increments its refCount when it exists, creates it
// otherwise (a 1062 race reads the winner back and increments it), and inserts
// the asset row.
func (r *sqlMediaAssetRepository) storeMysqlAsset(ctx context.Context, row mediaAssetRow, blob mediaBlobWrite) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("crawlexecution: begin crawl media transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	blobID, err := resolveMediaBlobID(ctx, sqlMediaBlobStore{tx: tx}, blob)
	if err != nil {
		return err
	}
	row.BlobID = &blobID
	if err := insertMediaAssetRow(ctx, tx, row); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("crawlexecution: commit crawl media transaction: %w", err)
	}
	return nil
}

// listAssetsByResultID loads the rollback projection of the result's assets.
func (r *sqlMediaAssetRepository) listAssetsByResultID(ctx context.Context, resultID string) ([]mediaRollbackAsset, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT `id`, `orgId`, `provider`, `blobId`, `storageKey` FROM `CrawlMediaAsset` WHERE `resultId` = ?",
		resultID)
	if err != nil {
		return nil, fmt.Errorf("crawlexecution: list crawl media assets: %w", err)
	}
	defer func() { _ = rows.Close() }()
	assets := make([]mediaRollbackAsset, 0, 4)
	for rows.Next() {
		var asset mediaRollbackAsset
		var blobID sql.NullString
		var storageKey sql.NullString
		if scanErr := rows.Scan(&asset.ID, &asset.OrgID, &asset.Provider, &blobID, &storageKey); scanErr != nil {
			return nil, scanErr
		}
		if blobID.Valid {
			asset.BlobID = &blobID.String
		}
		if storageKey.Valid {
			asset.StorageKey = &storageKey.String
		}
		assets = append(assets, asset)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return assets, nil
}

// countS3References counts other assets that still share one object key.
func (r *sqlMediaAssetRepository) countS3References(ctx context.Context, orgID, storageKey, excludeResultID string) (int, error) {
	var count int
	if err := r.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM `CrawlMediaAsset` WHERE `orgId` = ? AND `storageKey` = ? AND `provider` = ? AND `resultId` <> ?",
		orgID, storageKey, objectstorage.ProviderS3, excludeResultID).Scan(&count); err != nil {
		return 0, fmt.Errorf("crawlexecution: count crawl media S3 references: %w", err)
	}
	return count, nil
}

// deleteAssetsAndBlobs deletes the result's asset rows, then for each referenced
// blob either removes it (its refCount is exhausted by this result) or
// decrements the refCount.
func (r *sqlMediaAssetRepository) deleteAssetsAndBlobs(ctx context.Context, resultID string, blobRefCounts map[string]int, now time.Time) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("crawlexecution: begin crawl media cleanup transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "DELETE FROM `CrawlMediaAsset` WHERE `resultId` = ?", resultID); err != nil {
		return fmt.Errorf("crawlexecution: delete crawl media assets: %w", err)
	}
	for blobID, released := range blobRefCounts {
		var current int
		err := tx.QueryRowContext(ctx,
			"SELECT `refCount` FROM `CrawlMediaBlob` WHERE `id` = ?", blobID).Scan(&current)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("crawlexecution: read crawl media blob refCount: %w", err)
		}
		if current <= released {
			if _, err := tx.ExecContext(ctx, "DELETE FROM `CrawlMediaBlob` WHERE `id` = ?", blobID); err != nil {
				return fmt.Errorf("crawlexecution: delete crawl media blob: %w", err)
			}
			continue
		}
		if _, err := tx.ExecContext(ctx,
			"UPDATE `CrawlMediaBlob` SET `refCount` = `refCount` - ?, `updatedAt` = ? WHERE `id` = ?",
			released, now, blobID); err != nil {
			return fmt.Errorf("crawlexecution: decrement crawl media blob refCount: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("crawlexecution: commit crawl media cleanup transaction: %w", err)
	}
	return nil
}

// mediaBlobStore is the CrawlMediaBlob transaction surface resolveMediaBlobID
// needs. The production implementation wraps *sql.Tx; tests supply an in-memory
// fake to exercise the find/create/conflict/refCount decisions.
type mediaBlobStore interface {
	findBlobID(ctx context.Context, orgID, sha256 string) (id string, found bool, err error)
	createBlob(ctx context.Context, blob mediaBlobWrite) error
	incrementRefCount(ctx context.Context, blobID string, now time.Time) error
}

// sqlMediaBlobStore is the *sql.Tx implementation of mediaBlobStore.
type sqlMediaBlobStore struct {
	tx *sql.Tx
}

func (s sqlMediaBlobStore) findBlobID(ctx context.Context, orgID, sha256 string) (string, bool, error) {
	var id string
	err := s.tx.QueryRowContext(ctx,
		"SELECT `id` FROM `CrawlMediaBlob` WHERE `orgId` = ? AND `sha256` = ? LIMIT 1",
		orgID, sha256).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

func (s sqlMediaBlobStore) createBlob(ctx context.Context, blob mediaBlobWrite) error {
	_, err := s.tx.ExecContext(ctx,
		"INSERT INTO `CrawlMediaBlob` (`id`, `orgId`, `sha256`, `bytes`, `contentType`, `blobData`, `refCount`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
		blob.ID, blob.OrgID, blob.SHA256, blob.Bytes, nullableString(blob.ContentType),
		blob.Data, blob.Now, blob.Now)
	return err
}

func (s sqlMediaBlobStore) incrementRefCount(ctx context.Context, blobID string, now time.Time) error {
	_, err := s.tx.ExecContext(ctx,
		"UPDATE `CrawlMediaBlob` SET `refCount` = `refCount` + 1, `updatedAt` = ? WHERE `id` = ?",
		now, blobID)
	return err
}

// resolveMediaBlobID is the crawlMediaBlob findUnique/create branch: an existing
// blob takes the refCount increment path, a new blob is created, and a 1062 race
// on (orgId, sha256) reads the winner back and increments it (the Prisma P2002
// recovery).
func resolveMediaBlobID(ctx context.Context, store mediaBlobStore, blob mediaBlobWrite) (string, error) {
	existingID, found, err := store.findBlobID(ctx, blob.OrgID, blob.SHA256)
	if err != nil {
		return "", fmt.Errorf("crawlexecution: find crawl media blob: %w", err)
	}
	if found {
		if err := store.incrementRefCount(ctx, existingID, blob.Now); err != nil {
			return "", fmt.Errorf("crawlexecution: increment crawl media blob refCount: %w", err)
		}
		return existingID, nil
	}
	if err := store.createBlob(ctx, blob); err != nil {
		if !isUniqueConflict(err) {
			return "", fmt.Errorf("crawlexecution: create crawl media blob: %w", err)
		}
		racedID, racedFound, findErr := store.findBlobID(ctx, blob.OrgID, blob.SHA256)
		if findErr != nil {
			return "", fmt.Errorf("crawlexecution: read raced crawl media blob: %w", findErr)
		}
		if !racedFound {
			return "", errors.New("crawlexecution: raced crawl media blob disappeared")
		}
		if err := store.incrementRefCount(ctx, racedID, blob.Now); err != nil {
			return "", fmt.Errorf("crawlexecution: increment raced crawl media blob refCount: %w", err)
		}
		return racedID, nil
	}
	return blob.ID, nil
}

// insertMediaAssetRow inserts one CrawlMediaAsset row. blobData is left NULL on
// both branches (the MySQL payload lives in CrawlMediaBlob).
func insertMediaAssetRow(ctx context.Context, executor mediaSQLExecutor, row mediaAssetRow) error {
	if _, err := executor.ExecContext(ctx,
		"INSERT INTO `CrawlMediaAsset` (`id`, `resultId`, `orgId`, `taskId`, `provider`, `kind`, `sourceUrl`, `bytes`, "+
			"`contentType`, `blobId`, `storageKey`, `width`, `height`, `alt`, `title`, `desc`, `poster`, `format`, `metadata`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		row.ID, row.ResultID, row.OrgID, row.TaskID, row.Provider, row.Kind, row.SourceURL, row.Bytes,
		nullableString(row.ContentType), nullableString(row.BlobID), nullableString(row.StorageKey),
		nullableInt(row.Width), nullableInt(row.Height), nullableString(row.Alt), nullableString(row.Title),
		nullableString(row.Desc), nullableString(row.Poster), nullableString(row.Format), []byte(row.Metadata),
		row.CreatedAt, row.UpdatedAt); err != nil {
		return fmt.Errorf("crawlexecution: insert crawl media asset: %w", err)
	}
	return nil
}

// nullableInt maps an optional int onto a SQL NULL-able argument.
func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}
