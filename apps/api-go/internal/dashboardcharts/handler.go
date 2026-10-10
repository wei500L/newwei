// Package dashboardcharts 接管三个只读图表 GET。
//
// 只在 API_GO_DASHBOARD_CHARTS_MODE=go 时由 main 注册。默认 legacy，
// 这些路径继续代理 NestJS。回滚就是把模式改回 legacy。
//
// 三条路径都复用现有 JWT 验签、Redis 撤销检查和 MySQL membership/RBAC。
// 权限是 dashboards.read，不读 JWT permissions，也不读 query 里的 orgId。
// 经济序列本身不是按 org 分的，这与 NestJS 一致。
package dashboardcharts

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

const (
	// SectorHeatmapPath 是板块热力图的精确路径。
	SectorHeatmapPath = "/api/dashboard/sector-heatmap"
	// FinancialCandlestickPath 是 K 线的精确路径。
	FinancialCandlestickPath = "/api/dashboard/financial-candlestick"
	// WarMapGeoJSONPath 是世界底图的精确路径。
	WarMapGeoJSONPath = "/api/dashboard/war-map/geojson"
	requiredPermission = "dashboards.read"
)

// Paths 是本开关接管的精确 GET。
var Paths = []string{SectorHeatmapPath, FinancialCandlestickPath, WarMapGeoJSONPath}

type requestAuth interface {
	Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity
}

type opener interface {
	Open(http.ResponseWriter, *http.Request) bool
}

type membershipGate struct {
	auth requestAuth
}

func (g membershipGate) Open(w http.ResponseWriter, r *http.Request) bool {
	identity := g.auth.Authenticate(w, r)
	if identity == nil {
		return false
	}
	if !identity.HasPermission(requiredPermission) {
		authhttp.WriteForbidden(w, r, []string{requiredPermission})
		return false
	}
	return true
}

// Store 是图表读取面。测试替换它；生产是 MySQLStore。
type Store interface {
	SectorItems(ctx context.Context) ([]sectorItem, error)
	SectorFields(ctx context.Context, ids []string, start, end time.Time) (map[string][]string, error)
	SectorPoint(ctx context.Context, itemID, field string, start, end time.Time, desc bool) (*samplePoint, error)
	CandleItem(ctx context.Context) (*candleItem, error)
	CandlePoints(ctx context.Context, itemID string, fields []string, start, end time.Time) ([]rawPoint, error)
	CandleCount(ctx context.Context, itemID string, start, end time.Time) (int, error)
	CandleFields(ctx context.Context, itemID string, start, end time.Time) ([]string, error)
}

// Handler 写出三个图表的 JSON。
type Handler struct {
	gate  opener
	store Store
	now   func() time.Time
	world geoAsset
}

// NewHandler 使用生产鉴权和 MySQL，并在启动时编好 GeoJSON 响应。
func NewHandler(auth *authhttp.Authenticator, store Store) *Handler {
	return &Handler{
		gate:  membershipGate{auth: auth},
		store: store,
		now:   time.Now,
		world: newGeoAsset(worldGeoJSON),
	}
}

func (h *Handler) clock() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now()
}

