package dashboardstream

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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
