package realtimesignals

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// RuntimePort is the settings surface the collector needs. The production
// implementation is *dataruntimesettings.Service.
type RuntimePort interface {
	EffectiveRealtimeCronRuntime(ctx context.Context, refreshAcledToken bool) (*dataruntimesettings.RealtimeCronRuntime, error)
	EnvRealtimeCronRuntime() *dataruntimesettings.RealtimeCronRuntime
	ForceRefreshAcledAccessToken(ctx context.Context) (string, error)
}

// Options are the production dependencies. Every connection is shared with the
// rest of the Go process; the collector opens none of its own.
type Options struct {
	Runtime RuntimePort
	Redis   *redis.Client
	DB      *sql.DB
	Mongo   *mongo.Database
	Logger  *log.Logger
	Now     func() time.Time
	// endpoints let an in-package test point the fixed external APIs at
	// httptest servers. Production leaves it zero so every URL keeps its
	// constant default.
	endpoints endpointOverrides
}

// endpointOverrides replaces the fixed upstream URLs. Only tests set it.
type endpointOverrides struct {
	ACLED            string
	GDELTUnrest      string
	Cloudflare       string
	PizzintDashboard string
	PizzintTension   string
}

func (o endpointOverrides) acledURL() string {
	if o.ACLED != "" {
		return o.ACLED
	}
	return acledAPIURL
}

func (o endpointOverrides) gdeltUnrestURL() string {
	if o.GDELTUnrest != "" {
		return o.GDELTUnrest
	}
	return gdeltUnrestGeoJSON
}

func (o endpointOverrides) cloudflareURL() string {
	if o.Cloudflare != "" {
		return o.Cloudflare
	}
	return cloudflareOutagesURL
}

func (o endpointOverrides) pizzintDashboardURL() string {
	if o.PizzintDashboard != "" {
		return o.PizzintDashboard
	}
	return pizzintDashboardURL
}

func (o endpointOverrides) pizzintTensionURL() string {
	if o.PizzintTension != "" {
		return o.PizzintTension
	}
	return pizzintTensionURL
}

// Service owns the collection round.
type Service struct {
	runtime   RuntimePort
	store     *Store
	transport *TransportPersistence
	http      *httpClient
	openSky   *openSkyService
	logger    *log.Logger
	now       func() time.Time
	endpoints endpointOverrides

	aisIssueMu       sync.Mutex
	aisIssueIdentity map[string]string
}

// NewService builds the collector.
func NewService(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	logger := options.Logger
	if logger == nil {
		logger = log.Default()
	}
	store := NewStore(options.Redis, options.DB)
	transport := NewTransportPersistence(options.Mongo)
	httpClient := newHTTPClient()
	return &Service{
		runtime:          options.Runtime,
		store:            store,
		transport:        transport,
		http:             httpClient,
		openSky:          newOpenSkyService(store, httpClient, transport),
		logger:           logger,
		now:              now,
		endpoints:        options.endpoints,
		aisIssueIdentity: make(map[string]string),
	}
}

