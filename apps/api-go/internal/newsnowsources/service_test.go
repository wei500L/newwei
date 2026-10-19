package newsnowsources

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---- fakes ----

type fakeRegistry map[string]SourceMeta

func (r fakeRegistry) Lookup(sourceID string) (SourceMeta, bool) {
	meta, ok := r[sourceID]
	return meta, ok
}

type publishedMessage struct {
	channel string
	payload string
}

type fakeStore struct {
	mu        sync.Mutex
	values    map[string]string
	ttls      map[string]time.Duration
	published []publishedMessage
	getCalls  int
	setCalls  int
}

func newFakeStore() *fakeStore {
	return &fakeStore{values: map[string]string{}, ttls: map[string]time.Duration{}}
}

func (s *fakeStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getCalls++
	value, ok := s.values[key]
	return value, ok, nil
}

func (s *fakeStore) Set(_ context.Context, key, value string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setCalls++
	s.values[key] = value
	s.ttls[key] = ttl
	return nil
}

func (s *fakeStore) SetNX(_ context.Context, key, value string, ttl time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.values[key]; exists {
		return false, nil
	}
	s.values[key] = value
	s.ttls[key] = ttl
	return true, nil
}

func (s *fakeStore) Eval(_ context.Context, script string, keys []string, args ...string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(keys) == 0 {
		return 0, nil
	}
	current, exists := s.values[keys[0]]
	if !exists {
		return 0, nil
	}
	if strings.Contains(script, "pexpire") {
		if len(args) > 0 && current == args[0] {
			return 1, nil
		}
		return 0, nil
	}
	if len(args) > 0 && current == args[0] {
		delete(s.values, keys[0])
		return 1, nil
	}
	return 0, nil
}

func (s *fakeStore) Publish(_ context.Context, channel string, payload []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.published = append(s.published, publishedMessage{channel: channel, payload: string(payload)})
	return nil
}

func (s *fakeStore) value(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok
}

func (s *fakeStore) put(key, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
}

func (s *fakeStore) messages() []publishedMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]publishedMessage, len(s.published))
	copy(out, s.published)
	return out
}

type fakeSecrets struct {
	mu     sync.Mutex
	calls  [][2]string
	values map[string]string
}

