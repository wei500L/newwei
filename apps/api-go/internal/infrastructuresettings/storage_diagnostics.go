package infrastructuresettings

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// pathStorageConnectionTest is POST /api/admin/settings/storage/test. It is the
// only route this handler serves, and it is registered under the independent
// API_GO_STORAGE_DIAGNOSTICS_MODE switch (the seven configuration routes keep
// using API_GO_INFRASTRUCTURE_SETTINGS_MODE).
const pathStorageConnectionTest = "/api/admin/settings/storage/test"

// storageTestObjectPrefix is the object-key prefix of the probe object. The
// NestJS implementation uses one fixed key; this unit appends a per-run suffix
// so parallel tests cannot overwrite or delete each other's object and an
// existing fixed key is never touched.
const storageTestObjectPrefix = "__healthcheck__/"

// storageTestObjectBodyPrefix is the probe payload prefix (`ok:${Date.now()}`).
const storageTestObjectBodyPrefix = "ok:"

// storageTestDefaultError mirrors the NestJS fallback when no check carried an
// error string but the aggregate still failed.
const storageTestDefaultError = "Storage connection test failed"

// storageConnectionCheck is one diagnostic step result. Field order matches the
// NestJS StorageConnectionCheck literal so the JSON key order is identical.
type storageConnectionCheck struct {
	OK             bool    `json:"ok"`
	Error          *string `json:"error,omitempty"`
	HTTPStatusCode *int    `json:"httpStatusCode,omitempty"`
	RequestID      *string `json:"requestId,omitempty"`
}

// storageConnectionChecks groups the per-mode steps. Only the keys of the
// executed mode are set, so a mysql run never emits null S3 checks and an S3
// run never emits a mysql check.
type storageConnectionChecks struct {
	MySQL        *storageConnectionCheck `json:"mysql,omitempty"`
	HeadBucket   *storageConnectionCheck `json:"headBucket,omitempty"`
	PutObject    *storageConnectionCheck `json:"putObject,omitempty"`
	DeleteObject *storageConnectionCheck `json:"deleteObject,omitempty"`
}

// storageConnectionTestResult is the StorageConnectionTestResult contract.
// Slices of undefined members are omitted rather than serialized as null,
// exactly like JSON.stringify dropping undefined keys.
type storageConnectionTestResult struct {
	OK                     bool                     `json:"ok"`
	Mode                   *string                  `json:"mode,omitempty"`
	Error                  *string                  `json:"error,omitempty"`
	Bucket                 *string                  `json:"bucket,omitempty"`
	Region                 *string                  `json:"region,omitempty"`
	Endpoint               *string                  `json:"endpoint,omitempty"`
	PublicBaseURL          *string                  `json:"publicBaseUrl,omitempty"`
	ForcePathStyle         *bool                    `json:"forcePathStyle,omitempty"`
	PresignedURLTTLSeconds *float64                 `json:"presignedUrlTtlSeconds,omitempty"`
	Checks                 *storageConnectionChecks `json:"checks,omitempty"`
}

// encodeJSON renders the diagnostics payload.
func (r storageConnectionTestResult) encodeJSON() ([]byte, error) { return json.Marshal(r) }

// storageProbe is the three S3 operations the diagnostics run. It is satisfied
// by objectstorage.Client; the seam exists so the aggregation semantics can be
// tested without a live bucket.
type storageProbe interface {
	HeadBucket(ctx context.Context) objectstorage.CheckResult
	PutObject(ctx context.Context, objectKey, body, contentType, cacheControl string) objectstorage.CheckResult
	DeleteObject(ctx context.Context, objectKey string) objectstorage.CheckResult
}

// storageProbeFactory builds the probe for one configuration snapshot.
type storageProbeFactory func(config objectstorage.RuntimeConfig) (storageProbe, error)

