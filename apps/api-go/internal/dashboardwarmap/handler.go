package dashboardwarmap

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	// EventsPath 是战争地图事件的精确路径。
	EventsPath = "/api/dashboard/war-map/events"
	// NewsMarkersPath 是新闻标记的精确路径。
	NewsMarkersPath = "/api/dashboard/war-map/news-markers"
	// TransportPath 与 LayersPath 使用各自的开关，不进入 Paths。
	TransportPath      = "/api/dashboard/war-map/transport-detail"
	LayersPath         = "/api/dashboard/war-map/layers"
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
	SignalsEnabled          bool
	SignalsTimeoutMs        int
	OpenskyEnabled          bool
	OpenskyDailyBudget      int
	OpenskyDayIntervalSec   int
	OpenskyNightIntervalSec int
	OpenskyDayStartHour     int
	OpenskyNightStartHour   int
	OpenskyWarningPct       int
	OpenskyCriticalPct      int
	OpenskyBaseURL          string
	OpenskyTokenURL         string
	OpenskyClientID         string
	OpenskyClientSecret     string
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
	mongoStore := newMongoStore(database)
	return &Handler{
		auth: auth,
		svc: &Service{
			articles: store,
			mongo:    mongoStore,
			tracks:   mongoStore,
			cache:    blobs,
			snaps:    redisSnapshots{cache: blobs},
			sky: newLiveOpensky(rdb, blobs, store, openskyEnv{
				SignalsEnabled: cfg.SignalsEnabled, TimeoutMs: cfg.SignalsTimeoutMs, Enabled: cfg.OpenskyEnabled,
				Daily: cfg.OpenskyDailyBudget, DayInterval: cfg.OpenskyDayIntervalSec, NightInterval: cfg.OpenskyNightIntervalSec,
				DayStart: cfg.OpenskyDayStartHour, NightStart: cfg.OpenskyNightStartHour,
				Warning: cfg.OpenskyWarningPct, Critical: cfg.OpenskyCriticalPct,
				BaseURL: cfg.OpenskyBaseURL, TokenURL: cfg.OpenskyTokenURL,
				ClientID: cfg.OpenskyClientID, Secret: cfg.OpenskyClientSecret, EncryptionKey: cfg.SettingsEncryptionKey,
			}),
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
	switch r.URL.Path {
	case TransportPath:
		h.serveTransport(w, r)
	case LayersPath:
		h.serveLayers(w, r)
	default:
		h.serveEvents(w, r)
	}
}

func (h *Handler) serveEvents(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
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

func (h *Handler) serveTransport(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
		return
	}
	query := parseTransportQuery(r.URL.RawQuery)
	if message := query.validation(); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	kind := parseTransportKind(query.kind.value)
	if kind == "" {
		authhttp.WriteCodedBadRequest(w, r, "INVALID_TRANSPORT_KIND", "Transport kind must be aircraft or vessel.")
		return
	}
	start, end, message := resolveInstant(query.warQuery, h.clock())
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	body, err := h.svc.TransportDetail(r.Context(), identity.OrgID, kind, query.objectKey.value, start, end, parseTransportLimit(query.limit.value, query.limit.set))
	if err != nil {
		if errors.Is(err, errTransportKey) {
			authhttp.WriteBadRequest(w, r, err.Error())
			return
		}
		log.Printf("dashboard war map: transport detail failed")
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSON(w, body)
}

func (h *Handler) serveLayers(w http.ResponseWriter, r *http.Request) {
	identity := h.authorize(w, r)
	if identity == nil {
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
	opt.FlightMode = parseFlightMode(query.flightMode.value)
	opt.AisMode = parseAisMode(query.aisMode.value)
	body, err := h.svc.Layers(r.Context(), identity.OrgID, start, end, opt)
	if err != nil {
		var bad *requestError
		if errors.As(err, &bad) {
			authhttp.WriteBadRequest(w, r, bad.message)
			return
		}
		log.Printf("dashboard war map: layers failed")
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeJSON(w, body)
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

func parseFlightMode(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "all") {
		return "all"
	}
	return "military"
}

func parseAisMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "all":
		return "all"
	case "density":
		return "density"
	default:
		return "military"
	}
}

func writeJSON(w http.ResponseWriter, body any) {
	encoded, err := json.Marshal(body)
	if err != nil {
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
