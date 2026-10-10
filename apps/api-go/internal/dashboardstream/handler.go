// Package dashboardstream 实现 GET /api/dashboard/stream 的 SSE。
//
// 只在 API_GO_DASHBOARD_STREAM_MODE=go 时由 main 注册。默认 legacy，
// 这条路径继续代理 NestJS。回滚就是把模式改回 legacy。
//
// 连接建立时验签、查 Redis 撤销名单，并从 MySQL 重推导 dashboards.read
// 与 orgId。之后不再做周期性鉴权。数据来自已有的战争地图、K 线和
// Spacetime 热力图服务，不请求 NestJS，也不请求 Go 自己的 HTTP 接口。
package dashboardstream

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
)

const (
	// Path 是精确路径。
	Path = "/api/dashboard/stream"

	eventWarMapEvents     = "war-map-events"
	eventWarMapNews       = "war-map-news-markers"
	eventWarMapLayers     = "war-map-layers"
	eventCandlestick      = "financial-candlestick"
	eventGeoHeatmap       = "spacetime-geo-heatmap"
	eventGeoUnavailable   = "spacetime-geo-heatmap-unavailable"
	eventStreamError      = "stream-error"
	eventPing             = "ping"
	unavailableFingerprint = "unavailable"
)

// WarSource 是战争地图的一次共享读取。
type WarSource interface {
	ReadForStream(ctx context.Context, orgID string, start, end time.Time, view dashboardwarmap.StreamView) (events, markers, layers []byte, err error)
}

// CandleSource 是 K 线读取。
type CandleSource interface {
	ReadCandlestick(ctx context.Context, start, end time.Time) ([]byte, error)
}

// HeatSource 是 Spacetime 热力图读取。失败时由流发送 unavailable，不算整轮失败。
type HeatSource interface {
	ReadHeatmap(ctx context.Context, orgID string, start, end time.Time) ([]byte, error)
}

type requestAuth interface {
	Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity
}

// Handler 持有一条 SSE 连接的依赖。
type Handler struct {
	auth     requestAuth
	war      WarSource
	candles  CandleSource
	heat     HeatSource
	policy   cors.Policy
	now      func() time.Time
	interval time.Duration
	ping     time.Duration
	getenv   func(string) string

	active atomic.Int64
	cycles atomic.Int64
}

// NewHandler 使用生产定时器。测试可以改 Interval 和 Ping。
func NewHandler(auth requestAuth, war WarSource, candles CandleSource, heat HeatSource, policy cors.Policy) *Handler {
	return &Handler{
		auth:    auth,
		war:     war,
		candles: candles,
		heat:    heat,
		policy:  policy,
		now:     time.Now,
		getenv:  os.Getenv,
	}
}

// SetClock 让测试固定“现在”。
func (h *Handler) SetClock(now func() time.Time) {
	if now != nil {
		h.now = now
	}
}

// SetTimings 让测试使用更短的周期。生产路径留空，按环境变量和上下限解析。
func (h *Handler) SetTimings(interval, ping time.Duration) {
	h.interval = interval
	h.ping = ping
}

// Stats 返回当前连接数和已经开始的更新轮次。
func (h *Handler) Stats() (active, cycles int64) {
	if h == nil {
		return 0, 0
	}
	return h.active.Load(), h.cycles.Load()
}

func (h *Handler) clock() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now()
}

func (h *Handler) timings() (time.Duration, time.Duration) {
	if h.interval > 0 && h.ping > 0 {
		return h.interval, h.ping
	}
	getenv := h.getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	return resolveTimings(getenv)
}

// ServeHTTP 只接受 GET。合格的 CORS 预检在这里结束；缺少预检头的 OPTIONS 不处理。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.policy.FinishOptions(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	identity := h.auth.Authenticate(w, r)
	if identity == nil {
		return
	}
	if !identity.HasPermission("dashboards.read") {
		authhttp.WriteForbidden(w, r, []string{"dashboards.read"})
		return
	}
	query := parseStreamQuery(r.URL.RawQuery)
	if message := query.validation(); message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	now := h.clock()
	dashStart, dashEnd, message := dashboardcharts.ResolveAlignedRange(query.start.value, query.end.value, query.start.set, query.end.set, now)
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	warStartValue, warStartSet := query.start.value, query.start.set
	if query.warMapStart.set {
		warStartValue, warStartSet = query.warMapStart.value, true
	}
	warEndValue, warEndSet := query.end.value, query.end.set
	if query.warMapEnd.set {
		warEndValue, warEndSet = query.warMapEnd.value, true
	}
	warStart, warEnd, message := dashboardwarmap.ResolveOpenRange(warStartValue, warEndValue, warStartSet, warEndSet, now)
	if message != "" {
		authhttp.WriteBadRequest(w, r, message)
		return
	}
	view := dashboardwarmap.StreamView{
		Translate:  parseTranslate(query.warMapTranslate.value),
		FlightMode: parseFlightMode(query.warMapFlightMode.value),
		AisMode:    parseAisMode(query.warMapAisMode.value),
	}
	if query.warMapBbox.set {
		if box, ok := dashboardwarmap.ParseBBox(query.warMapBbox.value); ok {
			view.BBox = &box
		}
	}
	if query.warMapZoom.set {
		if zoom, ok := dashboardwarmap.ParseZoom(query.warMapZoom.value); ok {
			view.Zoom = &zoom
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	interval, pingEvery := h.timings()
	h.active.Add(1)
	defer h.active.Add(-1)

	var writeMu sync.Mutex
	var inflight atomic.Bool
	state := &fingerprints{}
	publish := func(force bool) {
		if ctx.Err() != nil || !inflight.CompareAndSwap(false, true) {
			return
		}
		defer inflight.Store(false)
		h.cycles.Add(1)
		h.publish(ctx, &writeMu, w, flusher, identity.OrgID, dashStart, dashEnd, warStart, warEnd, view, state, force)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		publish(true)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if ctx.Err() != nil {
					return
				}
				publish(false)
			}
		}
	}()

	pingTicker := time.NewTicker(pingEvery)
	defer pingTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case <-pingTicker.C:
			if ctx.Err() != nil {
				wg.Wait()
				return
			}
			writeMu.Lock()
			_ = writeFrame(w, flusher, eventPing, pingPayload(time.Now().UTC()))
			writeMu.Unlock()
		}
	}
}

