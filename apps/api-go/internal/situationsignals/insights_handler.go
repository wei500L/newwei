package situationsignals

import (
	"context"
	"database/sql"
	"math"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

const insightsPath = "/api/situation-monitor/insights"

// insightsService owns the read-only insights pipeline. It reuses the signal
// Service for monitor matching, feedback learning states and the settings
// envelope/decryption helpers; the shared MySQL, Redis and Mongo clients mean
// the takeover adds no connection pool.
type insightsService struct {
	db       *sql.DB
	signals  *Service
	cache    insightsCache
	mongo    *mongo.Database
	settings *settingsReader
	client   *http.Client
	now      func() time.Time

	// Provider endpoints are fields so httptest can substitute them without a
	// second code path. Production always uses the canonical constants.
	finnhubURL         string
	fredURL            string
	coinGeckoURL       string
	finnhubKeyResolver func(context.Context) string
	fredKeyResolver    func(context.Context) string
}

// NewInsightsService wires the insights pipeline. The caller passes the same
// clients used by the rest of the gateway.
func NewInsightsService(db *sql.DB, redisClient *redis.Client, mongoDatabase *mongo.Database, settings *settingsReader) *insightsService {
	signals := NewService(db, redisClient, mongoDatabase, settings)
	return &insightsService{
		db:                 db,
		signals:            signals,
		cache:              newInsightsCache(redisClient),
		mongo:              mongoDatabase,
		settings:           settings,
		client:             &http.Client{Timeout: 30 * time.Second},
		now:                time.Now,
		finnhubURL:         insightsFinnhubQuoteURL,
		fredURL:            insightsFredObservationsURL,
		coinGeckoURL:       insightsCoinGeckoURL,
		finnhubKeyResolver: nil,
		fredKeyResolver:    nil,
	}
}

// insightsHandler serves exactly GET /api/situation-monitor/insights.
type insightsHandler struct {
	auth    *Authenticator
	service *insightsService
}

// NewInsightsHandler wires the handler.
func NewInsightsHandler(auth *Authenticator, service *insightsService) *insightsHandler {
	return &insightsHandler{auth: auth, service: service}
}

// ServeHTTP implements the route. The gateway only routes this exact path and
// method here; the guard is a safety net.
func (h *insightsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != insightsPath || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	h.serveInsights(w, r)
}

func (h *insightsHandler) serveInsights(w http.ResponseWriter, r *http.Request) {
	identity := h.auth.authorize(w, r, requiredReadPerm)
	if identity == nil {
		return
	}
	if h.service == nil {
		writeServiceError(w, r, errNoDatabase)
		return
	}
	options, err := parseInsightsQuery(r.URL.Query())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response, err := h.service.getInsights(r.Context(), identity.OrgID, options)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if options.Translate {
		result := h.service.applyZhTranslationsBestEffort(r.Context(), &response)
		response.Translation = &translationStatus{Target: "zh-CN", Applied: result.Applied, Error: result.Error}
	}
	if err := h.service.augmentInsights(r.Context(), identity.OrgID, identity.UserID, &response); err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// insightsTranslationResult mirrors the best-effort translation return value.
type insightsTranslationResult struct {
	Applied bool
	Error   string
}

// getInsights runs the requested sections and assembles the base response.
func (s *insightsService) getInsights(ctx context.Context, orgID string, options insightsOptions) (insightsResponse, error) {
	windowHours := clampInsightsInt(options.WindowHours, 1, 168, insightsDefaultWindowHours)
	maxItems := clampInsightsInt(options.MaxItems, 50, 1000, insightsDefaultMaxItems)
	analysisPerCategory := maxInt(insightsMaxHeadlinesPerCategory, minInt(60, int(math.Ceil(float64(maxItems)/float64(len(analysis.Categories))))))
	since := s.now().Add(-time.Duration(windowHours) * time.Hour)

	requested := normalizeInsightsSections(options.Sections)
	includeCore := len(requested) == 0 || requested["core"]
	includeExternal := len(requested) == 0 || requested["external"]

	response := insightsResponse{
		GeneratedAt:   formatJSIso(s.now()),
		WindowHours:   windowHours,
		MaxItems:      maxItems,
		AnalyzedItems: 0,
	}
	allowGdelt := s.isGdeltEnabled()
	if options.Gdelt != nil {
		allowGdelt = *options.Gdelt
	}
	scope := options.Scope
	if scope != "tagged" {
		scope = "all"
	}

	if includeCore {
		learningRevision, err := insightsLearningRevision(ctx, s.cache, orgID)
		if err != nil {
			return response, err
		}
		key := insightsCacheKey(orgID, "core", windowHours, maxItems, scope, allowGdelt, options.Debug, learningRevision)
		core, err := insightsWrap(ctx, s.cache, key, insightsCacheTTLSecondsCore*time.Second, func(ctx context.Context) (insightsCorePayload, error) {
			return s.loadCore(ctx, orgID, since, windowHours, maxItems, analysisPerCategory, allowGdelt, scope, options.Debug)
		})
		if err != nil {
			return response, err
		}
		applyCorePayload(&response, core)
	}

	if includeExternal {
		key := insightsCacheKey(orgID, "external", windowHours, maxItems, scope, allowGdelt, options.Debug, 0)
		external, err := insightsWrap(ctx, s.cache, key, insightsCacheTTLSecondsExternal*time.Second, func(ctx context.Context) (insightsExternalPayload, error) {
			return s.loadExternal(ctx), nil
		})
		if err != nil {
			return response, err
		}
		applyExternalPayload(&response, external)
	}

	return response, nil
}

func formatJSIso(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func clampInsightsInt(value, min, max, fallback int) int {
	if value == 0 {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
