//go:build integration

// Realtime signal collector integration tests against the real MySQL, Redis and
// Mongo CI services. Every external API is an in-process httptest server, so no
// real OpenSky, ACLED, Cloudflare, PizzINT, GDELT, Polymarket or AIS relay request
// is made.
//
// Environment (injected by .github/workflows/ci.yml):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
package realtimesignals

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardwarmap"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimediagnostics"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	integrationOrgOne   = "org-rt-it-1"
	integrationOrgTwo   = "org-rt-it-2"
	integrationOrgThree = "org-rt-it-3"
)

var integrationOrgs = []string{integrationOrgOne, integrationOrgTwo, integrationOrgThree}

func openIntegrationMySQL(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	pool, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	return pool
}

func openIntegrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func openIntegrationMongo(t *testing.T) *dashboardstats.Connection {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI not set — integration test requires Mongo")
	}
	connection, err := dashboardstats.Open(uri)
	if err != nil {
		t.Fatalf("open mongo: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = connection.Disconnect(ctx)
	})
	return connection
}

// stubCronRuntime is the RuntimePort implementation: one fixed configuration so
// the test controls every interval, threshold and endpoint.
type stubCronRuntime struct {
	runtime *dataruntimesettings.RealtimeCronRuntime
}

func (s stubCronRuntime) EffectiveRealtimeCronRuntime(context.Context, bool) (*dataruntimesettings.RealtimeCronRuntime, error) {
	return s.runtime, nil
}

func (s stubCronRuntime) EnvRealtimeCronRuntime() *dataruntimesettings.RealtimeCronRuntime {
	return s.runtime
}

func (s stubCronRuntime) ForceRefreshAcledAccessToken(context.Context) (string, error) {
	return "", nil
}

// realtimeDiagnosticsSettings is the runtimediagnostics settings port.
type realtimeDiagnosticsSettings struct {
	runtime *dataruntimesettings.RealtimeRuntimeSettings
}

func (s realtimeDiagnosticsSettings) EffectiveRealtimeRuntime(context.Context) (*dataruntimesettings.RealtimeRuntimeSettings, error) {
	return s.runtime, nil
}

func (s realtimeDiagnosticsSettings) EnvRealtimeRuntime() *dataruntimesettings.RealtimeRuntimeSettings {
	return s.runtime
}

func (s realtimeDiagnosticsSettings) RealtimeSettingsSource(context.Context) (string, error) {
	return "db", nil
}

