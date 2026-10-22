package dashboardstream

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
)

type allowAuth struct{}

func (allowAuth) Authenticate(http.ResponseWriter, *http.Request) *authhttp.Identity {
	return authhttp.NewIdentity("user-1", "org-1", []string{"dashboards.read"})
}

type denyAuth struct{}

func (denyAuth) Authenticate(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	authhttp.WriteUnauthorized(w, r, "")
	return nil
}

type scriptedWar struct {
	mu     sync.Mutex
	calls  int
	events []string
}

func (s *scriptedWar) ReadForStream(ctx context.Context, orgID string, start, end time.Time, view dashboardwarmap.StreamView) ([]byte, []byte, []byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	events := `{"events":[{"id":"a"}]}`
	if s.calls >= 3 {
		events = `{"events":[{"id":"b"}]}`
	}
	s.events = append(s.events, events)
	_ = view
	return []byte(events), []byte(`{"markers":[]}`), []byte(`{"layers":{}}`), nil
}

func (s *scriptedWar) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

type staticCandle struct {
	calls atomic.Int32
}

func (s *staticCandle) ReadCandlestick(context.Context, time.Time, time.Time) ([]byte, error) {
	s.calls.Add(1)
	return []byte(`{"symbol":"sp500_index","interval":"daily","points":[]}`), nil
}

type scriptedHeat struct {
	mu    sync.Mutex
	calls int
}

func (s *scriptedHeat) ReadHeatmap(ctx context.Context, orgID string, start, end time.Time) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.calls == 1 {
		return nil, io.EOF
	}
	return []byte(`{"points":[{"id":"kyiv"}]}`), nil
}

func (s *scriptedHeat) Calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func TestStreamPublishesFirstRoundThenOnlyChanges(t *testing.T) {
	war := &scriptedWar{}
	candles := &staticCandle{}
	heat := &scriptedHeat{}
	handler := NewHandler(allowAuth{}, war, candles, heat, cors.Policy{})
	handler.SetTimings(20*time.Millisecond, time.Hour)
	handler.SetClock(func() time.Time { return time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC) })

	server := httptest.NewServer(handler)
	defer server.Close()

	req, err := http.NewRequest(http.MethodGet, server.URL+Path+"?start=2026-03-01T00:00:00.000Z&end=2026-03-02T00:00:00.000Z&warMapStart=2026-03-01T03:00:00.000Z&warMapEnd=2026-03-01T18:00:00.000Z&warMapFlightMode=all&warMapAisMode=density", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content-type = %s", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("cache-control = %s", got)
	}

	frames := readFrames(t, resp.Body, 7, 2*time.Second)
	if len(frames) < 6 {
		t.Fatalf("frames = %#v", frames)
	}
	wantFirst := []string{eventWarMapEvents, eventWarMapNews, eventWarMapLayers, eventCandlestick, eventGeoUnavailable}
	for i, name := range wantFirst {
		if frames[i].event != name {
			t.Fatalf("frame %d = %s, want %s; all=%#v", i, frames[i].event, name, frames)
		}
	}
	if !strings.Contains(frames[0].data, `"id":"a"`) {
		t.Fatalf("first events = %s", frames[0].data)
	}
	if frames[4].data != `{"code":"GEO_HEATMAP_UNAVAILABLE"}` {
		t.Fatalf("unavailable = %s", frames[4].data)
	}

	var secondEvents int
	var sawChange bool
	var sawGeo bool
	for _, frame := range frames[5:] {
		if frame.event == eventWarMapEvents {
			secondEvents++
			if strings.Contains(frame.data, `"id":"b"`) {
				sawChange = true
			}
		}
		if frame.event == eventWarMapNews || frame.event == eventWarMapLayers || frame.event == eventCandlestick || frame.event == eventGeoUnavailable {
			t.Fatalf("unchanged event repeated: %#v", frame)
		}
		if frame.event == eventGeoHeatmap {
			sawGeo = true
		}
	}
	if !sawChange || secondEvents != 1 {
		t.Fatalf("changed events = %d frames=%#v", secondEvents, frames)
	}
	if !sawGeo {
		t.Fatalf("recovered heatmap missing: %#v", frames)
	}
	if war.Calls() < 3 {
		t.Fatalf("war calls = %d", war.Calls())
	}
}

