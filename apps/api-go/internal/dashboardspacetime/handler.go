package dashboardspacetime

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
)

type requestAuth interface {
	Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity
}

// Handler 写出热力图与传播图的四个只读 GET。
type Handler struct {
	auth requestAuth
	svc  *Service
	now  func() time.Time
}

// NewHandler 复用已有的鉴权栈、MySQL、Redis 和 Mongo。
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, rdb *redis.Client, database *mongo.Database, geo dashboardwarmap.PlaceConfig) *Handler {
	var items itemReader
	if database != nil {
		items = &mongoItems{coll: database.Collection(processedItemsName)}
	}
	return &Handler{
		auth: auth,
		svc: &Service{
			articles: &mysqlArticles{db: db},
			items:    items,
			snaps:    redisSnapshots{client: rdb},
			geo:      dashboardwarmap.NewPlaceResolver(rdb, db, geo),
		},
		now: time.Now,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case GeoPath:
		h.serveGeo(w, r)
	case GeoArticlesPath:
		h.serveGeoArticles(w, r)
	case PropagationPath:
		h.servePropagation(w, r)
	case PropagationArticlesPath:
		h.servePropagationArticles(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveGeo(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query := parseGeoQuery(r.URL.RawQuery)
	if message := query.validation(); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	start, end, message := resolveAlignedRange(query.timeQuery, h.clock())
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	buckets := query.includeBuckets.value == "1" || query.includeBuckets.value == "true"
	body, err := h.svc.Heatmap(r.Context(), identity.OrgID, start, end, query.eventID.value, buckets)
	h.write(w, r, body, err)
}

func (h *Handler) serveGeoArticles(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query := parseGeoArticlesQuery(r.URL.RawQuery)
	if message := query.validation(); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	start, end, message := resolveAlignedRange(query.timeQuery, h.clock())
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	limit := parsePositiveLimit(query.limit, geoArticleDefault, geoArticleLimit)
	body, err := h.svc.HeatmapArticles(r.Context(), identity.OrgID, start, end, query.eventID.value, query.snapshotID.value, query.pointID.value, query.bucketStart.value, limit)
	h.write(w, r, body, err)
}

func (h *Handler) servePropagation(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query := parsePropQuery(r.URL.RawQuery)
	if message := query.validation(); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	start, end, message := resolveAlignedRange(query.timeQuery, h.clock())
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	body, err := h.svc.Propagation(
		r.Context(), identity.OrgID, query.eventID.value, start, end,
		parseBoundedInt(query.window, propWindowDefault, 1, propWindowMax),
		parseBoundedInt(query.maxNodes, propNodesDefault, propNodesMin, propNodesMax),
		parseBoundedInt(query.maxEdges, propEdgesDefault, propEdgesMin, propEdgesMax),
		parseBoundedInt(query.maxPred, propPredDefault, 1, propPredMax),
	)
	h.write(w, r, body, err)
}

func (h *Handler) servePropagationArticles(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query := parsePropArticlesQuery(r.URL.RawQuery)
	if message := query.validation(); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	start, end, message := resolveAlignedRange(query.timeQuery, h.clock())
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	limit := parsePositiveLimit(query.limit, propArticleDefault, propArticleLimit)
	body, err := h.svc.PropagationArticles(r.Context(), identity.OrgID, query.eventID.value, query.source.value, query.cursorStart.value, query.cursorEnd.value, start, end, limit)
	h.write(w, r, body, err)
}

// ReadHeatmap 读取与 GET geo-heatmap 相同的总览，不带 eventId，也不展开 buckets。
func (h *Handler) ReadHeatmap(ctx context.Context, orgID string, start, end time.Time) ([]byte, error) {
	body, err := h.svc.Heatmap(ctx, orgID, start, end, "", false)
	if err != nil {
		return nil, err
	}
	return json.Marshal(body)
}

func (h *Handler) authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return nil
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return nil
	}
	if !identity.HasPermission(requiredPermission) {
		authhttp.WriteForbidden(w, r, []string{requiredPermission})
		return nil
	}
	return identity
}

func (h *Handler) write(w http.ResponseWriter, r *http.Request, body any, err error) {
	if err != nil {
		var bad *badRequest
		if errors.As(err, &bad) {
			authhttp.WriteBadRequest(w, r, bad.Error())
			return
		}
		log.Printf("dashboard spacetime: read failed")
		authhttp.WriteInternalFailure(w, r)
		return
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
}

func (h *Handler) clock() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now().UTC()
}