func TestRealtimeSignalsCollectorIntegration(t *testing.T) {
	db := openIntegrationMySQL(t)
	rdb := openIntegrationRedis(t)
	mongoConnection := openIntegrationMongo(t)
	mongoDatabase := mongoConnection.Database()
	if mongoDatabase == nil {
		t.Fatal("MONGO_URI must include a database name")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	prepareRealtimeSchema(t, ctx, db)
	prepareRealtimeOrgs(t, ctx, db)
	prepareKeywordArticles(t, ctx, db)
	cleanRealtimeRedis(t, ctx, rdb)
	cleanRealtimeMongo(t, ctx, mongoDatabase)

	// Seed one previous Polymarket price so the first organization produces a
	// lead; the others start with an empty price cache.
	if err := rdb.Set(ctx, polymarketPricesKeyFmt+integrationOrgOne, []byte(`{"evt-1":10}`), time.Hour).Err(); err != nil {
		t.Fatal(err)
	}

	upstreams := newRealtimeUpstreams()
	defer upstreams.Close()

	now := time.Now().UTC()
	runtime := testIntegrationRuntime(upstreams)
	service := NewService(Options{
		Runtime: stubCronRuntime{runtime: runtime},
		Redis:   rdb,
		DB:      db,
		Mongo:   mongoDatabase,
		Now:     func() time.Time { return now },
		endpoints: endpointOverrides{
			ACLED:            upstreams.Server.URL + "/acled",
			GDELTUnrest:      upstreams.Server.URL + "/gdelt-unrest",
			Cloudflare:       upstreams.Server.URL + "/outages",
			PizzintDashboard: upstreams.Server.URL + "/pizzint",
			PizzintTension:   upstreams.Server.URL + "/tension",
		},
	})

	if err := service.RefreshScheduled(ctx); err != nil {
		t.Fatalf("refresh scheduled: %v", err)
	}

	// B1: the military region batch is reserved once for the whole round.
	ledger := readBudgetLedger(t, ctx, rdb, hktDate(now.UnixMilli()))
	if ledger.UsedCredits != 28 || ledger.MilitaryCredits != 24 || ledger.AllCredits != 4 {
		t.Fatalf("ledger credits = %+v, want 28/24/4", ledger)
	}
	if ledger.RequestCount != 7 || ledger.MilitaryCalls != 6 || ledger.AllCalls != 1 {
		t.Fatalf("ledger calls = %+v, want 7/6/1", ledger)
	}
	if got := upstreams.StatesRequests.Load(); got != 7 {
		t.Fatalf("OpenSky states requests = %d, want 7 (6 military + 1 all-capture)", got)
	}
	if got := upstreams.TokenRequests.Load(); got != 1 {
		t.Fatalf("OpenSky token requests = %d, want 1 (cached token)", got)
	}

	// O1: AIS and Polymarket are fetched once per round, not once per organization.
	if got := upstreams.AisRequests.Load(); got != 1 {
		t.Fatalf("AIS relay requests = %d, want 1", got)
	}
	if got := upstreams.PolymarketRequests.Load(); got != 1 {
		t.Fatalf("Polymarket requests = %d, want 1", got)
	}
	if got := upstreams.UnrestRequests.Load(); got != 1 {
		t.Fatalf("GDELT unrest requests = %d, want 1", got)
	}
	if got := upstreams.OutageRequests.Load(); got != 1 {
		t.Fatalf("Cloudflare requests = %d, want 1", got)
	}
	if got := upstreams.PizzintRequests.Load(); got != 1 {
		t.Fatalf("PizzINT dashboard requests = %d, want 1", got)
	}
	if got := upstreams.TensionRequests.Load(); got != 1 {
		t.Fatalf("GDELT tension requests = %d, want 1", got)
	}

	for _, orgID := range integrationOrgs {
		assertOrgState(t, ctx, rdb, orgID)
	}
	assertDiscoveryLeads(t, ctx, rdb)
	assertGlobalCapture(t, ctx, rdb)
	assertTransportDocuments(t, ctx, mongoDatabase)

	// The war-map readers must parse what the collector wrote.
	adsb, err := dashboardwarmap.ReadLatestAdsbSnapshot(ctx, rdb, integrationOrgOne)
	if err != nil {
		t.Fatalf("read ADS-B snapshot: %v", err)
	}
	if adsb == nil || adsb.TotalAircraft != 2 || adsb.ValidPositions != 2 || len(adsb.Aircraft) != 2 {
		t.Fatalf("ADS-B readback = %+v", adsb)
	}
	if adsb.Aircraft[0].CountryCode == "" || adsb.Aircraft[0].ObservedAt == "" {
		t.Fatalf("ADS-B aircraft readback = %+v", adsb.Aircraft[0])
	}
	aisSnapshot, err := dashboardwarmap.ReadLatestAisSnapshot(ctx, rdb, integrationOrgOne)
	if err != nil {
		t.Fatalf("read AIS snapshot: %v", err)
	}
	if aisSnapshot == nil || aisSnapshot.VesselCount != 42 || aisSnapshot.Disruptions != 1 ||
		len(aisSnapshot.Candidates) != 1 || len(aisSnapshot.Vessels) != 1 {
		t.Fatalf("AIS readback = %+v", aisSnapshot)
	}

	// The diagnostics reader must see the same round.
	diagnostics := runtimediagnostics.NewRealtimeService(realtimeDiagnosticsSettings{
		runtime: integrationDiagnosticsRuntime(runtime),
	}, rdb, db, mongoDatabase)
	response, err := diagnostics.Run(ctx, integrationOrgOne)
	if err != nil {
		t.Fatalf("runtime diagnostics: %v", err)
	}
	if !response.RuntimeEnabled || len(response.Sources) != 8 {
		t.Fatalf("diagnostics header = %+v", response)
	}
	if response.OpenSkyBudget.UsedCredits != 28 {
		t.Fatalf("diagnostics budget = %+v", response.OpenSkyBudget)
	}
	openskyFound := false
	aisFound := false
	for _, entry := range response.Sources {
		switch entry.Source {
		case "opensky":
			openskyFound = true
			if !entry.Enabled || entry.LatestValue == nil || *entry.LatestValue != 2 || entry.Status != "ok" {
				t.Fatalf("diagnostics opensky = %+v", entry)
			}
		case "ais":
			aisFound = true
			if entry.AisDiagnostics == nil || entry.AisDiagnostics.VesselCount != 42 || entry.AisDiagnostics.CandidateCount != 1 {
				t.Fatalf("diagnostics ais = %+v", entry)
			}
		}
	}
	if !openskyFound || !aisFound {
		t.Fatal("diagnostics missing opensky or ais")
	}
	insight := InsightSnapshot{}
	if err := json.Unmarshal(response.Insight, &insight); err != nil {
		t.Fatalf("diagnostics insight: %v", err)
	}
	if len(insight.KeywordSpikes) != 1 || len(insight.Tensions) != 1 || insight.Pizzint == nil {
		t.Fatalf("diagnostics insight = %+v", insight)
	}

	// The disabled-runtime branch clears the snapshots and writes the empty
	// insight snapshot for this organization only.
	disabled := *runtime
	disabled.Enabled = false
	if err := service.refreshOrg(ctx, integrationOrgTwo, &disabled, nil); err != nil {
		t.Fatalf("disabled refresh: %v", err)
	}
	if keyExists(t, ctx, rdb, adsbLatestKey(integrationOrgTwo)) || keyExists(t, ctx, rdb, aisLatestKey(integrationOrgTwo)) {
		t.Fatal("disabled runtime did not clear the ADS-B/AIS snapshots")
	}
	storedInsight, err := service.store.getInsightSnapshot(ctx, integrationOrgTwo)
	if err != nil {
		t.Fatal(err)
	}
	if storedInsight == nil || len(storedInsight.KeywordSpikes) != 0 || len(storedInsight.Tensions) != 0 || storedInsight.Pizzint != nil {
		t.Fatalf("disabled insight = %+v", storedInsight)
	}
}

func testIntegrationRuntime(upstreams *realtimeUpstreams) *dataruntimesettings.RealtimeCronRuntime {
	return &dataruntimesettings.RealtimeCronRuntime{
		Enabled:          true,
		RequestTimeoutMs: 3000,
		MaxRetries:       0,
		Capabilities: dataruntimesettings.RealtimeCronCapabilities{
			AcledAPIEnabled:        false,
			AcledAPIDisabledReason: "Open myACLED does not include API access.",
		},
		Sources: dataruntimesettings.RealtimeCronSources{
			Opensky:         dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
			Ais:             dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
			Unrest:          dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
			Outages:         dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
			KeywordSpike:    dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
			Pizzint:         dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
			GdeltTension:    dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
			PolymarketLeads: dataruntimesettings.RealtimeCronSource{Enabled: true, IntervalSec: 600},
		},
		Thresholds: dataruntimesettings.RealtimeCronThresholds{
			KeywordSpikeMinCount: 5, KeywordSpikeMultiplier: 3,
			PredictionShiftThreshold: 5, PredictionNewsActivityThreshold: 3,
		},
		AisRelay: dataruntimesettings.RealtimeCronAisRelay{
			BaseURL: upstreams.Server.URL, SharedSecret: "relay-secret",
		},
		Opensky: dataruntimesettings.RealtimeCronOpensky{
			BaseURL: upstreams.Server.URL + "/api", TokenURL: upstreams.Server.URL + "/token",
			ClientID: "client", ClientSecret: "secret",
			DailyCreditBudget: 4000, DayIntervalSec: 600, NightIntervalSec: 1800,
			DayStartHourHKT: 8, NightStartHourHKT: 22,
			WarningRemainingPct: 20, CriticalRemainingPct: 10,
		},
		Credentials: dataruntimesettings.RealtimeCronCredentials{CloudflareAPIToken: "cf-token"},
		Polymarket:  dataruntimesettings.RealtimeCronPolymarket{ProxyURL: upstreams.Server.URL},
	}
}

func integrationDiagnosticsRuntime(runtime *dataruntimesettings.RealtimeCronRuntime) *dataruntimesettings.RealtimeRuntimeSettings {
	return &dataruntimesettings.RealtimeRuntimeSettings{
		Enabled: runtime.Enabled, RequestTimeoutMs: runtime.RequestTimeoutMs, MaxRetries: runtime.MaxRetries,
		OpenskyEnabled: runtime.Sources.Opensky.Enabled, OpenskyIntervalSec: runtime.Sources.Opensky.IntervalSec,
		OpenskyDailyCreditBudget: runtime.Opensky.DailyCreditBudget,
		OpenskyDayIntervalSec:    runtime.Opensky.DayIntervalSec, OpenskyNightIntervalSec: runtime.Opensky.NightIntervalSec,
		OpenskyDayStartHourHKT: runtime.Opensky.DayStartHourHKT, OpenskyNightStartHourHKT: runtime.Opensky.NightStartHourHKT,
		OpenskyWarningRemainingPct: runtime.Opensky.WarningRemainingPct, OpenskyCriticalRemainingPct: runtime.Opensky.CriticalRemainingPct,
		AisEnabled: runtime.Sources.Ais.Enabled, AisIntervalSec: runtime.Sources.Ais.IntervalSec,
		UnrestEnabled: runtime.Sources.Unrest.Enabled, UnrestIntervalSec: runtime.Sources.Unrest.IntervalSec,
		OutagesEnabled: runtime.Sources.Outages.Enabled, OutagesIntervalSec: runtime.Sources.Outages.IntervalSec,
		KeywordSpikeEnabled: runtime.Sources.KeywordSpike.Enabled, KeywordSpikeIntervalSec: runtime.Sources.KeywordSpike.IntervalSec,
		PizzintEnabled: runtime.Sources.Pizzint.Enabled, PizzintIntervalSec: runtime.Sources.Pizzint.IntervalSec,
		GdeltTensionEnabled: runtime.Sources.GdeltTension.Enabled, GdeltTensionIntervalSec: runtime.Sources.GdeltTension.IntervalSec,
		PolymarketLeadsEnabled: runtime.Sources.PolymarketLeads.Enabled, PolymarketLeadsIntervalSec: runtime.Sources.PolymarketLeads.IntervalSec,
	}
}

// ---- upstream fixture ----

type realtimeUpstreams struct {
	Server             *httptest.Server
	TokenRequests      atomic.Int64
	StatesRequests     atomic.Int64
	AisRequests        atomic.Int64
	PolymarketRequests atomic.Int64
	UnrestRequests     atomic.Int64
	OutageRequests     atomic.Int64
	PizzintRequests    atomic.Int64
	TensionRequests    atomic.Int64
}

func newRealtimeUpstreams() *realtimeUpstreams {
	upstreams := &realtimeUpstreams{}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		upstreams.TokenRequests.Add(1)
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != "grant_type=client_credentials&client_id=client&client_secret=secret" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"opensky-token","expires_in":3600}`))
	})
	mux.HandleFunc("/api/states/all", func(w http.ResponseWriter, r *http.Request) {
		upstreams.StatesRequests.Add(1)
		if r.Header.Get("Authorization") != "Bearer opensky-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		nowSeconds := time.Now().Unix()
		_, _ = fmt.Fprintf(w, `{"time":%d,"states":[
			["abc123","RCH1","United States",%d,%d,10,20,10000,false,250,90,0,0,10000,null,false,0],
			["ae1234","EVAC1","Germany",%d,%d,11,21,9000,false,240,80,0,0,9000,null,false,0]
		]}`, nowSeconds, nowSeconds, nowSeconds, nowSeconds, nowSeconds)
	})
	mux.HandleFunc("/ais/snapshot", func(w http.ResponseWriter, r *http.Request) {
		upstreams.AisRequests.Add(1)
		if r.URL.RawQuery != "candidates=true" || r.Header.Get("Authorization") != "Bearer relay-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{
			"timestamp":"2026-10-20T12:00:00.000Z",
			"status":{"connected":true,"vessels":42,"messages":100,"clients":2,"droppedMessages":0},
			"diagnostics":{"healthState":"ok","positionReportsSeen":10,"positionReportsProcessed":10},
			"disruptions":[{"id":"d1","name":"Hormuz","type":"chokepoint","lat":26.5,"lon":56.2,"severity":"high","region":"Iran"}],
			"density":[],
			"candidateReports":[{"mmsi":111111111,"lat":1,"lng":2,"shipType":55,"name":"WARSHIP"}],
			"vessels":[{"mmsi":222222222,"lat":3,"lng":4,"name":"CARGO","shipType":70}]
		}`))
	})
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		upstreams.PolymarketRequests.Add(1)
		if r.URL.RawQuery != "closed=false&limit=60" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`[{"id":"evt-1","title":"Election outcome 2026","active":true,"volume":5000,"markets":[{"lastTradePrice":0.5}]}]`))
	})
	mux.HandleFunc("/gdelt-unrest", func(w http.ResponseWriter, r *http.Request) {
		upstreams.UnrestRequests.Add(1)
		if r.URL.Query().Get("QUERY") != "PROTEST" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"features":[
			{"properties":{"name":"Protest, Iran","mentionedthemes":"PROTEST","urltone":-2,"urlpubtimedate":"20261020120000"},"geometry":{"coordinates":[51.4,35.7]}},
			{"properties":{"name":"Protest, Iran","mentionedthemes":"PROTEST","urltone":-2,"urlpubtimedate":"20261020130000"},"geometry":{"coordinates":[51.4,35.7]}}
		]}`))
	})
	mux.HandleFunc("/outages", func(w http.ResponseWriter, r *http.Request) {
		upstreams.OutageRequests.Add(1)
		if r.Header.Get("Authorization") != "Bearer cf-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"result":[{"locations":[{"alpha2":"IR"}]},{"locations":[{"name":"Russia"}]}]}`))
	})
	mux.HandleFunc("/pizzint", func(w http.ResponseWriter, r *http.Request) {
		upstreams.PizzintRequests.Add(1)
		_, _ = w.Write([]byte(`{"locations":[{"open":true,"pop":80,"activeSpike":true},{"open":true,"pop":70}]}`))
	})
	mux.HandleFunc("/tension", func(w http.ResponseWriter, r *http.Request) {
		upstreams.TensionRequests.Add(1)
		if r.URL.Query().Get("method") != "gpr" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"usa_russia":[{"t":"2026-10-13","v":60},{"t":"2026-10-20","v":75}]}`))
	})
	upstreams.Server = httptest.NewServer(mux)
	return upstreams
}

func (u *realtimeUpstreams) Close() {
	if u != nil && u.Server != nil {
		u.Server.Close()
	}
}

// ---- fixtures and assertions ----

func prepareRealtimeSchema(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	statements := []string{
		"CREATE TABLE IF NOT EXISTS `Org` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT false," +
			"`description` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedById` VARCHAR(191) NULL," +
			"PRIMARY KEY (`key`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"DROP TABLE IF EXISTS `ProcessedArticleTermHourly`",
		"DROP TABLE IF EXISTS `ProcessedArticle`",
		"CREATE TABLE `ProcessedArticle` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `articleId` VARCHAR(191) NOT NULL," +
			"`status` VARCHAR(32) NOT NULL, `title` VARCHAR(191) NULL, `summary` TEXT NULL, `source` VARCHAR(191) NULL," +
			"`topics` JSON NULL, `processedAt` DATETIME(3) NOT NULL, `hasLocation` BOOLEAN NOT NULL DEFAULT false," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `ProcessedArticleTermHourly` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `processedArticleId` VARCHAR(191) NOT NULL," +
			"`bucketStart` DATETIME(3) NOT NULL, `term` VARCHAR(191) NOT NULL, `source` VARCHAR(191) NOT NULL," +
			"`articleCount` INT NOT NULL DEFAULT 1, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("schema statement failed: %v\n%s", err, statement)
		}
	}
	now := time.Now().UTC()
	if _, err := db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt) "+
			"VALUES (?, ?, 0, NULL, ?, ?) AS new_row "+
			"ON DUPLICATE KEY UPDATE value = new_row.value",
		"multi_tenant_scheduler_runtime_settings", `{"realtimeSignalsOrgConcurrency":3}`, now, now); err != nil {
		t.Fatalf("seed scheduler settings: %v", err)
	}
}