func (f *fakeSecrets) SecretsForSource(_ context.Context, sourceID, overrideSourceID string) map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, [2]string{sourceID, overrideSourceID})
	out := make(map[string]string, len(f.values))
	for key, value := range f.values {
		out[key] = value
	}
	return out
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func httpJSON(body string, status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func newTestService(registry SourceRegistry, secrets RuntimeSecrets, store Store) *Service {
	return NewService(ServiceConfig{
		Registry: registry,
		Secrets:  secrets,
		Store:    store,
		Now:      func() time.Time { return time.UnixMilli(1_700_000_000_000) },
		Env:      func(string) string { return "" },
	})
}

// ---- normalisation and JSON unions ----

func TestNormalizeItemsKeepsZeroIDAndOrder(t *testing.T) {
	items := []NewsItem{
		newItem(NumberID("0"), "zero", "https://example.com/0").build(),
		newItem(StringID("x"), "", "https://example.com/x").build(),
		newItem(StringID("y"), "ftp", "ftp://example.com/y").build(),
		newItem(StringID("z"), "ok", "https://example.com/z").build(),
	}
	out := normalizeItems(items)
	if len(out) != 2 {
		t.Fatalf("len=%d, want 2", len(out))
	}
	if out[0].ID.Text != "0" {
		t.Fatalf("numeric zero id must survive, got %q", out[0].ID.Text)
	}
	if out[1].URL != "https://example.com/z" {
		t.Fatalf("unexpected survivor %q", out[1].URL)
	}
}

func TestSourceResponseJSONPreservesFalseAndIconObject(t *testing.T) {
	response := SourceResponse{
		Status:      StatusSuccess,
		ID:          "jin10",
		UpdatedTime: Millis(1_700_000_000_000),
		Items: []NewsItem{
			{ID: NumberID("7"), Title: "t", URL: "https://example.com/a", Extra: &Extra{Info: InfoBool(false)}},
			{ID: StringID("8"), Title: "u", URL: "https://example.com/b", Extra: &Extra{Icon: IconScaled("https://img", json.RawMessage("1.5"))}},
			{ID: StringID("9"), Title: "v", URL: "https://example.com/c", Extra: &Extra{}},
		},
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.Contains(text, `"info":false`) {
		t.Fatalf("false info dropped: %s", text)
	}
	if !strings.Contains(text, `"icon":{"url":"https://img","scale":1.5}`) {
		t.Fatalf("icon object lost: %s", text)
	}
	if !strings.Contains(text, `"id":7`) {
		t.Fatalf("numeric id must stay numeric: %s", text)
	}
	if strings.Contains(text, "mobileUrl") || strings.Contains(text, "pubDate") {
		t.Fatalf("absent members must be omitted: %s", text)
	}

	var roundTrip SourceResponse
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.Items[0].Extra.Info == nil || roundTrip.Items[0].Extra.Info.Bool {
		t.Fatalf("false info did not round-trip")
	}
	if roundTrip.Items[1].Extra.Icon == nil || roundTrip.Items[1].Extra.Icon.Shape != IconObject {
		t.Fatalf("icon object did not round-trip")
	}
}

// ---- relative date ----

func TestParseRelativeDate(t *testing.T) {
	now := time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC)
	loc := shanghai()

	minutes := parseRelativeDate("3分钟前", loc, now)
	number, ok := minutes.Number()
	if !ok || int64(number) != now.Add(-3*time.Minute).UnixMilli() {
		t.Fatalf("3分钟前 = %v", minutes)
	}

	yesterday := parseRelativeDate("昨天 10:30", loc, now)
	number, ok = yesterday.Number()
	if !ok {
		t.Fatalf("昨天 did not parse: %v", yesterday)
	}
	want := time.Date(2026, 10, 18, 10, 30, 0, 0, loc)
	if int64(number) != want.UnixMilli() {
		t.Fatalf("昨天 10:30 = %v, want %v", time.UnixMilli(int64(number)), want)
	}

	unparsed := parseRelativeDate("2024-10-01 12:00", loc, now)
	if text, ok := unparsed.StringValue(); !ok || text != "2024-10-01 12:00" {
		t.Fatalf("unparsed date must stay a string, got %#v", unparsed)
	}
}

// ---- cache / lock / relay ----

func TestFetchSourceCacheHitAndForce(t *testing.T) {
	store := newFakeStore()
	cached := SourceResponse{Status: StatusSuccess, ID: "zhihu", UpdatedTime: Millis(1_600_000_000_000), Items: []NewsItem{
		newItem(StringID("1"), "cached", "https://example.com/1").build(),
	}}
	payload, _ := json.Marshal(cached)
	store.put("news-aggregator:source:zhihu", string(payload))

	service := newTestService(fakeRegistry{"zhihu": {ID: "zhihu", Interval: 300000}}, &fakeSecrets{}, store)
	var calls int32
	service.getters["zhihu"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		atomic.AddInt32(&calls, 1)
		return []NewsItem{newItem(StringID("2"), "fresh", "https://example.com/2").build()}, nil
	}

	response, err := service.FetchSource(context.Background(), "zhihu", false)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != StatusCache || atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("expected cache hit, status=%s calls=%d", response.Status, calls)
	}

	response, err = service.FetchSource(context.Background(), "zhihu", true)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != StatusSuccess || atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected forced refresh, status=%s calls=%d", response.Status, calls)
	}
	if ttl := store.ttls["news-aggregator:source:zhihu"]; ttl != 300*time.Second {
		t.Fatalf("fresh ttl=%s, want 300s", ttl)
	}
	if ttl := store.ttls["news-aggregator:source:zhihu:stale"]; ttl != 24*time.Hour {
		t.Fatalf("stale ttl=%s, want 24h", ttl)
	}

	messages := store.messages()
	if len(messages) != 1 || messages[0].channel != sourceRefreshChannel {
		t.Fatalf("expected one relay message, got %#v", messages)
	}
	var message sourceRefreshMessage
	if err := json.Unmarshal([]byte(messages[0].payload), &message); err != nil {
		t.Fatal(err)
	}
	if message.Version != 1 || message.SourceID != "zhihu" || message.NewItemsCount != 1 {
		t.Fatalf("unexpected relay payload: %#v", message)
	}
	if message.IntervalMs != 300000 || len(message.TopTitles) != 1 || message.TopTitles[0] != "fresh" {
		t.Fatalf("unexpected relay payload: %#v", message)
	}
}

