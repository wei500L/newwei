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

	eventWarMapEvents      = "war-map-events"
	eventWarMapNews        = "war-map-news-markers"
	eventWarMapLayers      = "war-map-layers"
	eventCandlestick       = "financial-candlestick"
	eventGeoHeatmap        = "spacetime-geo-heatmap"
	eventGeoUnavailable    = "spacetime-geo-heatmap-unavailable"
	eventStreamError       = "stream-error"
	eventPing              = "ping"
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

// warRead is one war map poll: the three bodies the SSE frame sequence needs.
type warRead struct {
	events  []byte
	markers []byte
	layers  []byte
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

	// Shared per-tick reads. See shared.go for the sharing and freshness rules.
	warReads    *sharedReads[warRead]
	candleReads *sharedReads[[]byte]
	heatReads   *sharedReads[[]byte]
	bucketNow   func() time.Time

	active atomic.Int64
	cycles atomic.Int64
}

// sharedReadTimeout bounds a detached shared read. A read normally finishes in
// milliseconds; the bound only exists so a connection that disconnects mid-read
// cannot hold the query (and the entry's waiters) open indefinitely.
const sharedReadTimeout = 30 * time.Second

// streamWriteTimeout bounds one SSE frame write. A client that stops reading
// must not pin the handler goroutine (and the shared-read waiters of this
// connection) forever: the deadline turns the blocked write into an error, and
// the stream then ends instead of retrying every tick.
const streamWriteTimeout = 15 * time.Second

// errStreamClosed is returned by streamSink.write once the stream has failed.
var errStreamClosed = errors.New("dashboardstream: stream is closed")