func prepareRealtimeOrgs(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	now := time.Now().UTC()
	for _, orgID := range integrationOrgs {
		if _, err := db.ExecContext(ctx,
			"INSERT INTO Org (id, name, slug, isActive, createdAt, updatedAt) VALUES (?, ?, ?, true, ?, ?) "+
				"ON DUPLICATE KEY UPDATE isActive = true",
			orgID, orgID, orgID, now, now); err != nil {
			t.Fatalf("seed org %s: %v", orgID, err)
		}
	}
}

func prepareKeywordArticles(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	processedAt := time.Now().UTC().Add(-30 * time.Minute)
	for _, orgID := range integrationOrgs {
		for index := 0; index < 6; index++ {
			source := "reuters"
			if index%2 == 1 {
				source = "ap"
			}
			articleID := fmt.Sprintf("rt-article-%s-%d", orgID, index)
			if _, err := db.ExecContext(ctx,
				"INSERT INTO ProcessedArticle (id, orgId, articleId, status, title, summary, source, topics, processedAt, hasLocation) "+
					"VALUES (?, ?, ?, 'completed', 'Taiwan', 'taiwan', ?, JSON_ARRAY(), ?, false)",
				articleID, orgID, articleID+"-src", source, processedAt); err != nil {
				t.Fatalf("seed keyword article: %v", err)
			}
		}
	}
}

