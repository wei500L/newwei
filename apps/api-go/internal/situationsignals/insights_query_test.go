package situationsignals

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/situationinsights/analysis"
)

func TestParseInsightsQueryDefaultsAndParsing(t *testing.T) {
	options, err := parseInsightsQuery(url.Values{})
	if err != nil {
		t.Fatal(err)
	}
	if options.WindowHours != 72 || options.MaxItems != 400 || options.Scope != "all" {
		t.Fatalf("defaults = %+v", options)
	}
	options, err = parseInsightsQuery(url.Values{
		"windowHours": {"12"}, "maxItems": {"60"}, "sections": {" Core,external,core "},
		"gdelt": {"no"}, "scope": {"TAGGED"}, "debug": {"yes"}, "translate": {"zh-hans"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if options.WindowHours != 12 || options.MaxItems != 60 || options.Scope != "tagged" || !options.Debug || !options.Translate {
		t.Fatalf("parsed = %+v", options)
	}
	if options.Gdelt == nil || *options.Gdelt {
		t.Fatalf("gdelt = %+v", options.Gdelt)
	}
	if len(options.Sections) != 2 || options.Sections[0] != "core" || options.Sections[1] != "external" {
		t.Fatalf("sections = %+v", options.Sections)
	}
	if _, err := parseInsightsQuery(url.Values{"windowHours": {"0"}}); err == nil {
		t.Fatal("expected 400 for windowHours=0")
	}
	if _, err := parseInsightsQuery(url.Values{"maxItems": {"49"}}); err == nil {
		t.Fatal("expected 400 for maxItems=49")
	}
	if _, err := parseInsightsQuery(url.Values{"windowHours": {"1.5"}}); err == nil {
		t.Fatal("expected 400 for fractional windowHours")
	}
}

func TestInsightsCacheKeyMatchesNest(t *testing.T) {
	key := insightsCacheKey("org-1", "core", 72, 400, "all", true, false, 3)
	want := "situation-monitor:insights:v2:core:org-1:wh72:mi400:scall:gd1:dbg0:lr3"
	if key != want {
		t.Fatalf("key = %q, want %q", key, want)
	}
	external := insightsCacheKey("org-1", "external", 1, 50, "tagged", false, true, 99)
	if external != "situation-monitor:insights:v2:external:org-1" {
		t.Fatalf("external key = %q", external)
	}
}

func TestFormatJSIsoUsesMilliseconds(t *testing.T) {
	value := time.Date(2026, 10, 19, 20, 31, 5, 7_000_000, time.UTC)
	if got := formatJSIso(value); got != "2026-10-19T20:31:05.007Z" {
		t.Fatalf("iso = %q", got)
	}
}

func TestMarketsSnapshotUsesInjectedEndpointAndKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "key" {
			t.Errorf("token = %q", r.URL.Query().Get("token"))
		}
		symbol := r.URL.Query().Get("symbol")
		if symbol == "BAD" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]float64{"c": 100, "d": 1, "dp": 2})
	}))
	defer server.Close()
	service := &insightsService{
		client: server.Client(), finnhubURL: server.URL,
		finnhubKeyResolver: func(context.Context) string { return "key" },
	}
	snapshot := service.loadMarketsSnapshot(context.Background())
	if !snapshot.HasFinnhubAPIKey {
		t.Fatal("expected key flag")
	}
	if len(snapshot.Indices) != 4 || len(snapshot.Sectors) != 6 || len(snapshot.Commodities) != 4 {
		t.Fatalf("groups = %d/%d/%d", len(snapshot.Indices), len(snapshot.Sectors), len(snapshot.Commodities))
	}
	if snapshot.VIX == nil || snapshot.VIX.Symbol != "VIX" {
		t.Fatalf("vix = %+v", snapshot.VIX)
	}
	if snapshot.Error != "" {
		t.Fatalf("unexpected error = %q", snapshot.Error)
	}
}