// ServeHTTP 只接受 GET。日期校验先于任何数据读取，包括 GeoJSON。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if !h.gate.Open(w, r) {
		return
	}
	query := parseDashboardQuery(r)
	if message := validationMessage(query); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	start, end, message := resolveRange(query, h.clock())
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	switch r.URL.Path {
	case WarMapGeoJSONPath:
		h.serveGeo(w, r)
	case SectorHeatmapPath:
		h.serveHeatmap(w, r, start, end)
	case FinancialCandlestickPath:
		h.serveCandle(w, r, start, end)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) serveGeo(w http.ResponseWriter, r *http.Request) {
	if len(h.world.body) == 0 {
		writeGeoFailure(w, r, h.world.detail)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeBytes(w, http.StatusOK, h.world.body)
}

func (h *Handler) serveHeatmap(w http.ResponseWriter, r *http.Request, start, end time.Time) {
	items, err := h.store.SectorItems(r.Context())
	if err != nil {
		h.failDB(w, r)
		return
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	fields, err := h.store.SectorFields(r.Context(), ids, start, end)
	if err != nil {
		h.failDB(w, r)
		return
	}
	body, err := buildHeatmap(items, fields, func(itemID, field string) (samplePoint, samplePoint, bool, error) {
		first, err := h.store.SectorPoint(r.Context(), itemID, field, start, end, false)
		if err != nil || first == nil {
			return samplePoint{}, samplePoint{}, false, err
		}
		last, err := h.store.SectorPoint(r.Context(), itemID, field, start, end, true)
		if err != nil || last == nil {
			return samplePoint{}, samplePoint{}, false, err
		}
		return *first, *last, true, nil
	})
	if err != nil {
		h.failDB(w, r)
		return
	}
	encoded, err := encodeJSON(body)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeBytes(w, http.StatusOK, encoded)
}

func (h *Handler) serveCandle(w http.ResponseWriter, r *http.Request, start, end time.Time) {
	success, mismatch, err := h.loadCandle(r.Context(), start, end)
	if err != nil {
		h.failDB(w, r)
		return
	}
	if mismatch != nil {
		writeCandleMismatch(w, r, *mismatch)
		return
	}
	encoded, err := encodeJSON(success)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeBytes(w, http.StatusOK, encoded)
}

// CodedFailure 是可以放进 SSE stream-error 的业务失败。
type CodedFailure struct {
	FailureCode   string
	FailureDetail string
}

func (e *CodedFailure) Error() string {
	if e == nil {
		return ""
	}
	return e.FailureDetail
}

// ReadCandlestick 复用 K 线装配。字段映射不匹配时返回 CodedFailure，
// 不把 HTTP 500 体直接写进流。
func (h *Handler) ReadCandlestick(ctx context.Context, start, end time.Time) ([]byte, error) {
	success, mismatch, err := h.loadCandle(ctx, start, end)
	if err != nil {
		return nil, err
	}
	if mismatch != nil {
		return nil, &CodedFailure{FailureCode: candlestickCode, FailureDetail: candlestickDetail}
	}
	return encodeJSON(success)
}

func (h *Handler) loadCandle(ctx context.Context, start, end time.Time) (candleSuccess, *candleMismatch, error) {
	item, err := h.store.CandleItem(ctx)
	if err != nil {
		return candleSuccess{}, nil, err
	}
	var matched []rawPoint
	total := 0
	var available []string
	if item != nil {
		aliases := flatOHLC(expandOHLC(decodeMetadata(item.Metadata)))
		matched, err = h.store.CandlePoints(ctx, item.ID, aliases, start, end)
		if err != nil {
			return candleSuccess{}, nil, err
		}
		if len(matched) == 0 {
			total, err = h.store.CandleCount(ctx, item.ID, start, end)
			if err != nil {
				return candleSuccess{}, nil, err
			}
			if total > 0 {
				available, err = h.store.CandleFields(ctx, item.ID, start, end)
				if err != nil {
					return candleSuccess{}, nil, err
				}
			}
		}
	}
	success, mismatch := buildCandle(item, matched, total, available)
	return success, mismatch, nil
}

func (h *Handler) failDB(w http.ResponseWriter, r *http.Request) {
	log.Printf("dashboard charts: mysql query failed")
	authhttp.WriteDatabaseFailure(w, r)
}

func writeBytes(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeGeoFailure(w http.ResponseWriter, r *http.Request, detail string) {
	if detail == "" {
		detail = geoJSONErrorDetail
	}
	failure := geoFailure{
		StatusCode: http.StatusInternalServerError,
		Message:    "Internal server error",
		Error:      "Internal Server Error",
		Code:       geoJSONErrorCode,
		Detail:     detail,
	}
	writeContract(w, r, http.StatusInternalServerError, &failure)
}

type geoFailure struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code"`
	Detail     string `json:"detail,omitempty"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

func writeCandleMismatch(w http.ResponseWriter, r *http.Request, mismatch candleMismatch) {
	available := mismatch.Available
	if available == nil {
		available = []string{}
	}
	aliases := ohlcJSON{
		Open:  nonNil(mismatch.Aliases["open"]),
		High:  nonNil(mismatch.Aliases["high"]),
		Low:   nonNil(mismatch.Aliases["low"]),
		Close: nonNil(mismatch.Aliases["close"]),
	}
	failure := candleFailure{
		StatusCode: http.StatusInternalServerError,
		Message:    "Internal server error",
		Error:      "Internal Server Error",
		Code:       candlestickCode,
		Detail:     candlestickDetail,
		Item: mismatchItem{
			ID:          mismatch.Item.ID,
			Slug:        candlestickSlug,
			DisplayName: mismatch.Item.DisplayName,
		},
		ExpectedAliases:       aliases,
		AvailableSourceFields: available,
	}
	writeContract(w, r, http.StatusInternalServerError, &failure)
}

type mismatchItem struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	DisplayName string `json:"displayName"`
}

type ohlcJSON struct {
	Open  []string `json:"open"`
	High  []string `json:"high"`
	Low   []string `json:"low"`
	Close []string `json:"close"`
}

type candleFailure struct {
	StatusCode            int           `json:"statusCode"`
	Message               string        `json:"message"`
	Error                 string        `json:"error"`
	Code                  string        `json:"code"`
	Detail                string        `json:"detail"`
	Item                  mismatchItem  `json:"item"`
	ExpectedAliases       ohlcJSON      `json:"expectedAliases"`
	AvailableSourceFields []string      `json:"availableSourceFields"`
	TraceID               string        `json:"traceId"`
	Path                  string        `json:"path"`
	Timestamp             string        `json:"timestamp"`
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

type traced interface {
	setTrace(traceID, path, timestamp string)
}

func (e *geoFailure) setTrace(traceID, path, timestamp string) {
	e.TraceID = traceID
	e.Path = path
	e.Timestamp = timestamp
}

func (e *candleFailure) setTrace(traceID, path, timestamp string) {
	e.TraceID = traceID
	e.Path = path
	e.Timestamp = timestamp
}

func writeContract(w http.ResponseWriter, r *http.Request, status int, body traced) {
	body.setTrace(httpx.TraceIDFromContext(r.Context()), r.URL.Path, time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	encoded, err := encodeJSON(body)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	writeBytes(w, status, encoded)
}