type fingerprints struct {
	war    string
	news   string
	layers string
	candle string
	geo    string
}

func (h *Handler) publish(ctx context.Context, mu *sync.Mutex, w http.ResponseWriter, flusher http.Flusher, orgID string, dashStart, dashEnd, warStart, warEnd time.Time, view dashboardwarmap.StreamView, state *fingerprints, force bool) {
	type warResult struct {
		events, markers, layers []byte
		err                     error
	}
	type byteResult struct {
		body []byte
		err  error
	}
	warCh := make(chan warResult, 1)
	candleCh := make(chan byteResult, 1)
	heatCh := make(chan byteResult, 1)
	go func() {
		events, markers, layers, err := h.war.ReadForStream(ctx, orgID, warStart, warEnd, view)
		warCh <- warResult{events: events, markers: markers, layers: layers, err: err}
	}()
	go func() {
		body, err := h.candles.ReadCandlestick(ctx, dashStart, dashEnd)
		candleCh <- byteResult{body: body, err: err}
	}()
	go func() {
		body, err := h.heat.ReadHeatmap(ctx, orgID, dashStart, dashEnd)
		heatCh <- byteResult{body: body, err: err}
	}()

	warPart := <-warCh
	candlePart := <-candleCh
	heatPart := <-heatCh
	if ctx.Err() != nil {
		return
	}
	if err := firstError(warPart.err, candlePart.err); err != nil {
		log.Printf("dashboard stream: update failed")
		mu.Lock()
		defer mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		_ = writeFrame(w, flusher, eventStreamError, streamErrorPayload(err))
		return
	}

	mu.Lock()
	defer mu.Unlock()
	if ctx.Err() != nil {
		return
	}
	sendChanged := func(event string, payload []byte, previous *string) {
		if ctx.Err() != nil {
			return
		}
		next := fingerprint(payload)
		if force || next != *previous {
			if writeFrame(w, flusher, event, payload) == nil {
				*previous = next
			}
		}
	}
	sendChanged(eventWarMapEvents, warPart.events, &state.war)
	sendChanged(eventWarMapNews, warPart.markers, &state.news)
	sendChanged(eventWarMapLayers, warPart.layers, &state.layers)
	sendChanged(eventCandlestick, candlePart.body, &state.candle)
	if heatPart.err != nil || len(heatPart.body) == 0 {
		if state.geo != unavailableFingerprint {
			if writeFrame(w, flusher, eventGeoUnavailable, []byte(`{"code":"GEO_HEATMAP_UNAVAILABLE"}`)) == nil {
				state.geo = unavailableFingerprint
			}
		}
		return
	}
	sendChanged(eventGeoHeatmap, heatPart.body, &state.geo)
}

func firstError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func fingerprint(payload []byte) string {
	sum := sha1.Sum(payload)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func writeFrame(w http.ResponseWriter, flusher http.Flusher, event string, data []byte) error {
	if _, err := w.Write([]byte("event: " + event + "\ndata: ")); err != nil {
		return err
	}
	if _, err := w.Write(data); err != nil {
		return err
	}
	if _, err := w.Write([]byte("\n\n")); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func pingPayload(now time.Time) []byte {
	body, _ := json.Marshal(struct {
		TS string `json:"ts"`
	}{TS: now.UTC().Format("2006-01-02T15:04:05.000Z")})
	return body
}

func streamErrorPayload(err error) []byte {
	var coded *dashboardcharts.CodedFailure
	payload := struct {
		Code    string `json:"code,omitempty"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}{
		Message: "Dashboard stream update failed",
		Detail:  safeDetail(err),
	}
	if errors.As(err, &coded) && coded != nil {
		payload.Code = coded.FailureCode
		if strings.TrimSpace(coded.FailureDetail) != "" {
			payload.Detail = coded.FailureDetail
		}
	}
	body, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		return []byte(`{"message":"Dashboard stream update failed","detail":"Dashboard stream update failed"}`)
	}
	return body
}

func safeDetail(err error) string {
	if err == nil {
		return "Unknown error"
	}
	detail := err.Error()
	if detail == "" {
		return "Unknown error"
	}
	lower := strings.ToLower(detail)
	if strings.Contains(detail, "://") || strings.Contains(detail, "@") || strings.Contains(lower, "password") || strings.Contains(lower, "mongodb://") || strings.Contains(lower, "mysql://") {
		return "Dashboard stream update failed"
	}
	return detail
}

func resolveTimings(getenv func(string) string) (time.Duration, time.Duration) {
	fallback := 10_000
	if getenv("NODE_ENV") == "development" {
		fallback = 2_000
	}
	interval := clampInt(readEnvInt(getenv, "DASHBOARD_STREAM_INTERVAL_MS", fallback), 1_000, 60_000)
	ping := clampInt(readEnvInt(getenv, "DASHBOARD_STREAM_PING_MS", 25_000), 5_000, 120_000)
	return time.Duration(interval) * time.Millisecond, time.Duration(ping) * time.Millisecond
}

func readEnvInt(getenv func(string) string, key string, fallback int) int {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func parseTranslate(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized == "zh-cn" || normalized == "zh"
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