func TestStreamStopsQueriesAfterDisconnect(t *testing.T) {
	war := &scriptedWar{}
	handler := NewHandler(allowAuth{}, war, &staticCandle{}, &scriptedHeat{}, cors.Policy{})
	handler.SetTimings(30*time.Millisecond, time.Hour)
	server := httptest.NewServer(handler)
	defer server.Close()

	req, err := http.NewRequest(http.MethodGet, server.URL+Path, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	_, _ = resp.Body.Read(buf)
	resp.Body.Close()
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if active, _ := handler.Stats(); active == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	active, cycles := handler.Stats()
	if active != 0 {
		t.Fatalf("active = %d", active)
	}
	time.Sleep(80 * time.Millisecond)
	if _, next := handler.Stats(); next != cycles {
		t.Fatalf("cycles continued from %d to %d", cycles, next)
	}
	if war.Calls() == 0 {
		t.Fatal("expected at least one query before disconnect")
	}
}

func TestStreamRejectsBadQueryWithoutReading(t *testing.T) {
	war := &scriptedWar{}
	handler := NewHandler(allowAuth{}, war, &staticCandle{}, &scriptedHeat{}, cors.Policy{})
	req := httptest.NewRequest(http.MethodGet, Path+"?start=yesterday", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if war.Calls() != 0 {
		t.Fatalf("calls = %d", war.Calls())
	}
}

func TestStreamUnauthorizedDoesNotRead(t *testing.T) {
	war := &scriptedWar{}
	handler := NewHandler(denyAuth{}, war, &staticCandle{}, &scriptedHeat{}, cors.Policy{})
	req := httptest.NewRequest(http.MethodGet, Path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || war.Calls() != 0 {
		t.Fatalf("status=%d calls=%d", rec.Code, war.Calls())
	}
}

func TestStreamErrorCarriesCandlestickCode(t *testing.T) {
	body := streamErrorPayload(&dashboardcharts.CodedFailure{
		FailureCode:   "DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH",
		FailureDetail: "No OHLC sourceField matched for this item in the requested range. Configure EconomicDataItem.metadata.dataViz.candlestick.ohlc.",
	})
	text := string(body)
	if !strings.Contains(text, `"code":"DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH"`) || !strings.Contains(text, `"message":"Dashboard stream update failed"`) {
		t.Fatalf("payload = %s", text)
	}
}

func TestTimingsClampDefaults(t *testing.T) {
	interval, ping := resolveTimings(func(string) string { return "" })
	if interval != 10*time.Second || ping != 25*time.Second {
		t.Fatalf("interval=%s ping=%s", interval, ping)
	}
	interval, ping = resolveTimings(func(key string) string {
		switch key {
		case "NODE_ENV":
			return "development"
		case "DASHBOARD_STREAM_INTERVAL_MS":
			return "10"
		case "DASHBOARD_STREAM_PING_MS":
			return "999999"
		default:
			return ""
		}
	})
	if interval != time.Second || ping != 120*time.Second {
		t.Fatalf("clamped interval=%s ping=%s", interval, ping)
	}
}

type frame struct {
	event string
	data  string
}

func readFrames(t *testing.T, body io.Reader, want int, timeout time.Duration) []frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out := make(chan frame, want)
	go func() {
		scanner := bufio.NewReader(body)
		var event string
		var data []string
		for {
			line, err := scanner.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if len(data) > 0 {
					out <- frame{event: event, data: strings.Join(data, "\n")}
				}
				event = ""
				data = nil
				continue
			}
			if strings.HasPrefix(line, "event:") {
				event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
				continue
			}
			if strings.HasPrefix(line, "data:") {
				data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
	}()
	frames := make([]frame, 0, want)
	for len(frames) < want {
		select {
		case <-ctx.Done():
			return frames
		case frame := <-out:
			frames = append(frames, frame)
		}
	}
	return frames
}

// sharedStreamQuery pins every parameter the shared read keys use, so tests can
// observe one computation per parameter set instead of one per connection.
const sharedStreamQuery = "?start=2026-03-01T00:00:00.000Z&end=2026-03-02T00:00:00.000Z" +
	"&warMapStart=2026-03-01T00:00:00.000Z&warMapEnd=2026-03-02T00:00:00.000Z" +
	"&warMapFlightMode=military&warMapAisMode=military"

// countingSources is a deterministic source set: the same bodies on every poll,
// so a shared read and an independent read must produce identical frames.
type countingSources struct {
	warCalls    atomic.Int32
	candleCalls atomic.Int32
	heatCalls   atomic.Int32
}

func (c *countingSources) ReadForStream(context.Context, string, time.Time, time.Time, dashboardwarmap.StreamView) ([]byte, []byte, []byte, error) {
	c.warCalls.Add(1)
	return []byte(`{"events":[{"id":"a"}]}`), []byte(`{"markers":[]}`), []byte(`{"layers":{}}`), nil
}

func (c *countingSources) ReadCandlestick(context.Context, time.Time, time.Time) ([]byte, error) {
	c.candleCalls.Add(1)
	return []byte(`{"symbol":"sp500_index","interval":"daily","points":[]}`), nil
}

func (c *countingSources) ReadHeatmap(context.Context, string, time.Time, time.Time) ([]byte, error) {
	c.heatCalls.Add(1)
	return []byte(`{"points":[{"id":"kyiv"}]}`), nil
}

func (c *countingSources) calls() (int32, int32, int32) {
	return c.warCalls.Load(), c.candleCalls.Load(), c.heatCalls.Load()
}

// Two connections for the same org/range/view must poll the same data once per
// tick, and each connection must still receive the same first-frame sequence it
// would receive with its own worker.
func TestStreamSharesReadsAcrossConnections(t *testing.T) {
	sources := &countingSources{}
	handler := NewHandler(allowAuth{}, sources, sources, sources, cors.Policy{})
	handler.SetTimings(20*time.Millisecond, time.Hour)
	frozen := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	handler.bucketNow = func() time.Time { return frozen }

	server := httptest.NewServer(handler)
	defer server.Close()

	// Pinned ranges and view keep both connections on one parameter set; the
	// war map range is otherwise derived from "now" and would differ per request.
	open := func() *http.Response {
		req, err := http.NewRequest(http.MethodGet, server.URL+Path+sharedStreamQuery, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	first := open()
	defer first.Body.Close()
	second := open()
	defer second.Body.Close()

	firstFrames := readFrames(t, first.Body, 5, 2*time.Second)
	secondFrames := readFrames(t, second.Body, 5, 2*time.Second)
	want := []string{eventWarMapEvents, eventWarMapNews, eventWarMapLayers, eventCandlestick, eventGeoHeatmap}
	for index, name := range want {
		if index >= len(firstFrames) || index >= len(secondFrames) {
			t.Fatalf("missing frames: first=%#v second=%#v", firstFrames, secondFrames)
		}
		if firstFrames[index].event != name || secondFrames[index].event != name {
			t.Fatalf("frame %d first=%s second=%s, want %s", index, firstFrames[index].event, secondFrames[index].event, name)
		}
		if firstFrames[index].data != secondFrames[index].data {
			t.Fatalf("frame %d payload differs: %s vs %s", index, firstFrames[index].data, secondFrames[index].data)
		}
	}

	// Both connections polled several ticks inside the same bucket window.
	time.Sleep(60 * time.Millisecond)
	war, candles, heat := sources.calls()
	if war != 1 || candles != 1 || heat != 1 {
		t.Fatalf("shared reads per bucket: war=%d candle=%d heat=%d, want 1/1/1", war, candles, heat)
	}
	if size := handler.warReads.size(); size != 1 {
		t.Fatalf("war entries = %d, want one per parameter set", size)
	}
}

// The connection that started a shared read may disconnect first. The waiting
// connection must still receive the payload instead of a stream-error.
func TestStreamSharedReadSurvivesInitiatorDisconnect(t *testing.T) {
	blocking := &blockingWar{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
	handler := NewHandler(allowAuth{}, blocking, &countingSources{}, &countingSources{}, cors.Policy{})
	handler.SetTimings(20*time.Millisecond, time.Hour)
	frozen := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	handler.bucketNow = func() time.Time { return frozen }

	server := httptest.NewServer(handler)
	defer server.Close()

	req, err := http.NewRequest(http.MethodGet, server.URL+Path+sharedStreamQuery, nil)
	if err != nil {
		t.Fatal(err)
	}
	initiator, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	// The initiator registered the shared entry and is waiting inside the read;
	// it now leaves before the read can finish.
	<-blocking.started
	initiator.Body.Close()

	waiter, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer waiter.Body.Close()
	close(blocking.release)

	frames := readFrames(t, waiter.Body, 5, 2*time.Second)
	if len(frames) < 1 || frames[0].event != eventWarMapEvents {
		t.Fatalf("waiter frames = %#v", frames)
	}
	for _, frame := range frames {
		if frame.event == eventStreamError {
			t.Fatalf("waiter reported the initiator's disconnect as an error: %#v", frames)
		}
	}
	if blocking.canceled.Load() {
		t.Fatal("shared read was cancelled by the initiator's disconnect")
	}
}

type blockingWar struct {
	started  chan struct{}
	release  chan struct{}
	canceled atomic.Bool
}

func (b *blockingWar) ReadForStream(ctx context.Context, _ string, _, _ time.Time, _ dashboardwarmap.StreamView) ([]byte, []byte, []byte, error) {
	select {
	case b.started <- struct{}{}:
	default:
	}
	select {
	case <-b.release:
		return []byte(`{"events":[]}`), []byte(`{"markers":[]}`), []byte(`{"layers":{}}`), nil
	case <-ctx.Done():
		b.canceled.Store(true)
		return nil, nil, nil, ctx.Err()
	}
}

// Closed connections must leave no per-connection cache entry behind, and the
// publish goroutines must exit.
func TestStreamReleasesPerConnectionState(t *testing.T) {
	sources := &countingSources{}
	handler := NewHandler(allowAuth{}, sources, sources, sources, cors.Policy{})
	handler.SetTimings(20*time.Millisecond, time.Hour)
	frozen := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	handler.bucketNow = func() time.Time { return frozen }

	server := httptest.NewServer(handler)
	defer server.Close()

	connectOnce := func() {
		req, err := http.NewRequest(http.MethodGet, server.URL+Path+sharedStreamQuery, nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 16)
		_, _ = resp.Body.Read(buf)
		resp.Body.Close()
	}

	connectOnce()
	baseline := runtime.NumGoroutine()
	for index := 0; index < 10; index++ {
		connectOnce()
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		active, _ := handler.Stats()
		if active == 0 && runtime.NumGoroutine() <= baseline+8 {
			if handler.warReads.size() > 1 || handler.candleReads.size() > 1 || handler.heatReads.size() > 1 {
				t.Fatalf("shared cache kept per-connection entries: war=%d candle=%d heat=%d",
					handler.warReads.size(), handler.candleReads.size(), handler.heatReads.size())
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	active, _ := handler.Stats()
	t.Fatalf("connections did not settle: active=%d goroutines=%d baseline=%d", active, runtime.NumGoroutine(), baseline)
}

// failingStreamWriter behaves like a browser that stopped reading: the SSE
// headers and the initial flush succeed, then every frame write fails (what a
// blocked write looks like once the per-frame deadline expires).
type failingStreamWriter struct {
	header http.Header
	mu     sync.Mutex
	writes int
}

func (w *failingStreamWriter) Header() http.Header {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.header == nil {
		w.header = http.Header{}
	}
	return w.header
}

func (w *failingStreamWriter) WriteHeader(int) {}

func (w *failingStreamWriter) Write([]byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writes++
	return 0, io.ErrClosedPipe
}

func (w *failingStreamWriter) Flush() {}

func (w *failingStreamWriter) Writes() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.writes
}

// A failed frame write must end the stream instead of leaving the ping loop and
// the publish ticker parked on a dead client.
func TestStreamStopsAfterClientWriteFails(t *testing.T) {
	war := &scriptedWar{}
	handler := NewHandler(allowAuth{}, war, &staticCandle{}, &scriptedHeat{}, cors.Policy{})
	handler.SetTimings(10*time.Millisecond, 10*time.Millisecond)
	writer := &failingStreamWriter{}
	req := httptest.NewRequest(http.MethodGet, Path, nil)

	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(writer, req)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not stop after the client write failed")
	}
	if active, _ := handler.Stats(); active != 0 {
		t.Fatalf("active = %d after the stream ended, want 0", active)
	}
	if writer.Writes() == 0 {
		t.Fatal("expected at least one failed frame write")
	}
	// The shared read must not be retried once the stream is gone.
	calls := war.Calls()
	time.Sleep(60 * time.Millisecond)
	if now := war.Calls(); now != calls {
		t.Fatalf("queries continued after the stream ended: %d -> %d", calls, now)
	}
}
