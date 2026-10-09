package dashboardwarmap

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	// EventsPath 是战争地图事件的精确路径。
	EventsPath = "/api/dashboard/war-map/events"
	// NewsMarkersPath 是新闻标记的精确路径。
	NewsMarkersPath    = "/api/dashboard/war-map/news-markers"
	requiredPermission = "dashboards.read"
)

// Paths 是本开关接管的两个精确 GET。
var Paths = []string{EventsPath, NewsMarkersPath}

type requestAuth interface {
	Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity
}

// Runtime 是地理查询和翻译用的既有环境配置，不是新的存储。
type Runtime struct {
	NominatimBaseURL        string
	NominatimUserAgent      string
	NominatimEmail          string
	NominatimAcceptLanguage string
	GeocodeTimeout          time.Duration
	GeocodeCacheTTL         time.Duration
	GeocodeNegativeTTL      time.Duration
	GeocodeRatePerSecond    int
	TranslationEnabled      bool
	TranslationBaseURL      string
	TranslationTimeout      time.Duration
	TranslationMaxRetries   int
	TranslationFallback     bool
	TranslationFallbackURL  string
	SettingsEncryptionKey   string
}

// Handler 写出 events 与 news-markers。
type Handler struct {
	auth requestAuth
	svc  *Service
	now  func() time.Time
}

// NewHandler 复用已有的鉴权栈、MySQL、Redis 和 Mongo。
func NewHandler(auth *authhttp.Authenticator, db *sql.DB, rdb *redis.Client, database *mongo.Database, cfg Runtime) *Handler {
	store := &mysqlStore{db: db}
	blobs := redisBlobs{client: rdb}
	return &Handler{
		auth: auth,
		svc: &Service{
			articles: store,
			mongo:    newMongoStore(database),
			cache:    blobs,
			geo: newLiveGeocoder(blobs, rdb, store, nominatimConfig{
				BaseURL: cfg.NominatimBaseURL, UserAgent: cfg.NominatimUserAgent,
				Email: cfg.NominatimEmail, AcceptLanguage: cfg.NominatimAcceptLanguage,
				Timeout: cfg.GeocodeTimeout, CacheTTL: cfg.GeocodeCacheTTL,
				NegativeTTL: cfg.GeocodeNegativeTTL, RatePerSecond: cfg.GeocodeRatePerSecond,
			}),
			words: newLiveTranslator(blobs, store, translationConfig{
				Enabled: cfg.TranslationEnabled, BaseURL: cfg.TranslationBaseURL,
				FallbackEnabled: cfg.TranslationFallback, FallbackBaseURL: cfg.TranslationFallbackURL,
				Timeout: cfg.TranslationTimeout, MaxRetries: cfg.TranslationMaxRetries,
				MaxConcurrency: 2, EncryptionKey: cfg.SettingsEncryptionKey,
			}),
		},
		now: time.Now,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	if !identity.HasPermission(requiredPermission) {
		authhttp.WriteForbidden(w, r, []string{requiredPermission})
		return
	}
	query := parseWarQuery(r)
	if message := query.validation(); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	start, end, message := resolveInstant(query, h.clock())
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	opt := query.view()
	var (
		body any
		err  error
	)
	switch r.URL.Path {
	case EventsPath:
		body, err = h.svc.Events(r.Context(), identity.OrgID, start, end, opt)
	case NewsMarkersPath:
		body, err = h.svc.Markers(r.Context(), identity.OrgID, start, end, opt)
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("dashboard war map: read failed")
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
	return time.Now()
}
