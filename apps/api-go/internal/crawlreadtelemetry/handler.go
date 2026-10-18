package crawlreadtelemetry

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// Exact request paths served by the unit.
const (
	crawlTasksPath             = "/api/crawl-tasks"
	crawlTaskDetailPrefix      = "/api/crawl-tasks/"
	crawlMediaAssetsPrefix     = "/api/crawl-media-assets/"
	crawlQualityPath           = "/api/admin/crawl4ai/quality"
	crawlQualitySourcesPrefix  = "/api/admin/crawl4ai/quality/sources/"
	searchTelemetryRecordPath  = "/api/search-telemetry"
	searchTelemetrySummaryPath = "/api/admin/search-telemetry/summary"
)

// Permission names enforced by the migrated endpoints.
const (
	permissionCrawlRead      = "crawl.read"
	permissionItemsRead      = "items.read"
	permissionSettingsManage = "settings.manage"
)

// crawlResultContentsCollection is the Mongoose default collection name of the
// CrawlResultContent model (no explicit collection is configured).
const crawlResultContentsCollection = "crawlresultcontents"

// taskLogsCollection is the Mongoose default collection name of the TaskLog
// model. It is used for crawl4ai quality aggregation and the latest complete
// run summary.
const taskLogsCollection = "tasklogs"

// crawlQueueName is CRAWL_QUEUE_NAME from the crawl constants.
const crawlQueueName = "crawl4ai"

// Service holds the read-only data sources for the seven endpoints. All reads
// are scoped by the authenticated identity's orgId.
type Service struct {
	db    *sql.DB
	redis *redis.Client
	// crawlResultContents is the Mongo crawlresultcontents collection.
	crawlResultContents *mongo.Collection
	// taskLogs is the Mongo tasklogs collection.
	taskLogs *mongo.Collection
	// jwtSecret is JWT_SECRET, used as the HMAC key for media asset URLs.
	jwtSecret string
	// storageConfig resolves the storage configuration snapshot that signs S3
	// media URLs. It is the same shared settings reader the infrastructure
	// routes use (storage:settings cache + database fallback). A nil reader
	// degrades to the documented branches: no S3 URL in the detail projection
	// and a 400 on the public media route when the configuration cannot be read.
	storageConfig objectstorage.ConfigReader
}

// NewService assembles the read-only sources. database may be nil, in which
// case Mongo-backed lookups fail closed instead of degrading to empty results.
// storageConfig may be nil in tests; production wiring always injects the
// shared infrastructure settings reader.
func NewService(db *sql.DB, redisClient *redis.Client, database *mongo.Database, jwtSecret string, storageConfig objectstorage.ConfigReader) *Service {
	service := &Service{db: db, redis: redisClient, jwtSecret: jwtSecret, storageConfig: storageConfig}
	if database != nil {
		service.crawlResultContents = database.Collection(crawlResultContentsCollection)
		service.taskLogs = database.Collection(taskLogsCollection)
	}
	return service
}

// Handler serves the seven routes under go takeover. Identity comes only from
// the authentication chain; a query parameter named orgId never participates.
type Handler struct {
	auth *authhttp.Authenticator
	svc  *Service
}

// NewHandler builds a handler around the shared authenticator and service.
func NewHandler(auth *authhttp.Authenticator, svc *Service) *Handler {
	return &Handler{auth: auth, svc: svc}
}

// ServeHTTP dispatches the seven migrated routes by exact path shape.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == crawlTasksPath:
		h.serveTaskList(w, r)
	case strings.HasPrefix(r.URL.Path, crawlTaskDetailPrefix):
		h.serveTaskDetail(w, r, segmentAfter(r.URL.Path, crawlTaskDetailPrefix))
	case strings.HasPrefix(r.URL.Path, crawlMediaAssetsPrefix):
		h.serveMediaAsset(w, r)
	case r.URL.Path == crawlQualityPath:
		h.serveQualityOverview(w, r)
	case strings.HasPrefix(r.URL.Path, crawlQualitySourcesPrefix):
		h.serveQualitySource(w, r, segmentAfter(r.URL.Path, crawlQualitySourcesPrefix))
	case r.URL.Path == searchTelemetryRecordPath:
		h.serveTelemetryRecord(w, r)
	case r.URL.Path == searchTelemetrySummaryPath:
		h.serveTelemetrySummary(w, r)
	default:
		authhttp.WriteHTTPException(w, r, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
	}
}

// segmentAfter returns the single path segment following prefix, or an empty
// string when the remainder is empty or contains another separator.
func segmentAfter(path, prefix string) string {
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}

// authorize runs the shared authentication chain and enforces one permission:
//   - missing Authorization / non-Bearer -> 401;
//   - mtk_ machine token -> AuthenticateMachine (SHA-256 tokenHash lookup);
//   - other token -> authhttp.Authenticate (JWT verify, Redis blacklist and
//     MySQL membership/permission re-derivation);
//   - permission missing -> 403.
func (h *Handler) authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	if h == nil || h.svc == nil {
		authhttp.WriteDatabaseFailure(w, r)
		return nil
	}
	raw := rawBearer(r)
	if raw == "" {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	var identity *authhttp.Identity
	if strings.HasPrefix(raw, "mtk_") {
		resolved, err := h.svc.authenticateMachine(r.Context(), raw)
		if err != nil {
			writeServiceError(w, r, err)
			return nil
		}
		identity = resolved
	} else {
		if h.auth == nil {
			authhttp.WriteDatabaseFailure(w, r)
			return nil
		}
		identity = h.auth.Authenticate(w, r)
		if identity == nil {
			return nil
		}
	}
	if !identity.HasPermission(permission) {
		authhttp.WriteForbidden(w, r, []string{permission})
		return nil
	}
	return identity
}

// rawBearer extracts a Bearer token from the Authorization header.
func rawBearer(r *http.Request) string {
	header := r.Header.Get("Authorization")
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}

// querySingle reads one query parameter: exactly one occurrence yields its
// value, missing or repeated parameters yield an empty string. The controllers
// treat both as undefined.
func querySingle(r *http.Request, name string) (string, bool) {
	values := r.URL.Query()[name]
	if len(values) != 1 {
		return "", false
	}
	return values[0], true
}

// writeJSONBody writes an already-marshaled JSON payload without a trailing
// newline, matching Express res.json byte shape.
func writeJSONBody(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