// StorageDiagnosticsHandler serves POST /api/admin/settings/storage/test.
//
// The evaluation order matches NestJS: authentication (401) -> settings.manage
// (403) -> body parsing (400/413) -> business. There is deliberately no
// platform-admin second gate: the NestJS controller only declares
// @Permissions("settings.manage") on this route, unlike the PATCH route.
type StorageDiagnosticsHandler struct {
	auth         *Authenticator
	svc          *Service
	probeFactory storageProbeFactory
}

// NewStorageDiagnosticsHandler wires the shared authenticator and settings
// service.
func NewStorageDiagnosticsHandler(auth *Authenticator, svc *Service) *StorageDiagnosticsHandler {
	return &StorageDiagnosticsHandler{
		auth: auth,
		svc:  svc,
		probeFactory: func(config objectstorage.RuntimeConfig) (storageProbe, error) {
			return objectstorage.NewClient(config)
		},
	}
}

// ServeHTTP handles the single taken-over route. Any other method or path is a
// 404; the routing table only ever sends POST for the exact path.
func (h *StorageDiagnosticsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if r.URL.Path != pathStorageConnectionTest || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	if identity := h.auth.authorize(w, r); identity == nil {
		return
	}
	// There is no request DTO: the body cannot override the endpoint or the
	// credentials. Only the JSON parser can reject it, exactly like the
	// Express json middleware NestJS installs before the controller.
	if _, ok := readBodyOrFail(w, r); !ok {
		return
	}
	result, err := h.checkStorageConnection(r.Context())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// NestJS @Post defaults to HTTP 201; a failed individual check still
	// answers 201 with ok:false.
	writeResponse(w, r, http.StatusCreated, result)
}

// checkStorageConnection runs the mode-specific diagnostics. A configuration
// read failure is returned as an error (the NestJS getCrawlImageStorageProvider
// call sits outside the try/catch); an incomplete S3 configuration is reported
// inside the result as ok:false with the mode-level error, exactly like the
// NestJS refreshClient catch.
func (h *StorageDiagnosticsHandler) checkStorageConnection(ctx context.Context) (storageConnectionTestResult, error) {
	config, err := h.svc.StorageRuntimeConfig(ctx)
	if err != nil {
		return storageConnectionTestResult{}, err
	}
	mode := config.Provider
	if mode == "" {
		mode = objectstorage.ProviderMySQL
	}
	if mode == objectstorage.ProviderMySQL {
		check := h.selectOne(ctx)
		result := storageConnectionTestResult{
			OK:     check.OK,
			Mode:   &mode,
			Checks: &storageConnectionChecks{MySQL: &check},
		}
		if !check.OK {
			result.Error = check.Error
		}
		return result, nil
	}

	probe, probeErr := h.newProbe(config)
	if probeErr != nil {
		// StorageService.refreshClient only ever raises the incomplete
		// configuration BadRequestException, and formatAwsError renders it as
		// "<name>: <message>"; any other factory error keeps the generic shape.
		message := objectstorage.IncompleteConfigText
		if !errors.Is(probeErr, objectstorage.ErrIncompleteConfig) {
			message = "Error: " + probeErr.Error()
		}
		return storageConnectionTestResult{OK: false, Mode: &mode, Error: &message}, nil
	}

	// Each step runs independently so a head or put failure still reports the
	// later steps; the delete only ever removes this run's unique key.
	testKey := newStorageTestObjectKey()
	head := probe.HeadBucket(ctx)
	put := probe.PutObject(ctx, testKey, storageTestObjectBodyPrefix+strconv.FormatInt(time.Now().UnixMilli(), 10), "text/plain", "no-store")
	deleted := probe.DeleteObject(ctx, testKey)

	// publicBaseUrl is echoed in its normalized form: StorageService.refreshClient
	// stores `config.publicBaseUrl.replace(/\/$/, "")` before testConnection
	// returns `this.publicBaseUrl`, so exactly one trailing slash is stripped.
	bucket, region := config.Bucket, config.EffectiveRegion()
	publicBaseURL := config.NormalizedPublicBaseURL()
	forcePathStyle, ttl := config.ForcePathStyle, config.PresignedURLTTLSeconds
	result := storageConnectionTestResult{
		OK:                     head.OK && put.OK && deleted.OK,
		Mode:                   &mode,
		Bucket:                 &bucket,
		Region:                 &region,
		PublicBaseURL:          &publicBaseURL,
		ForcePathStyle:         &forcePathStyle,
		PresignedURLTTLSeconds: &ttl,
		Checks: &storageConnectionChecks{
			HeadBucket:   probeCheck(head),
			PutObject:    probeCheck(put),
			DeleteObject: probeCheck(deleted),
		},
	}
	if config.Endpoint != "" {
		endpoint := config.Endpoint
		result.Endpoint = &endpoint
	}
	if !result.OK {
		result.Error = firstCheckError(head, put, deleted)
	}
	return result, nil
}