func cleanRealtimeRedis(t *testing.T, ctx context.Context, rdb *redis.Client) {
	t.Helper()
	patterns := []string{
		"realtime-signals:*",
		"cron:realtime-signals:*",
		"lock:cron:realtime-signals:*",
		"lock:realtime-signals:*",
		"org:active:list:v1",
		"lock:org:active:list:v1",
	}
	for _, pattern := range patterns {
		keys, err := rdb.Keys(ctx, pattern).Result()
		if err != nil {
			t.Fatalf("scan %s: %v", pattern, err)
		}
		if len(keys) > 0 {
			if err := rdb.Del(ctx, keys...).Err(); err != nil {
				t.Fatalf("delete %s: %v", pattern, err)
			}
		}
	}
}

func cleanRealtimeMongo(t *testing.T, ctx context.Context, database *mongo.Database) {
	t.Helper()
	filter := bson.D{{Key: "orgId", Value: bson.D{{Key: "$in", Value: integrationOrgs}}}}
	for _, collection := range []string{transportStateCollection, transportTrackCollection} {
		if _, err := database.Collection(collection).DeleteMany(ctx, filter); err != nil {
			t.Fatalf("clean %s: %v", collection, err)
		}
	}
}

type budgetLedger struct {
	UsedCredits     float64
	RequestCount    float64
	MilitaryCredits float64
	AllCredits      float64
	MilitaryCalls   float64
	AllCalls        float64
}