func TestFedSnapshotMoneyPrinter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		series := r.URL.Query().Get("series_id")
		values := []string{"100", "90"}
		if series == "WM2NS" {
			values = []string{"22500", "22000"}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"observations": []map[string]string{
			{"value": values[0]}, {"value": values[1]}, {"value": "."},
		}})
	}))
	defer server.Close()
	service := &insightsService{
		client: server.Client(), fredURL: server.URL,
		fredKeyResolver: func(context.Context) string { return "key" },
	}
	snapshot := service.loadFedSnapshot(context.Background())
	if !snapshot.HasFredAPIKey || len(snapshot.Indicators) != 5 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if snapshot.MoneyPrinter == nil || snapshot.MoneyPrinter.ValueTrillions != 22.5 {
		t.Fatalf("money printer = %+v", snapshot.MoneyPrinter)
	}
}

func TestCryptoSnapshotPreservesRequestedOrder(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ethereum":{"usd":2,"usd_24h_change":1},"bitcoin":{"usd":1,"usd_24h_change":2}}`))
	}))
	defer server.Close()
	service := &insightsService{client: server.Client(), coinGeckoURL: server.URL}
	items := service.loadCryptoSnapshot(context.Background())
	if len(items) != 2 || items[0].ID != "bitcoin" || items[1].ID != "ethereum" {
		t.Fatalf("items = %+v", items)
	}
}

func TestDeepLXTranslationRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/secret/translate" {
			t.Errorf("path = %q", r.URL.Path)
		}
		var body struct {
			Text       string `json:"text"`
			SourceLang string `json:"source_lang"`
			TargetLang string `json:"target_lang"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body.Text != "hello" || body.SourceLang != "auto" || body.TargetLang != "ZH" {
			t.Errorf("body = %+v", body)
		}
		_, _ = w.Write([]byte(`{"code":200,"data":"你好"}`))
	}))
	defer server.Close()
	service := &insightsService{client: server.Client()}
	translated, err := service.requestViaDeepLX(context.Background(), "hello", insightsTranslationRuntime{
		Enabled: true, BaseURL: server.URL, APIKey: "secret", TimeoutMS: 2000, MaxRetries: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if translated != "你好" {
		t.Fatalf("translated = %q", translated)
	}
}

func TestFallbackTranslationSourceDetection(t *testing.T) {
	cases := map[string]string{
		"hello":             "en",
		"你好":                "zh-CN",
		"こんにちは":             "ja",
		"안녕하세요":             "ko",
		"bonjour le monde":  "fr",
		"der Mann ist hier": "de",
	}
	for input, want := range cases {
		if got := detectFallbackSourceLang(input); got != want {
			t.Fatalf("%q = %q, want %q", input, got, want)
		}
	}
}

func TestTranslateCacheKey(t *testing.T) {
	if got := insightsTranslationCacheKey(strings.Repeat("a", 64)); got != "situation-monitor:translation:v3:zh-cn:multi:"+strings.Repeat("a", 64) {
		t.Fatalf("key = %q", got)
	}
}

func TestCorePayloadPreservesEmptyArraysAndNullResults(t *testing.T) {
	core := insightsCorePayload{
		Diagnostics:     insightsDiagnostics{RequestedScope: "all", EffectiveScope: "all"},
		CoverageSummary: insightsCoverageSummary{MissingCategories: []analysis.Category{}},
		Headlines:       displayHeadlinesByCategory(analysis.HeadlinesByCategory{}, 12),
		Clusters:        displayClustersByCategory(analysis.ClustersByCategory{}, 6),
		Alerts:          []analysis.AlertHeadline{}, Leaders: []analysis.WorldLeader{},
		Situations: []analysis.SituationPanel{}, Tensions: []tensionPair{},
		CorrelationSummary: analysis.CorrelationSummary{Status: "NO DATA"},
		NarrativeSummary:   analysis.NarrativeSummary{Status: "NO DATA"},
		MainCharacter:      analysis.MainCharacterResults{Characters: []analysis.MainCharacterEntry{}},
	}
	encoded, err := json.Marshal(core)
	if err != nil {
		t.Fatal(err)
	}
	var decoded insightsCorePayload
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	var response insightsResponse
	applyCorePayload(&response, decoded)
	body, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{`"headlines":{"politics":[],"tech":[],"finance":[],"gov":[],"ai":[],"intel":[]}`, `"correlation":null`, `"narrative":null`, `"politics":[]`} {
		if !strings.Contains(text, want) {
			t.Fatalf("response missing %s:\n%s", want, text)
		}
	}
}