// newProbe builds the S3 probe for one snapshot. A handler built without a
// factory (only possible in tests) reports the incomplete-configuration result
// instead of panicking.
func (h *StorageDiagnosticsHandler) newProbe(config objectstorage.RuntimeConfig) (storageProbe, error) {
	if h == nil || h.probeFactory == nil {
		return nil, objectstorage.ErrIncompleteConfig
	}
	return h.probeFactory(config)
}

// selectOne runs the real MySQL probe.
func (h *StorageDiagnosticsHandler) selectOne(ctx context.Context) storageConnectionCheck {
	if h == nil || h.svc == nil || h.svc.db == nil {
		return databaseCheck(errNoDatabase)
	}
	var one int
	if err := h.svc.db.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
		return databaseCheck(err)
	}
	return storageConnectionCheck{OK: true}
}

// databaseCheck mirrors StorageService.formatDatabaseError: the error name and
// message. The Go driver has no NestJS exception class name, so the generic
// "Error" name is used.
func databaseCheck(err error) storageConnectionCheck {
	message := "Unknown error"
	if err != nil {
		message = err.Error()
	}
	text := "Error: " + message
	return storageConnectionCheck{OK: false, Error: &text}
}

// probeCheck maps one object storage check result onto the response DTO.
func probeCheck(result objectstorage.CheckResult) *storageConnectionCheck {
	check := &storageConnectionCheck{OK: result.OK}
	if result.Error != "" {
		text := result.Error
		check.Error = &text
	}
	if result.HTTPStatusCode != nil {
		status := *result.HTTPStatusCode
		check.HTTPStatusCode = &status
	}
	if result.RequestID != nil {
		requestID := *result.RequestID
		check.RequestID = &requestID
	}
	return check
}

// firstCheckError mirrors `headBucket.error ?? putObject.error ?? deleteObject.error
// ?? "Storage connection test failed"`: the first non-empty error in head -> put
// -> delete order, with the NestJS fallback text.
func firstCheckError(head, put, deleted objectstorage.CheckResult) *string {
	for _, result := range []objectstorage.CheckResult{head, put, deleted} {
		if result.Error != "" {
			text := result.Error
			return &text
		}
	}
	fallback := storageTestDefaultError
	return &fallback
}

// newStorageTestObjectKey builds a unique probe key under the shared prefix. The
// fixed NestJS key ("__healthcheck__/storage-connection.txt") is deliberately
// not reused: two concurrent tests, or a leftover object from an interrupted
// run, must not overwrite or delete each other.
func newStorageTestObjectKey() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// Deterministic fallback: the nanosecond timestamp still separates two
		// runs of the same process, and the prefix identifies the object.
		return storageTestObjectPrefix + "storage-connection-" + strconv.FormatInt(time.Now().UnixNano(), 10) + ".txt"
	}
	return storageTestObjectPrefix + "storage-connection-" +
		strconv.FormatInt(time.Now().UnixMilli(), 10) + "-" + hex.EncodeToString(buf[:]) + ".txt"
}