func readBudgetLedger(t *testing.T, ctx context.Context, rdb *redis.Client, dateHKT string) budgetLedger {
	t.Helper()
	payload, err := rdb.HGetAll(ctx, openskyCreditsKeyFmt+dateHKT).Result()
	if err != nil {
		t.Fatal(err)
	}
	read := func(key string) float64 {
		value, ok := payload[key]
		if !ok {
			return 0
		}
		parsed, parseErr := strconv.ParseFloat(value, 64)
		if parseErr != nil {
			t.Fatalf("ledger %s = %q", key, value)
		}
		return parsed
	}
	return budgetLedger{
		UsedCredits: read("usedCredits"), RequestCount: read("requestCount"),
		MilitaryCredits: read("militaryCredits"), AllCredits: read("allCredits"),
		MilitaryCalls: read("militaryCalls"), AllCalls: read("allCalls"),
	}
}

func assertOrgState(t *testing.T, ctx context.Context, rdb *redis.Client, orgID string) {
	t.Helper()
	store := &Store{redis: rdb}
	for _, source := range sourceOrder {
		state, err := store.getSourceState(ctx, orgID, source)
		if err != nil {
			t.Fatalf("%s %s state: %v", orgID, source, err)
		}
		if state == nil || state.Status != "success" || state.LastSuccessAt == "" {
			t.Fatalf("%s %s state = %+v", orgID, source, state)
		}
		lastRun, err := store.getLastRun(ctx, orgID, source)
		if err != nil || lastRun == nil {
			t.Fatalf("%s %s lastRun = %v/%v", orgID, source, lastRun, err)
		}
	}
	openskyPoints, err := store.getSeries(ctx, orgID, metricOpensky)
	if err != nil || len(openskyPoints) != 1 || openskyPoints[0].Value != 2 {
		t.Fatalf("%s opensky series = %+v/%v", orgID, openskyPoints, err)
	}
	healthPoints, err := store.getSeries(ctx, orgID, metricOpenskySnapshotHealth)
	if err != nil || len(healthPoints) != 1 {
		t.Fatalf("%s health series = %+v/%v", orgID, healthPoints, err)
	}
	insight, err := store.getInsightSnapshot(ctx, orgID)
	if err != nil || insight == nil {
		t.Fatalf("%s insight = %+v/%v", orgID, insight, err)
	}
	if len(insight.KeywordSpikes) != 1 || len(insight.Tensions) != 1 || insight.Pizzint == nil {
		t.Fatalf("%s insight = %+v", orgID, insight)
	}
	if !keyExists(t, ctx, rdb, adsbLatestKey(orgID)) || !keyExists(t, ctx, rdb, aisLatestKey(orgID)) {
		t.Fatalf("%s snapshots missing", orgID)
	}
}