// NewHandler 使用生产定时器。测试可以改 Interval 和 Ping。
func NewHandler(auth requestAuth, war WarSource, candles CandleSource, heat HeatSource, policy cors.Policy) *Handler {
	return &Handler{
		auth:        auth,
		war:         war,
		candles:     candles,
		heat:        heat,
		policy:      policy,
		now:         time.Now,
		getenv:      os.Getenv,
		warReads:    newSharedReads[warRead](sharedReadTimeout),
		candleReads: newSharedReads[[]byte](sharedReadTimeout),
		heatReads:   newSharedReads[[]byte](sharedReadTimeout),
		bucketNow:   time.Now,
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

	// The stream owns a cancelable view of the request context so one failed
	// frame write ends the whole handler: the publish ticker, the ping ticker and
	// any read still waiting on this connection must not outlive a client that
	// stopped reading.
	ctx, stopStream := context.WithCancel(r.Context())
	defer stopStream()
	sink := &streamSink{
		writer:  w,
		flusher: flusher,
		control: http.NewResponseController(w),
		stop:    stopStream,
	}
	// Clearing the deadline on return lets net/http write the terminating chunk
	// of the chunked response; a deadline left in the past would truncate it.
	defer sink.clearDeadline()

	interval, pingEvery := h.timings()
	h.active.Add(1)
	defer h.active.Add(-1)

	var inflight atomic.Bool
	state := &fingerprints{}
	publish := func(force bool) {
		if ctx.Err() != nil || !inflight.CompareAndSwap(false, true) {
			return
		}
		defer inflight.Store(false)
		h.cycles.Add(1)
		h.publish(ctx, sink, identity.OrgID, dashStart, dashEnd, warStart, warEnd, view, state, force, h.tickBucket(interval))
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
			// A ping that cannot be written means the client is gone; write
			// returns the error and stops the stream.
			_ = sink.write(eventPing, pingPayload(time.Now().UTC()))
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

func (h *Handler) publish(ctx context.Context, sink *streamSink, orgID string, dashStart, dashEnd, warStart, warEnd time.Time, view dashboardwarmap.StreamView, state *fingerprints, force bool, bucket int64) {
	type warResult struct {
		read warRead
		err  error
	}
	type byteResult struct {
		body []byte
		err  error
	}
	warCh := make(chan warResult, 1)
	candleCh := make(chan byteResult, 1)
	heatCh := make(chan byteResult, 1)
	go func() {
		read, err := h.warReads.do(ctx, warReadKey(orgID, warStart, warEnd, view), bucket, func(readCtx context.Context) (warRead, error) {
			events, markers, layers, err := h.war.ReadForStream(readCtx, orgID, warStart, warEnd, view)
			return warRead{events: events, markers: markers, layers: layers}, err
		})
		warCh <- warResult{read: read, err: err}
	}()
	go func() {
		body, err := h.candleReads.do(ctx, candleReadKey(dashStart, dashEnd), bucket, func(readCtx context.Context) ([]byte, error) {
			return h.candles.ReadCandlestick(readCtx, dashStart, dashEnd)
		})
		candleCh <- byteResult{body: body, err: err}
	}()
	go func() {
		body, err := h.heatReads.do(ctx, heatReadKey(orgID, dashStart, dashEnd), bucket, func(readCtx context.Context) ([]byte, error) {
			return h.heat.ReadHeatmap(readCtx, orgID, dashStart, dashEnd)
		})
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
		if ctx.Err() != nil {
			return
		}
		_ = sink.write(eventStreamError, streamErrorPayload(err))
		return
	}
	if ctx.Err() != nil {
		return
	}
	sendChanged := func(event string, payload []byte, previous *string) {
		if ctx.Err() {
			return
		}
		next := fingerprint(payload)
		if force || next != *previous {
			if sink.write(event, payload) == nil {
				*previous = next
			}
		}
	}
	sendChanged(eventWarMapEvents, warPart.read.events, &state.war)
	sendChanged(eventWarMapNews, warPart.read.markers, &state.news)
	sendChanged(eventWarMapLayers, warPart.read.layers, &state.layers)
	sendChanged(eventCandlestick, candlePart.body, &state.candle)
	if heatPart.err != nil || len(heatPart.body) == 0 {
		if state.geo != unavailableFingerprint {
			if sink.write(eventGeoUnavailable, []byte(`{"code":"GEO_HEATMAP_UNAVAILABLE"}`)) == nil {
				state.geo = unavailableFingerprint
			}
		}
		return
	}
	sendChanged(eventGeoHeatmap, heatPart.body, &state.geo)
}

// streamSink serializes the SSE writes of one connection, bounds every write
// with a deadline, and stops the stream on the first failure.
//
// Without it a client that stops reading (suspended laptop, broken NAT) leaves
// w.Write blocked forever inside the publish goroutine: the ticker keeps
// running, writeMu is never released, the ping frame can never be written, and
// the shared-read waiters of this connection stay parked. NestJS has the same
// unbounded-write shape, so this is a Go-side hardening rather than a
// behavioural difference the browser can observe: a healthy client never hits
// the deadline.
type streamSink struct {
	mu      sync.Mutex
	writer  http.ResponseWriter
	flusher http.Flusher
	control *http.ResponseController
	stop    context.CancelFunc
	failed  bool
}

// clearDeadline restores "no write deadline" for the final chunk of the
// response. It is only called after every writer goroutine finished.
func (s *streamSink) clearDeadline() {
	if s.control == nil {
		return
	}
	_ = s.control.SetWriteDeadline(time.Time{})
}

// write sends one SSE frame unless the stream already failed. A failed or
// timed-out write ends the stream: the error is returned to the caller (which
// stops publishing) and stop cancels the connection context so the tickers and
// the ping loop finish too.
func (s *streamSink) write(event string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failed {
		return errStreamClosed
	}
	// Best effort: ResponseController reports ErrNotSupported for writers without
	// deadline support (httptest.ResponseRecorder), and the frame is still
	// written; only the bound is missing.
	if s.control != nil {
		_ = s.control.SetWriteDeadline(time.Now().Add(streamWriteTimeout))
	}
	if err := writeFrame(s.writer, s.flusher, event, data); err != nil {
		s.failed = true
		if s.stop != nil {
			s.stop()
		}
		return err
	}
	return nil
}

// tickBucket is the sharing window for one publish round: connections whose
// ticks fall into the same wall-clock bucket read the data once. The bucket is
// derived from the same interval the ticker uses, so a connection always moves
// to a new bucket on its next tick and never reuses its own previous result.
func (h *Handler) tickBucket(interval time.Duration) int64 {
	if interval <= 0 {
		interval = time.Second
	}
	now := h.bucketNow
	if now == nil {
		now = time.Now
	}
	return now().UnixNano() / int64(interval)
}

// warReadKey scopes a shared war map read to everything the response depends on.
// The org id is part of the key, so tenants never share a body.
func warReadKey(orgID string, start, end time.Time, view dashboardwarmap.StreamView) string {
	var key strings.Builder
	key.WriteString("war|")
	key.WriteString(orgID)
	key.WriteByte('|')
	key.WriteString(strconv.FormatInt(start.UnixMilli(), 10))
	key.WriteByte('|')
	key.WriteString(strconv.FormatInt(end.UnixMilli(), 10))
	key.WriteByte('|')
	if view.Translate {
		key.WriteByte('1')
	} else {
		key.WriteByte('0')
	}
	key.WriteByte('|')
	key.WriteString(view.FlightMode)
	key.WriteByte('|')
	key.WriteString(view.AisMode)
	key.WriteByte('|')
	if view.BBox != nil {
		for index, edge := range view.BBox {
			if index > 0 {
				key.WriteByte(',')
			}
			key.WriteString(strconv.FormatFloat(edge, 'g', -1, 64))
		}
	}
	key.WriteByte('|')
	if view.Zoom != nil {
		key.WriteString(strconv.FormatFloat(*view.Zoom, 'g', -1, 64))
	}
	return key.String()
}

// candleReadKey has no org: the candlestick series is global, so every org with
// the same range shares one read.
func candleReadKey(start, end time.Time) string {
	return "candle|" + strconv.FormatInt(start.UnixMilli(), 10) + "|" + strconv.FormatInt(end.UnixMilli(), 10)
}

func heatReadKey(orgID string, start, end time.Time) string {
	return "heat|" + orgID + "|" + strconv.FormatInt(start.UnixMilli(), 10) + "|" + strconv.FormatInt(end.UnixMilli(), 10)
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

// writeFrame writes one SSE message. Nest's SerializedSse emits the same three
// lines ("event: <type>", "data: <json>", blank), so the wire format matches;
// the frame is assembled in one buffer so a message costs one Write and one
// Flush instead of three writes per event.
func writeFrame(w http.ResponseWriter, flusher http.Flusher, event string, data []byte) error {
	frame := make([]byte, 0, len("event: ")+len(event)+len("\ndata: ")+len(data)+len("\n\n"))
	frame = append(frame, "event: "...)
	frame = append(frame, event...)
	frame = append(frame, "\ndata: "...)
	frame = append(frame, data...)
	frame = append(frame, "\n\n"...)
	if _, err := w.Write(frame); err != nil {
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