func (s *Service) clockMillis() int64 {
	if s != nil && s.now != nil {
		return s.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

func (s *Service) logf(format string, args ...any) {
	if s != nil && s.logger != nil {
		s.logger.Printf(format, args...)
	}
}

// OrgRunStatus is RealtimeSignalsSchedulerOrgRunStatus.
type OrgRunStatus string

const (
	OrgRunCompleted OrgRunStatus = "completed"
	OrgRunSkipped   OrgRunStatus = "skipped"
)

// RefreshScheduled is RealtimeSignalsService.refreshScheduled: claim the tick,
// resolve the runtime, fan out the active organizations with the persisted
// concurrency, then run the global all-flight capture once.
func (s *Service) RefreshScheduled(ctx context.Context) error {
	if s == nil || s.runtime == nil || s.store == nil {
		return errors.New("realtimesignals: service is not configured")
	}
	claimed, err := rediscache.ClaimTick(ctx, s.store.redis, tickGateKey, tickGateTTL*time.Millisecond, s.now())
	if err != nil {
		return err
	}
	if !claimed {
		s.logf("realtimesignals: skipped tick because another instance already claimed this interval")
		return nil
	}

	runtime, err := s.getRuntimeConfig(ctx, true)
	if err != nil {
		return err
	}
	if !runtime.Enabled {
		return nil
	}
	orgIDs, err := s.store.listActiveOrgIDs(ctx)
	if err != nil {
		return err
	}
	if len(orgIDs) == 0 {
		return nil
	}
	concurrency, err := s.store.readOrgConcurrency(ctx)
	if err != nil {
		return err
	}
	round := newRoundContext(runtime)
	s.logf("realtimesignals: tick started orgCount=%d concurrency=%d", len(orgIDs), concurrency)

	results := settleWithConcurrency(ctx, orgIDs, concurrency, func(ctx context.Context, _ int, orgID string) (OrgRunStatus, error) {
		return s.refreshOrgWithLock(ctx, orgID, runtime, round)
	})
	failedOrgs := 0
	skippedOrgs := 0
	for index, result := range results {
		if result.err != nil {
			failedOrgs++
			s.logf("realtimesignals: org refresh failed orgId=%s err=%v", orgIDs[index], result.err)
			continue
		}
		if result.value == OrgRunSkipped {
			skippedOrgs++
		}
	}

	if err := s.refreshGlobalAllFlightCaptureWithLock(ctx, orgIDs, runtime); err != nil {
		s.logf("realtimesignals: global all-flight capture failed: %v", err)
	}
	s.logf("realtimesignals: tick completed orgCount=%d concurrency=%d failedOrgs=%d skippedOrgs=%d",
		len(orgIDs), concurrency, failedOrgs, skippedOrgs)
	return nil
}

// getRuntimeConfig mirrors getRuntimeConfig: a settings failure degrades to the
// environment-only configuration instead of failing the tick.
func (s *Service) getRuntimeConfig(ctx context.Context, refreshAcledToken bool) (*dataruntimesettings.RealtimeCronRuntime, error) {
	runtime, err := s.runtime.EffectiveRealtimeCronRuntime(ctx, refreshAcledToken)
	if err == nil && runtime != nil {
		return runtime, nil
	}
	s.logf("realtimesignals: failed to resolve runtime settings from DB; falling back to env: %v", err)
	fallback := s.runtime.EnvRealtimeCronRuntime()
	if fallback == nil {
		if err == nil {
			err = errors.New("realtimesignals: env runtime configuration is invalid")
		}
		return nil, err
	}
	return fallback, nil
}

// refreshOrgWithLock is refreshOrgWithLock: the organization lease is the shared
// `lock:cron:realtime-signals:org:{orgId}` key with a five minute TTL.
func (s *Service) refreshOrgWithLock(ctx context.Context, orgID string, runtime *dataruntimesettings.RealtimeCronRuntime, round *roundContext) (OrgRunStatus, error) {
	status := OrgRunSkipped
	acquired, err := rediscache.WithLock(ctx, s.store.redis, orgLockKeyFmt+orgID, time.Duration(ingestLockTTL)*time.Millisecond, func(ctx context.Context) error {
		status = OrgRunCompleted
		return s.refreshOrg(ctx, orgID, runtime, round)
	})
	if err != nil {
		return "", err
	}
	if acquired {
		return status, nil
	}
	s.logf("realtimesignals: skipped org refresh because the previous org run is still in progress orgId=%s", orgID)
	return OrgRunSkipped, nil
}

// refreshGlobalAllFlightCaptureWithLock is
// refreshGlobalAllFlightCaptureWithLock.
func (s *Service) refreshGlobalAllFlightCaptureWithLock(ctx context.Context, orgIDs []string, runtime *dataruntimesettings.RealtimeCronRuntime) error {
	acquired, err := rediscache.WithLock(ctx, s.store.redis, allCaptureLockKey, time.Duration(ingestLockTTL)*time.Millisecond, func(ctx context.Context) error {
		return s.openSky.refreshGlobalAllFlightCapture(ctx, orgIDs, runtime)
	})
	if err != nil {
		return err
	}
	if !acquired {
		s.logf("realtimesignals: skipped global all-flight capture because another run is in progress")
	}
	return nil
}

// refreshOrg is refreshOrg: it walks REALTIME_SIGNAL_SOURCES in order, writes one
// point per result, records the source state, and rebuilds the insight snapshot.
func (s *Service) refreshOrg(ctx context.Context, orgID string, runtime *dataruntimesettings.RealtimeCronRuntime, round *roundContext) error {
	if !runtime.Enabled {
		if err := s.store.clearLatestAdsbSnapshot(ctx, orgID); err != nil {
			return err
		}
		if err := s.store.clearLatestAisSnapshot(ctx, orgID); err != nil {
			return err
		}
		return s.store.setInsightSnapshot(ctx, orgID, emptyInsightSnapshot())
	}

	currentInsight := emptyInsightSnapshot()
	if stored, err := s.store.getInsightSnapshot(ctx, orgID); err != nil {
		return err
	} else if stored != nil {
		currentInsight = normalizeInsightSnapshot(*stored)
	}
	nextInsight := emptyInsightSnapshot()
	nowMs := s.clockMillis()
	var openskyBudget *budgetSummary
	if runtime.Sources.Opensky.Enabled {
		summary, err := s.openSky.getBudgetSummary(ctx, runtime, nowMs)
		if err != nil {
			return err
		}
		openskyBudget = &summary
	}

	for _, source := range sourceOrder {
		enabled, configuredInterval := sourceConfig(runtime, source)
		if !enabled {
			if source == SourceOpensky {
				if err := s.store.clearLatestAdsbSnapshot(ctx, orgID); err != nil {
					return err
				}
			} else if source == SourceAis {
				if err := s.store.clearLatestAisSnapshot(ctx, orgID); err != nil {
					return err
				}
			}
			continue
		}
		previousState, err := s.store.getSourceState(ctx, orgID, source)
		if err != nil {
			return err
		}
		lastRunMs, err := s.store.getLastRun(ctx, orgID, source)
		if err != nil {
			return err
		}
		effectiveIntervalSec := configuredInterval
		if source == SourceOpensky && openskyBudget != nil {
			effectiveIntervalSec = openskyBudget.EffectiveMilitaryIntervalSec
		}
		refreshState := resolveRefreshState(previousState, lastRunMs, effectiveIntervalSec, s.clockMillis())
		if !refreshState.shouldRun {
			carryForwardInsightSnapshot(&nextInsight, currentInsight, source, refreshState.lastRunMs, effectiveIntervalSec, nowMs)
			continue
		}

		results, fetchErr := s.fetchSource(ctx, orgID, source, runtime, round)
		if fetchErr != nil {
			completedAtMs := s.clockMillis()
			nowIso := formatISO(completedAtMs)
			details := diagnosticErrorDetails(fetchErr)
			nextEligibleAt := computeNextEligibleAt(completedAtMs, effectiveIntervalSec, fetchErr)
			state := SourceState{
				Source:          source,
				Status:          "error",
				LastAttemptAt:   nowIso,
				NextEligibleAt:  nextEligibleAt,
				LastErrorAt:     nowIso,
				LastError:       details.Message,
				LastErrorCode:   details.Code,
				LastErrorStatus: details.Status,
				LastRateLimit:   rateLimitDetails(fetchErr),
			}
			if source == SourceOpensky {
				state.LastErrorKind = details.Kind
			}
			if previousState != nil {
				state.LastSuccessAt = previousState.LastSuccessAt
				state.MetricSlug = previousState.MetricSlug
				state.LatestValue = previousState.LatestValue
				state.Context = previousState.Context
			}
			if err := s.store.setSourceState(ctx, orgID, state); err != nil {
				return err
			}
			// A failed insight source keeps its previous data, matching the
			// shouldRun=false carry-forward path.
			carryForwardInsightSnapshot(&nextInsight, currentInsight, source, lastRunMs, effectiveIntervalSec, completedAtMs)
			s.logf("realtimesignals: source refresh failed orgId=%s source=%s err=%v", orgID, source, fetchErr)
			continue
		}

		completedAtMs := s.clockMillis()
		nowIso := formatISO(completedAtMs)
		nextEligibleAt := formatISO(completedAtMs + int64(maxInt(minSourceInterval, int(jsTrunc(float64(effectiveIntervalSec)))))*1000)
		for _, result := range results {
			if err := s.store.appendPoint(ctx, orgID, result.MetricSlug, metricPoint{
				TS: nowIso, Value: result.Value, Context: result.Context.rawContext(),
			}); err != nil {
				return err
			}
		}
		if err := s.store.setLastRun(ctx, orgID, source, completedAtMs); err != nil {
			return err
		}
		success := SourceState{
			Source:         source,
			Status:         "success",
			LastAttemptAt:  nowIso,
			NextEligibleAt: nextEligibleAt,
			LastSuccessAt:  nowIso,
		}
		if len(results) > 0 {
			success.MetricSlug = results[0].MetricSlug
			value := results[0].Value
			success.LatestValue = &value
			if results[0].Context != nil {
				success.Context = results[0].Context.rawContext()
			}
		}
		if err := s.store.setSourceState(ctx, orgID, success); err != nil {
			return err
		}
		updateInsightSnapshot(&nextInsight, source, results, nowIso)
	}
	return s.store.setInsightSnapshot(ctx, orgID, nextInsight)
}

// normalizeInsightSnapshot repairs an old or partial cached snapshot so a
// carry-forward assigns arrays instead of nil slices.
func normalizeInsightSnapshot(snapshot InsightSnapshot) InsightSnapshot {
	if snapshot.KeywordSpikes == nil {
		snapshot.KeywordSpikes = []KeywordSpike{}
	}
	if snapshot.PredictionLeads == nil {
		snapshot.PredictionLeads = []PredictionLead{}
	}
	if snapshot.Tensions == nil {
		snapshot.Tensions = []TensionRow{}
	}
	return snapshot
}

// refreshState is the resolveRefreshState result.
type refreshState struct {
	shouldRun bool
	lastRunMs *float64
}

// resolveRefreshState mirrors resolveRefreshState. nextEligibleAt wins when
// present; otherwise the interval since lastAttemptAt (or lastRun) decides.
func resolveRefreshState(state *SourceState, lastRunMs *float64, intervalSec int, nowMs int64) refreshState {
	safeIntervalSec := maxInt(minSourceInterval, int(jsTrunc(float64(intervalSec))))
	if state != nil {
		if nextEligibleMs, ok := parseJSTimeMillis(state.NextEligibleAt); ok {
			return refreshState{shouldRun: nowMs >= nextEligibleMs, lastRunMs: lastRunMs}
		}
	}
	var lastAttemptMs int64
	hasLastAttempt := false
	if state != nil {
		if parsed, ok := parseJSTimeMillis(state.LastAttemptAt); ok {
			lastAttemptMs = parsed
			hasLastAttempt = true
		}
	}
	if !hasLastAttempt && lastRunMs != nil {
		lastAttemptMs = int64(*lastRunMs)
		hasLastAttempt = true
	}
	if !hasLastAttempt {
		return refreshState{shouldRun: true, lastRunMs: nil}
	}
	return refreshState{
		shouldRun: nowMs-lastAttemptMs >= int64(safeIntervalSec)*1000,
		lastRunMs: lastRunMs,
	}
}

// computeNextEligibleAt mirrors computeNextEligibleAt: the default interval, or
// the larger Retry-After when the upstream asked for more.
func computeNextEligibleAt(attemptCompletedAtMs int64, intervalSec int, err error) string {
	defaultDelayMs := int64(maxInt(minSourceInterval, int(jsTrunc(float64(intervalSec))))) * 1000
	delayMs := defaultDelayMs
	if retryAfter := retryAfterMillis(err); retryAfter != nil && *retryAfter > defaultDelayMs {
		delayMs = *retryAfter
	}
	return formatISO(attemptCompletedAtMs + delayMs)
}

// carryForwardInsightSnapshot mirrors carryForwardInsightSnapshot: only insight
// sources carry data, and only while the previous run is still fresh.
func carryForwardInsightSnapshot(next *InsightSnapshot, current InsightSnapshot, source SignalSource, lastRunMs *float64, intervalSec int, nowMs int64) {
	if !isInsightSource(source) || lastRunMs == nil {
		return
	}
	safeIntervalSec := maxInt(minSourceInterval, int(jsTrunc(float64(intervalSec))))
	freshnessMs := int64(maxInt(insightFreshMinSec, safeIntervalSec*2)) * 1000
	if nowMs-int64(*lastRunMs) > freshnessMs {
		return
	}
	switch source {
	case SourceKeywordSpike:
		next.KeywordSpikes = current.KeywordSpikes
	case SourcePolymarketLeads:
		next.PredictionLeads = current.PredictionLeads
	case SourceGdeltTension:
		next.Tensions = current.Tensions
	case SourcePizzint:
		next.Pizzint = current.Pizzint
	}
}

func isInsightSource(source SignalSource) bool {
	switch source {
	case SourceKeywordSpike, SourcePolymarketLeads, SourceGdeltTension, SourcePizzint:
		return true
	default:
		return false
	}
}

// updateInsightSnapshot mirrors updateInsightSnapshot. The typed context is read
// directly: it was produced by this collector, so there is no JSON round trip.
func updateInsightSnapshot(snapshot *InsightSnapshot, source SignalSource, results []FetchResult, fallbackTimestamp string) {
	if len(results) == 0 || results[0].Context == nil {
		return
	}
	switch contextValue := results[0].Context.(type) {
	case *keywordSpikeContext:
		spikes := make([]KeywordSpike, 0, len(contextValue.Spikes))
		for index, entry := range contextValue.Spikes {
			id := entry.ID
			if id == "" {
				term := entry.Term
				if term == "" {
					term = jsNumberString(float64(index))
				}
				id = "keyword:" + term
			}
			term := entry.Term
			if term == "" {
				term = "unknown"
			}
			spikes = append(spikes, KeywordSpike{
				ID: id, Term: term, Count: entry.Count, Baseline: entry.Baseline,
				Multiplier: entry.Multiplier, SourceCount: entry.SourceCount, Confidence: entry.Confidence,
			})
		}
		snapshot.KeywordSpikes = spikes
	case *polymarketContext:
		leads := make([]PredictionLead, 0, len(contextValue.Leads))
		for index, entry := range contextValue.Leads {
			id := entry.ID
			if id == "" {
				id = "lead:" + jsNumberString(float64(index))
			}
			title := entry.Title
			if title == "" {
				title = "unknown"
			}
			leads = append(leads, PredictionLead{
				ID: id, Title: title, Shift: entry.Shift,
				NewsActivity: entry.NewsActivity, Confidence: entry.Confidence,
			})
		}
		snapshot.PredictionLeads = leads
	case *gdeltTensionContext:
		tensions := make([]TensionRow, 0, len(contextValue.Tensions))
		for index, entry := range contextValue.Tensions {
			id := entry.ID
			if id == "" {
				id = "tension:" + jsNumberString(float64(index))
			}
			label := entry.Label
			if label == "" {
				label = "Unknown pair"
			}
			trend := "stable"
			switch strings.ToLower(jsTrim(entry.Trend)) {
			case "rising":
				trend = "rising"
			case "falling":
				trend = "falling"
			case "stable":
				trend = "stable"
			}
			countries := make([]string, 0, len(entry.Countries))
			for _, country := range entry.Countries {
				if code := extractCountryCode(country); code != "" {
					countries = append(countries, code)
				}
			}
			updatedAt := entry.UpdatedAt
			if updatedAt == "" {
				updatedAt = fallbackTimestamp
			}
			tensions = append(tensions, TensionRow{
				ID: id, Label: label, Score: entry.Score, ChangePercent: entry.ChangePercent,
				Trend: trend, Countries: countries, UpdatedAt: updatedAt,
			})
		}
		snapshot.Tensions = tensions
	case *pizzintContext:
		snapshot.Pizzint = &PizzintInsight{
			Defcon:        contextValue.Defcon,
			AdjustedScore: contextValue.AdjustedScore,
			OpenLocations: contextValue.OpenLocations,
			ActiveSpikes:  contextValue.ActiveSpikes,
			AvgPop:        contextValue.AvgPop,
			UpdatedAt:     fallbackTimestamp,
		}
	}
}

// sourceConfig returns the enabled flag and configured interval for a source.
func sourceConfig(runtime *dataruntimesettings.RealtimeCronRuntime, source SignalSource) (bool, int) {
	switch source {
	case SourceOpensky:
		return runtime.Sources.Opensky.Enabled, runtime.Sources.Opensky.IntervalSec
	case SourceAis:
		return runtime.Sources.Ais.Enabled, runtime.Sources.Ais.IntervalSec
	case SourceUnrest:
		return runtime.Sources.Unrest.Enabled, runtime.Sources.Unrest.IntervalSec
	case SourceOutages:
		return runtime.Sources.Outages.Enabled, runtime.Sources.Outages.IntervalSec
	case SourceKeywordSpike:
		return runtime.Sources.KeywordSpike.Enabled, runtime.Sources.KeywordSpike.IntervalSec
	case SourcePizzint:
		return runtime.Sources.Pizzint.Enabled, runtime.Sources.Pizzint.IntervalSec
	case SourceGdeltTension:
		return runtime.Sources.GdeltTension.Enabled, runtime.Sources.GdeltTension.IntervalSec
	case SourcePolymarketLeads:
		return runtime.Sources.PolymarketLeads.Enabled, runtime.Sources.PolymarketLeads.IntervalSec
	default:
		return false, 0
	}
}

// fetchSource mirrors fetchSource. The four global sources, OpenSky, AIS and
// Polymarket all route through the round context; only keyword spike is
// organization-local.
func (s *Service) fetchSource(ctx context.Context, orgID string, source SignalSource, runtime *dataruntimesettings.RealtimeCronRuntime, round *roundContext) ([]FetchResult, error) {
	switch source {
	case SourceOpensky:
		return s.fetchAdsbSignal(ctx, orgID, runtime, round)
	case SourceAis:
		return s.fetchAisSignal(ctx, orgID, runtime, round)
	case SourceUnrest:
		return round.globalResults(ctx, s, SourceUnrest)
	case SourceOutages:
		return round.globalResults(ctx, s, SourceOutages)
	case SourceKeywordSpike:
		return s.fetchKeywordSpikeSignal(ctx, orgID, runtime)
	case SourcePizzint:
		return round.globalResults(ctx, s, SourcePizzint)
	case SourceGdeltTension:
		return round.globalResults(ctx, s, SourceGdeltTension)
	case SourcePolymarketLeads:
		return s.fetchPolymarketLeadsSignal(ctx, orgID, runtime, round)
	default:
		return nil, nil
	}
}

// ---- round context ----

// lazyValue memoizes one operation for the whole round. sync.Once makes
// concurrent organizations wait for the first caller, so the upstream is called
// exactly once and every organization observes the same result (or the same
// failure).
type lazyValue[T any] struct {
	once  sync.Once
	value T
	err   error
}

func (l *lazyValue[T]) do(load func() (T, error)) (T, error) {
	l.once.Do(func() {
		l.value, l.err = load()
	})
	return l.value, l.err
}

// roundContext is RealtimeSignalsSharedSourceContext plus the B1/O1 shared
// operations.
type roundContext struct {
	runtime *dataruntimesettings.RealtimeCronRuntime

	military   lazyValue[[]OpenSkyStateVector]
	unrest     lazyValue[[]FetchResult]
	outages    lazyValue[[]FetchResult]
	pizzint    lazyValue[[]FetchResult]
	gdelt      lazyValue[[]FetchResult]
	ais        lazyValue[jsonRawMessage]
	polymarket lazyValue[[]jsonRawMessage]
}

func newRoundContext(runtime *dataruntimesettings.RealtimeCronRuntime) *roundContext {
	return &roundContext{runtime: runtime}
}

func (r *roundContext) militaryStates(ctx context.Context, s *Service, runtime *dataruntimesettings.RealtimeCronRuntime, budget *budgetSummary) ([]OpenSkyStateVector, error) {
	return r.military.do(func() ([]OpenSkyStateVector, error) {
		return s.openSky.fetchConservativeMilitaryStates(ctx, runtime, budget)
	})
}

func (r *roundContext) globalResults(ctx context.Context, s *Service, source SignalSource) ([]FetchResult, error) {
	switch source {
	case SourceUnrest:
		return r.unrest.do(func() ([]FetchResult, error) { return s.fetchUnrestSignal(ctx, r.runtime) })
	case SourceOutages:
		return r.outages.do(func() ([]FetchResult, error) { return s.fetchOutagesSignal(ctx, r.runtime) })
	case SourcePizzint:
		return r.pizzint.do(func() ([]FetchResult, error) { return s.fetchPizzintSignal(ctx, r.runtime) })
	case SourceGdeltTension:
		return r.gdelt.do(func() ([]FetchResult, error) { return s.fetchGdeltTensionSignal(ctx, r.runtime) })
	default:
		return nil, nil
	}
}

func (r *roundContext) aisPayload(ctx context.Context, s *Service, runtime *dataruntimesettings.RealtimeCronRuntime, aisBase string) (jsonRawMessage, error) {
	return r.ais.do(func() (jsonRawMessage, error) {
		return s.http.fetchJSON(ctx, runtime, aisBase+"/ais/snapshot?candidates=true", fetchOptions{
			Headers: buildAisHeaders(runtime),
		})
	})
}

func (r *roundContext) polymarketEvents(ctx context.Context, s *Service, runtime *dataruntimesettings.RealtimeCronRuntime, baseURL string) ([]jsonRawMessage, error) {
	return r.polymarket.do(func() ([]jsonRawMessage, error) {
		payload, err := s.http.fetchJSON(ctx, runtime, baseURL+"/events?closed=false&limit=60", fetchOptions{})
		if err != nil {
			return nil, err
		}
		return readArray(payload), nil
	})
}

// ---- concurrency ----

// settledResult is one settledWithConcurrency result.
type settledResult[T any] struct {
	value T
	err   error
}

// settleWithConcurrency mirrors settleWithConcurrency: at most `concurrency`
// workers pull the next index, results keep the input order, and one failure does
// not stop the others.
func settleWithConcurrency[T, R any](ctx context.Context, items []T, concurrency int, worker func(context.Context, int, T) (R, error)) []settledResult[R] {
	if len(items) == 0 {
		return nil
	}
	safeConcurrency := concurrency
	if safeConcurrency < 1 {
		safeConcurrency = 1
	}
	if safeConcurrency > len(items) {
		safeConcurrency = len(items)
	}
	results := make([]settledResult[R], len(items))
	var nextIndex int64
	var waitGroup sync.WaitGroup
	for workerIndex := 0; workerIndex < safeConcurrency; workerIndex++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for {
				index := int(atomic.AddInt64(&nextIndex, 1)) - 1
				if index >= len(items) {
					return
				}
				value, err := worker(ctx, index, items[index])
				results[index] = settledResult[R]{value: value, err: err}
			}
		}()
	}
	waitGroup.Wait()
	return results
}

// sourceMetricSlug maps a source to its primary metric slug.
func sourceMetricSlug(source SignalSource) string {
	switch source {
	case SourceOpensky:
		return metricOpensky
	case SourceAis:
		return metricAis
	case SourceUnrest:
		return metricUnrest
	case SourceOutages:
		return metricOutages
	case SourceKeywordSpike:
		return metricKeywordSpike
	case SourcePizzint:
		return metricPizzint
	case SourceGdeltTension:
		return metricGdeltTension
	case SourcePolymarketLeads:
		return metricPolymarketLeads
	default:
		return ""
	}
}