func assertDiscoveryLeads(t *testing.T, ctx context.Context, rdb *redis.Client) {
	t.Helper()
	store := &Store{redis: rdb}
	insight, err := store.getInsightSnapshot(ctx, integrationOrgOne)
	if err != nil || insight == nil {
		t.Fatalf("org one insight: %+v/%v", insight, err)
	}
	if len(insight.PredictionLeads) != 1 || insight.PredictionLeads[0].Shift != 40 {
		t.Fatalf("org one prediction leads = %+v", insight.PredictionLeads)
	}
	prices, found, err := rediscache.GetJSON[map[string]float64](ctx, rdb, polymarketPricesKeyFmt+integrationOrgOne)
	if err != nil || !found || prices["evt-1"] != 50 {
		t.Fatalf("org one prices = %+v/%t/%v", prices, found, err)
	}
	other, err := store.getInsightSnapshot(ctx, integrationOrgTwo)
	if err != nil || other == nil {
		t.Fatalf("org two insight: %+v/%v", other, err)
	}
	if len(other.PredictionLeads) != 0 {
		t.Fatalf("org two prediction leads = %+v", other.PredictionLeads)
	}
}

func assertGlobalCapture(t *testing.T, ctx context.Context, rdb *redis.Client) {
	t.Helper()
	lastRun, err := rdb.Get(ctx, openskyAllCaptureLastRun).Result()
	if err != nil || lastRun == "" {
		t.Fatalf("all-capture last-run = %q/%v", lastRun, err)
	}
	cursor, err := rdb.Get(ctx, openskyAllCaptureCursor).Result()
	if err != nil || cursor != "1" {
		t.Fatalf("all-capture cursor = %q/%v", cursor, err)
	}
}

func assertTransportDocuments(t *testing.T, ctx context.Context, mongoDatabase *mongo.Database) {
	t.Helper()
	states := mongoDatabase.Collection(transportStateCollection)
	tracks := mongoDatabase.Collection(transportTrackCollection)
	for _, orgID := range integrationOrgs {
		stateCount, err := states.CountDocuments(ctx, bson.D{{Key: "orgId", Value: orgID}})
		if err != nil {
			t.Fatal(err)
		}
		if stateCount != 4 {
			t.Fatalf("%s transport states = %d, want 4", orgID, stateCount)
		}
		trackCount, err := tracks.CountDocuments(ctx, bson.D{{Key: "orgId", Value: orgID}})
		if err != nil {
			t.Fatal(err)
		}
		if trackCount != 4 {
			t.Fatalf("%s transport tracks = %d, want 4", orgID, trackCount)
		}
	}
}

func keyExists(t *testing.T, ctx context.Context, rdb *redis.Client, key string) bool {
	t.Helper()
	count, err := rdb.Exists(ctx, key).Result()
	if err != nil {
		t.Fatal(err)
	}
	return count > 0
}