func TestFreebufEmptyCacheRetries(t *testing.T) {
	store := newFakeStore()
	stale := SourceResponse{Status: StatusSuccess, ID: "freebuf", UpdatedTime: Millis(1_700_000_000_000 - 3*60*1000)}
	payload, _ := json.Marshal(stale)
	store.put("news-aggregator:source:freebuf", string(payload))

	service := newTestService(fakeRegistry{"freebuf": {ID: "freebuf", Interval: 600000}}, &fakeSecrets{}, store)
	var calls int32
	service.getters["freebuf"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		atomic.AddInt32(&calls, 1)
		return []NewsItem{newItem(StringID("1"), "new", "https://example.com/new").build()}, nil
	}

	response, err := service.FetchSource(context.Background(), "freebuf", false)
	if err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&calls) != 1 || response.Status != StatusSuccess {
		t.Fatalf("empty old cache must force a refresh, calls=%d status=%s", calls, response.Status)
	}
}

func TestLockContentionServesPolledFresh(t *testing.T) {
	store := newFakeStore()
	store.put("lock:news-aggregator:source:zhihu:refresh", "other-instance")
	service := NewService(ServiceConfig{
		Registry: fakeRegistry{"zhihu": {ID: "zhihu", Interval: 600000}},
		Secrets:  &fakeSecrets{},
		Store:    store,
		Now:      time.Now,
		Env:      func(string) string { return "" },
	})
	var calls int32
	service.pollInterval = 10 * time.Millisecond
	service.pollMaxWait = 2 * time.Second
	service.getters["zhihu"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		atomic.AddInt32(&calls, 1)
		return []NewsItem{newItem(StringID("fresh"), "fresh", "https://example.com/fresh").build()}, nil
	}
	cached := SourceResponse{Status: StatusSuccess, ID: "zhihu", UpdatedTime: Millis(time.Now().UnixMilli()), Items: []NewsItem{
		newItem(StringID("polled"), "polled", "https://example.com/polled").build(),
	}}
	payload, _ := json.Marshal(cached)
	time.AfterFunc(50*time.Millisecond, func() { store.put("news-aggregator:source:zhihu", string(payload)) })

	response, err := service.FetchSource(context.Background(), "zhihu", true)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != StatusCache || len(response.Items) != 1 || response.Items[0].ID.Text != "polled" {
		t.Fatalf("expected polled cache, got %#v", response)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("getter must not run while another process refreshes")
	}
}

func TestLockContentionServesStale(t *testing.T) {
	store := newFakeStore()
	store.put("lock:news-aggregator:source:zhihu:refresh", "other-instance")
	stale := SourceResponse{Status: StatusSuccess, ID: "zhihu", UpdatedTime: Millis(1_600_000_000_000), Items: []NewsItem{
		newItem(StringID("stale"), "stale", "https://example.com/stale").build(),
	}}
	payload, _ := json.Marshal(stale)
	store.put("news-aggregator:source:zhihu:stale", string(payload))

	service := NewService(ServiceConfig{
		Registry: fakeRegistry{"zhihu": {ID: "zhihu", Interval: 600000}},
		Secrets:  &fakeSecrets{},
		Store:    store,
		Now:      time.Now,
		Env:      func(string) string { return "" },
	})
	var calls int32
	service.pollInterval = 10 * time.Millisecond
	service.pollMaxWait = 200 * time.Millisecond
	service.getters["zhihu"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	}
	response, err := service.FetchSource(context.Background(), "zhihu", false)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != StatusCache || len(response.Items) != 1 || response.Items[0].ID.Text != "stale" || atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("expected stale fallback, got %#v calls=%d", response, calls)
	}
}

func TestRedirectAndSecretOrder(t *testing.T) {
	store := newFakeStore()
	secrets := &fakeSecrets{values: map[string]string{"cookie": "abc"}}
	service := newTestService(fakeRegistry{
		"weibo-parent": {ID: "weibo-parent", Redirect: "weibo", Interval: 120000},
		"weibo":        {ID: "weibo", Interval: 120000},
	}, secrets, store)
	var received RuntimeContext
	service.getters["weibo"] = func(_ context.Context, rc RuntimeContext) ([]NewsItem, error) {
		received = rc
		return []NewsItem{newItem(StringID("1"), "t", "https://example.com/1").build()}, nil
	}
	response, err := service.FetchSource(context.Background(), "weibo-parent", false)
	if err != nil {
		t.Fatal(err)
	}
	if response.ID != "weibo-parent" {
		t.Fatalf("response id must be the requested alias, got %q", response.ID)
	}
	if received.SourceID != "weibo" || received.RequestedSourceID != "weibo-parent" {
		t.Fatalf("unexpected runtime context: %#v", received)
	}
	if len(secrets.calls) != 1 || secrets.calls[0] != [2]string{"weibo-parent", "weibo"} {
		t.Fatalf("secret lookup order: %#v", secrets.calls)
	}
	if _, ok := store.value("news-aggregator:source:weibo-parent"); !ok {
		t.Fatalf("cache must use the requested id")
	}
	if _, ok := store.value("news-aggregator:source:weibo"); ok {
		t.Fatalf("resolved id must not share the requested cache entry")
	}
}

func TestBatchWorkerPoolStartsNextBeforeSlowChunkItem(t *testing.T) {
	registry := fakeRegistry{}
	for index := 0; index < 12; index++ {
		id := "s" + string(rune('a'+index))
		registry[id] = SourceMeta{ID: id, Interval: 600000}
	}
	store := newFakeStore()
	service := newTestService(registry, &fakeSecrets{}, store)

	release := make(chan struct{})
	started := make(chan int, 12)
	var current int32
	var peak int32
	for index := 0; index < 12; index++ {
		index := index
		id := "s" + string(rune('a'+index))
		service.getters[id] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
			value := atomic.AddInt32(&current, 1)
			for {
				old := atomic.LoadInt32(&peak)
				if value <= old || atomic.CompareAndSwapInt32(&peak, old, value) {
					break
				}
			}
			started <- index
			if index == 0 {
				<-release
			} else {
				time.Sleep(2 * time.Millisecond)
			}
			atomic.AddInt32(&current, -1)
			return []NewsItem{newItem(StringID(id), id, "https://example.com/"+id).build()}, nil
		}
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		service.FetchBatch(context.Background(), []string{
			"sa", "sb", "sc", "sd", "se", "sf", "sg", "sh", "si", "sj", "sk", "sl",
		}, false)
	}()

	// The eleventh input must start while the first (slow) call is still held.
	deadline := time.After(2 * time.Second)
	sawEleven := false
	for !sawEleven {
		select {
		case index := <-started:
			if index == 10 {
				sawEleven = true
			}
		case <-deadline:
			t.Fatal("the eleventh fetch never started before the slow item finished")
		}
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("batch did not finish")
	}
	if peak > batchConcurrency {
		t.Fatalf("peak concurrency=%d exceeds %d", peak, batchConcurrency)
	}
}

func TestFetchBatchOrderAndPartialFailure(t *testing.T) {
	registry := fakeRegistry{
		"ok":   {ID: "ok", Interval: 600000},
		"bad":  {ID: "bad", Interval: 600000},
		"fail": {ID: "fail", Interval: 600000},
	}
	store := newFakeStore()
	service := newTestService(registry, &fakeSecrets{}, store)
	service.getters["ok"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		return []NewsItem{newItem(StringID("1"), "ok", "https://example.com/ok").build()}, nil
	}
	service.getters["bad"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		return []NewsItem{newItem(StringID("2"), "bad", "https://example.com/bad").build()}, nil
	}
	service.getters["fail"] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
		return nil, &SecretRequiredError{SourceID: "fail", RequiredKeys: []string{"cookie"}}
	}

	response := service.FetchBatch(context.Background(), []string{"ok", "fail", "bad", "ok", "missing"}, false)
	if response.Requested != 5 || response.Processed != 4 {
		t.Fatalf("requested/processed = %d/%d", response.Requested, response.Processed)
	}
	if len(response.Results) != 2 || response.Results[0].ID != "ok" || response.Results[1].ID != "bad" {
		t.Fatalf("result order: %#v", response.Results)
	}
	if len(response.Errors) != 2 || response.Errors[0].ID != "fail" || response.Errors[1].ID != "missing" {
		t.Fatalf("error order: %#v", response.Errors)
	}
	if response.Errors[0].Message != "Runtime secret required for news source: fail" {
		t.Fatalf("batch message must be the business message, got %q", response.Errors[0].Message)
	}
}

func TestBatchLimitUsesFirstHundredUnique(t *testing.T) {
	registry := fakeRegistry{}
	ids := make([]string, 0, 101)
	for index := 0; index < 101; index++ {
		id := "id" + strconv.Itoa(index)
		registry[id] = SourceMeta{ID: id, Interval: 600000}
		ids = append(ids, id)
	}
	store := newFakeStore()
	service := newTestService(registry, &fakeSecrets{}, store)
	var calls int32
	for _, id := range ids {
		service.getters[id] = func(context.Context, RuntimeContext) ([]NewsItem, error) {
			atomic.AddInt32(&calls, 1)
			return []NewsItem{}, nil
		}
	}
	response := service.FetchBatch(context.Background(), ids, false)
	if response.Processed != batchLimit || atomic.LoadInt32(&calls) != batchLimit {
		t.Fatalf("processed=%d calls=%d", response.Processed, calls)
	}
}
