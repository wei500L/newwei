package newsnowhottest

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/classificationrssops"
	"github.com/wei500L/newwei/apps/api-go/internal/newsnowsources"
)

// Service owns the hottest-analysis cache/projection and the recommended feed.
// All dependencies are narrow ports; nil dependencies are reported as request
// errors instead of panicking, because the wiring only builds this service in
// go mode.
type Service struct {
	store     Store
	catalog   Catalog
	sources   SourceFetcher
	completer ClusterInsightCompleter
	matcher   OrgMatcher
	bridge    ItemBridge
	opinion   OpinionStore
	behavior  PersonalizationReader
	settings  UserSettingsReader
	logger    *log.Logger
	now       func() time.Time

	inflightMu       sync.Mutex
	inflightAnalysis map[string]*analysisCall
	inflightSnapshot map[string]*snapshotCall
}

// Options wires the service.
type Options struct {
	Store     Store
	Catalog   Catalog
	Sources   SourceFetcher
	Completer ClusterInsightCompleter
	Matcher   OrgMatcher
	Bridge    ItemBridge
	Opinion   OpinionStore
	Behavior  PersonalizationReader
	Settings  UserSettingsReader
	Logger    *log.Logger
	Now       func() time.Time
}

// NewService builds the service. It performs no network, database or Redis call
// at construction time.
func NewService(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	logger := options.Logger
	if logger == nil {
		logger = log.Default()
	}
	return &Service{
		store:            options.Store,
		catalog:          options.Catalog,
		sources:          options.Sources,
		completer:        options.Completer,
		matcher:          options.Matcher,
		bridge:           options.Bridge,
		opinion:          options.Opinion,
		behavior:         options.Behavior,
		settings:         options.Settings,
		logger:           logger,
		now:              now,
		inflightAnalysis: make(map[string]*analysisCall),
		inflightSnapshot: make(map[string]*snapshotCall),
	}
}

// errServiceNotConfigured is returned when the wiring omitted a required port.
var errServiceNotConfigured = errors.New("newsnowhottest: service is not configured")

type analysisCall struct {
	done  chan struct{}
	value AnalysisResponse
	err   error
}

type snapshotCall struct {
	done  chan struct{}
	value GlobalSnapshot
	err   error
}

// analysisInput is the getHottestAnalysis argument.
type analysisInput struct {
	OrgID           string
	UserID          string
	ForceRefresh    bool
	AllowAutoBridge bool
	globalSnapshot  *GlobalSnapshot
}

// sourceFetchResult is one source fetch attempt. response is nil on failure and
// errorMessage carries the NestJS error.message value.
type sourceFetchResult struct {
	response     *newsnowsources.SourceResponse
	source       *SourceDescriptor
	sourceID     string
	errorMessage string
}

// hottestMetadataContext is getHottestMetadataContext.
type hottestMetadataContext struct {
	hottestSourceIDs         []string
	sourcesByID              map[string]SourceDescriptor
	totalDomesticSourceCount int
}

// GetHottestAnalysis ports getHottestAnalysis, including the fresh-cache fast
// path, the per-organization in-flight merge and the stale fallbacks.
func (s *Service) GetHottestAnalysis(ctx context.Context, input analysisInput) (AnalysisResponse, error) {
	if s == nil || s.store == nil || s.catalog == nil || s.sources == nil {
		return AnalysisResponse{}, errors.New("newsnowhottest: service is not configured")
	}
	freshKey := buildAnalysisCacheKey(input.OrgID)
	staleKey := buildAnalysisStaleCacheKey(input.OrgID)

	if !input.ForceRefresh {
		if cached := s.safeGetAnalysis(ctx, freshKey); cached != nil {
			cached.Cached = true
			return s.normalizeAnalysis(*cached), nil
		}
	}

	return s.runAnalysisInflight(freshKey, func() (AnalysisResponse, error) {
		return s.refreshAnalysisWithLock(ctx, input, freshKey, staleKey)
	})
}

// RefreshProjectionForOrg is the scheduler entry: force a rebuild for one
// organization, optionally reusing the tick's global snapshot, without
// auto-bridging.
func (s *Service) RefreshProjectionForOrg(ctx context.Context, orgID string, snapshot *GlobalSnapshot) (AnalysisResponse, error) {
	if s == nil || s.store == nil || s.catalog == nil || s.sources == nil {
		return AnalysisResponse{}, errors.New("newsnowhottest: service is not configured")
	}
	freshKey := buildAnalysisCacheKey(orgID)
	staleKey := buildAnalysisStaleCacheKey(orgID)
	return s.runAnalysisInflight(freshKey, func() (AnalysisResponse, error) {
		return s.refreshAnalysisWithLock(ctx, analysisInput{
			OrgID:          orgID,
			ForceRefresh:   true,
			globalSnapshot: snapshot,
		}, freshKey, staleKey)
	})
}

// runAnalysisInflight merges concurrent refreshes of the same organization key,
// like inflightRefreshes in the NestJS service. Every waiter receives the same
// value or error.
func (s *Service) runAnalysisInflight(key string, factory func() (AnalysisResponse, error)) (AnalysisResponse, error) {
	s.inflightMu.Lock()
	if call, exists := s.inflightAnalysis[key]; exists {
		s.inflightMu.Unlock()
		<-call.done
		return call.value, call.err
	}
	call := &analysisCall{done: make(chan struct{})}
	s.inflightAnalysis[key] = call
	s.inflightMu.Unlock()

	call.value, call.err = factory()

	s.inflightMu.Lock()
	delete(s.inflightAnalysis, key)
	s.inflightMu.Unlock()
	close(call.done)
	return call.value, call.err
}

// runSnapshotInflight merges concurrent rebuilds of the same input signature.
func (s *Service) runSnapshotInflight(signature string, factory func() (GlobalSnapshot, error)) (GlobalSnapshot, error) {
	s.inflightMu.Lock()
	if call, exists := s.inflightSnapshot[signature]; exists {
		s.inflightMu.Unlock()
		<-call.done
		return call.value, call.err
	}
	call := &snapshotCall{done: make(chan struct{})}
	s.inflightSnapshot[signature] = call
	s.inflightMu.Unlock()

	call.value, call.err = factory()

	s.inflightMu.Lock()
	delete(s.inflightSnapshot, signature)
	s.inflightMu.Unlock()
	close(call.done)
	return call.value, call.err
}

// refreshAnalysisWithLock ports refreshAnalysisWithLock: take the lease, rebuild
// and write both caches; on contention read fresh, then stale, then wait; on any
// failure fall back to the stale document.
func (s *Service) refreshAnalysisWithLock(ctx context.Context, input analysisInput, freshKey, staleKey string) (AnalysisResponse, error) {
	refresh := func() (AnalysisResponse, error) {
		snapshot := input.globalSnapshot
		if snapshot == nil {
			built, err := s.EnsureGlobalSnapshot(ctx, input.OrgID)
			if err != nil {
				return AnalysisResponse{}, err
			}
			snapshot = built
		}
		next, err := s.buildAnalysisFromGlobalSnapshot(ctx, input.OrgID, input.UserID, input.AllowAutoBridge, *snapshot)
		if err != nil {
			return AnalysisResponse{}, err
		}
		s.setAnalysisCaches(ctx, freshKey, staleKey, next)
		return next, nil
	}

	lease, err := acquireLock(ctx, s.store, freshKey+":refresh", analysisLockTTLMillis)
	if err != nil {
		return s.staleAnalysisFallback(ctx, staleKey, err)
	}
	if lease != nil {
		stopRenew := lease.startAutoRenew()
		value, runErr := refresh()
		stopRenew()
		lease.release()
		if runErr != nil {
			return s.staleAnalysisFallback(ctx, staleKey, runErr)
		}
		return value, nil
	}

	if !input.ForceRefresh {
		if cached := s.safeGetAnalysis(ctx, freshKey); cached != nil {
			cached.Cached = true
			return s.normalizeAnalysis(*cached), nil
		}
	}
	stale := s.safeGetAnalysis(ctx, staleKey)
	if stale != nil && !input.ForceRefresh {
		stale.Cached = true
		return s.normalizeAnalysis(*stale), nil
	}
	if waited := s.waitForReadyAnalysis(ctx, freshKey, staleKey, !input.ForceRefresh); waited != nil {
		waited.Cached = true
		return s.normalizeAnalysis(*waited), nil
	}
	if stale != nil {
		stale.Cached = true
		return s.normalizeAnalysis(*stale), nil
	}
	return s.staleAnalysisFallback(ctx, staleKey,
		errors.New("Timed out waiting for in-flight hottest analysis refresh"))
}

// staleAnalysisFallback serves the stale document after a failure, exactly like
// the NestJS catch block.
func (s *Service) staleAnalysisFallback(ctx context.Context, staleKey string, cause error) (AnalysisResponse, error) {
	if stale := s.safeGetAnalysis(ctx, staleKey); stale != nil {
		s.logf("newsnowhottest: serving stale analysis after refresh failure err=%v", cause)
		stale.Cached = true
		return s.normalizeAnalysis(*stale), nil
	}
	return AnalysisResponse{}, cause
}

// EnsureGlobalSnapshot ports ensureGlobalSnapshot: fetch the hottest sources,
// compute the input signature, reuse a matching fresh/stale snapshot, otherwise
// rebuild under the signature lease.
func (s *Service) EnsureGlobalSnapshot(ctx context.Context, orgID string) (*GlobalSnapshot, error) {
	if s == nil || s.store == nil || s.catalog == nil || s.sources == nil {
		return nil, errors.New("newsnowhottest: service is not configured")
	}
	metadata := s.getHottestMetadataContext()
	fetches := s.fetchHottestSources(ctx, metadata.hottestSourceIDs, metadata.sourcesByID)
	signature := buildCurrentGlobalSignature(fetches)

	freshKey := buildGlobalSnapshotCacheKey()
	staleKey := buildGlobalSnapshotStaleCacheKey()
	signatureKey := buildGlobalSignatureCacheKey()

	values, found, err := s.store.MGet(ctx, []string{freshKey, staleKey, signatureKey})
	if err != nil {
		s.logf("newsnowhottest: global snapshot cache read failed err=%v", err)
	}
	var fresh, stale *GlobalSnapshot
	cachedSignature := ""
	if err == nil && len(values) == 3 {
		if found[0] {
			var decoded GlobalSnapshot
			if decodeErr := json.Unmarshal([]byte(values[0]), &decoded); decodeErr == nil {
				fresh = &decoded
			}
		}
		if found[1] {
			var decoded GlobalSnapshot
			if decodeErr := json.Unmarshal([]byte(values[1]), &decoded); decodeErr == nil {
				stale = &decoded
			}
		}
		if found[2] {
			cachedSignature = decodeJSONString(values[2])
		}
	}

	if fresh != nil && fresh.Signature == signature {
		return fresh, nil
	}
	if cachedSignature == signature && stale != nil && stale.Signature == signature {
		return stale, nil
	}

	snapshot, err := s.runSnapshotInflight(signature, func() (GlobalSnapshot, error) {
		return s.refreshGlobalSnapshotWithLock(ctx, orgID, metadata, fetches, signature, freshKey, staleKey, signatureKey)
	})
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// refreshGlobalSnapshotWithLock ports refreshGlobalSnapshotWithLock.
func (s *Service) refreshGlobalSnapshotWithLock(
	ctx context.Context,
	orgID string,
	metadata hottestMetadataContext,
	fetches []sourceFetchResult,
	signature string,
	freshKey, staleKey, signatureKey string,
) (GlobalSnapshot, error) {
	refresh := func() (GlobalSnapshot, error) {
		next, err := s.buildGlobalSnapshot(ctx, orgID, metadata, fetches, signature)
		if err != nil {
			return GlobalSnapshot{}, err
		}
		s.setGlobalSnapshotCaches(ctx, freshKey, staleKey, signatureKey, next)
		return next, nil
	}

	lease, err := acquireLock(ctx, s.store, freshKey+":refresh", globalSnapshotLockTTLMillis)
	if err != nil {
		return s.staleSnapshotFallback(ctx, staleKey, err)
	}
	if lease != nil {
		stopRenew := lease.startAutoRenew()
		value, runErr := refresh()
		stopRenew()
		lease.release()
		if runErr != nil {
			return s.staleSnapshotFallback(ctx, staleKey, runErr)
		}
		return value, nil
	}

	if fresh := s.safeGetSnapshot(ctx, freshKey); fresh != nil && fresh.Signature == signature {
		return *fresh, nil
	}
	if waited := s.waitForReadyGlobalSnapshot(ctx, freshKey, staleKey, signature); waited != nil {
		return *waited, nil
	}
	if stale := s.safeGetSnapshot(ctx, staleKey); stale != nil {
		return *stale, nil
	}
	return s.staleSnapshotFallback(ctx, staleKey,
		errors.New("Timed out waiting for in-flight hottest global snapshot refresh"))
}

// staleSnapshotFallback serves the stale snapshot after a failure.
func (s *Service) staleSnapshotFallback(ctx context.Context, staleKey string, cause error) (GlobalSnapshot, error) {
	if stale := s.safeGetSnapshot(ctx, staleKey); stale != nil {
		s.logf("newsnowhottest: serving stale global snapshot after refresh failure err=%v", cause)
		return *stale, nil
	}
	return GlobalSnapshot{}, cause
}

// buildGlobalSnapshot ports buildGlobalSnapshot: seeds, heuristic clusters, the
// model labels of the first sixteen clusters and the diagnostics.
func (s *Service) buildGlobalSnapshot(
	ctx context.Context,
	orgID string,
	metadata hottestMetadataContext,
	fetches []sourceFetchResult,
	signature string,
) (GlobalSnapshot, error) {
	generatedAt := s.now()
	signalSeeds := s.buildSignalSeeds(fetches)
	globalMaxHeatValue := 0.0
	for _, seed := range signalSeeds {
		if heat := seed.HeatValue.OrZero(); heat > globalMaxHeatValue {
			globalMaxHeatValue = heat
		}
	}
	clusters := buildHeuristicClusters(signalSeeds)
	insights := s.generateClusterInsights(ctx, orgID, firstN(clusters, maxLLMClusters), signalSeeds)
	errorsOut := make([]SourceError, 0, len(fetches))
	for _, fetch := range fetches {
		if fetch.errorMessage == "" {
			continue
		}
		errorsOut = append(errorsOut, SourceError{SourceID: fetch.sourceID, Message: fetch.errorMessage})
	}
	return GlobalSnapshot{
		Signature:                signature,
		GeneratedAt:              isoTime(generatedAt),
		Diagnostics:              buildDiagnostics(fetches),
		Errors:                   errorsOut,
		TotalDomesticSourceCount: metadata.totalDomesticSourceCount,
		GlobalMaxHeatValue:       globalMaxHeatValue,
		SignalSeeds:              signalSeeds,
		Clusters:                 clusters,
		ClusterInsights:          insights,
	}, nil
}

// fetchHottestSources fetches every hottest source with concurrency six,
// preserving the registry order. A source failure is recorded, never fatal.
func (s *Service) fetchHottestSources(ctx context.Context, sourceIDs []string, sourcesByID map[string]SourceDescriptor) []sourceFetchResult {
	results := make([]sourceFetchResult, len(sourceIDs))
	mapWithConcurrency(sourceIDs, sourceFetchConcurrency, func(index int, sourceID string) {
		source, ok := sourcesByID[sourceID]
		response, err := s.sources.FetchSource(ctx, sourceID, false)
		result := sourceFetchResult{sourceID: sourceID}
		if ok {
			copied := source
			result.source = &copied
		}
		if err != nil {
			result.errorMessage = err.Error()
		} else {
			copied := response
			result.response = &copied
		}
		results[index] = result
	})
	return results
}

// buildSignalSeeds ports buildSignalSeeds: at most eight items per source and
// 160 items overall, skipping entries without a title or URL.
func (s *Service) buildSignalSeeds(fetches []sourceFetchResult) []SignalSeed {
	seeds := make([]SignalSeed, 0, maxTotalItems)
	for _, fetch := range fetches {
		if fetch.response == nil {
			continue
		}
		sourceName := fetch.sourceID
		if fetch.source != nil {
			sourceName = fetch.source.Name
		}
		sourceHome := ""
		if fetch.source != nil {
			sourceHome = fetch.source.Home
		}
		for index, item := range firstN(fetch.response.Items, maxItemsPerSource) {
			if len(seeds) >= maxTotalItems {
				break
			}
			seed, ok := s.toSignalSeed(fetch.sourceID, sourceName, sourceHome, *fetch.response, item, index+1)
			if !ok {
				continue
			}
			seeds = append(seeds, seed)
		}
		if len(seeds) >= maxTotalItems {
			break
		}
	}
	return seeds
}

// toSignalSeed ports toSignalSeed.
func (s *Service) toSignalSeed(
	sourceID, sourceName, sourceHome string,
	response newsnowsources.SourceResponse,
	item newsnowsources.NewsItem,
	rank int,
) (SignalSeed, bool) {
	url := jsTrim(item.URL)
	title := jsTrim(item.Title)
	if url == "" || title == "" {
		return SignalSeed{}, false
	}
	authorityURL := url
	if sourceHome != "" {
		authorityURL = sourceHome
	}
	authorityType := classificationrssops.ClassifyDefaultSourceAuthority(sourceName, authorityURL)
	authority := 0.55
	switch authorityType {
	case classificationrssops.ClassifiedSourceAuthoritative:
		authority = 1
	case classificationrssops.ClassifiedSourceBlog:
		authority = 0.22
	}
	hoverSummary := nullableString{}
	heatText := nullableString{}
	if item.Extra != nil && item.Extra.Hover != nil {
		if trimmed := jsTrim(*item.Extra.Hover); trimmed != "" {
			hoverSummary = stringOrNull(trimmed)
		}
	}
	if item.Extra != nil && item.Extra.Info != nil && item.Extra.Info.Kind == newsnowsources.ValueString {
		if trimmed := jsTrim(item.Extra.Info.Text); trimmed != "" {
			heatText = stringOrNull(trimmed)
		}
	}
	heatValue := nullableNumber{}
	if heatText.Valid {
		if parsed := parseHeatValue(heatText.Ptr()); parsed != nil {
			heatValue = numberOrNull(*parsed)
		}
	}
	mobileURL := nullableString{}
	if item.MobileURL != nil {
		if trimmed := jsTrim(*item.MobileURL); trimmed != "" {
			mobileURL = stringOrNull(trimmed)
		}
	}
	sourceUpdatedTime := nullableString{}
	if converted := toISODateTime(response.UpdatedTime); converted != nil {
		sourceUpdatedTime = stringOrNull(*converted)
	}
	seed := SignalSeed{
		SignalKey:         buildSignalKey(sourceID, title, url),
		SourceID:          sourceID,
		SourceName:        sourceName,
		SourceHome:        stringOrNullIf(sourceHome != "", sourceHome),
		SourceUpdatedTime: sourceUpdatedTime,
		ItemID:            item.ID.String(),
		Title:             title,
		URL:               url,
		MobileURL:         mobileURL,
		HoverSummary:      hoverSummary,
		HeatText:          heatText,
		HeatValue:         heatValue,
		Rank:              rank,
		NormalizedTitle:   normalizeTitle(title),
		Authority:         authority,
	}
	return seed, true
}

// buildSignalsFromSeeds ports buildSignalsFromSeeds: one MGET of the signal
// states, then the freshness computation.
func (s *Service) buildSignalsFromSeeds(ctx context.Context, orgID string, seeds []SignalSeed, capturedAt time.Time) []Signal {
	keys := make([]string, len(seeds))
	for index, seed := range seeds {
		keys[index] = buildStateKey(orgID, seed.SignalKey)
	}
	states := s.safeGetStates(ctx, keys)
	signals := make([]Signal, len(seeds))
	for index, seed := range seeds {
		var state *SignalState
		if index < len(states) {
			state = states[index]
		}
		freshnessScore, isNew, isRising := computeFreshness(capturedAt.UnixMilli(), state, seed.Rank)
		signals[index] = Signal{
			SignalSeed:     seed,
			CapturedAt:     isoTime(capturedAt),
			State:          state,
			IsNew:          isNew,
			IsRising:       isRising,
			FreshnessScore: freshnessScore,
		}
	}
	return signals
}

// buildCurrentGlobalSignature ports buildCurrentGlobalSignature: only the first
// eight items of each source, with the rank being the item's position.
func buildCurrentGlobalSignature(fetches []sourceFetchResult) string {
	entries := make([]SignatureEntry, 0, len(fetches))
	for _, fetch := range fetches {
		items := make([]SignatureItem, 0, maxItemsPerSource)
		if fetch.response != nil {
			for index, item := range firstN(fetch.response.Items, maxItemsPerSource) {
				heatText := ""
				if item.Extra != nil && item.Extra.Info != nil && item.Extra.Info.Kind == newsnowsources.ValueString {
					heatText = jsTrim(item.Extra.Info.Text)
				}
				entry := SignatureItem{
					ID:   item.ID.String(),
					Rank: index + 1,
				}
				entry.Title = item.Title
				entry.URL = item.URL
				if heatText != "" {
					entry.HeatText = &heatText
				}
				items = append(items, entry)
			}
		}
		entries = append(entries, SignatureEntry{
			SourceID: fetch.sourceID,
			Failed:   fetch.response == nil,
			Items:    items,
		})
	}
	return buildGlobalInputSignature(entries)
}

// buildDiagnostics ports buildDiagnostics.
func buildDiagnostics(fetches []sourceFetchResult) Diagnostics {
	diagnostics := Diagnostics{SourcesRequested: len(fetches)}
	for _, fetch := range fetches {
		if fetch.response != nil {
			diagnostics.SourcesSucceeded++
			diagnostics.SourceItemsFetched += len(fetch.response.Items)
		}
		if fetch.errorMessage != "" {
			diagnostics.SourcesFailed++
		}
	}
	return diagnostics
}

// getHottestMetadataContext ports getHottestMetadataContext: the hottest source
// ids capped at 64, their descriptors and the domestic subset count.
func (s *Service) getHottestMetadataContext() hottestMetadataContext {
	hottestSourceIDs := firstN(s.catalog.HottestSourceIDs(), 64)
	sourcesByID := make(map[string]SourceDescriptor, len(hottestSourceIDs))
	totalDomestic := 0
	for _, sourceID := range hottestSourceIDs {
		source, ok := s.catalog.Source(sourceID)
		if !ok {
			continue
		}
		sourcesByID[sourceID] = source
		if source.Column == "china" {
			totalDomestic++
		}
	}
	return hottestMetadataContext{
		hottestSourceIDs:         hottestSourceIDs,
		sourcesByID:              sourcesByID,
		totalDomesticSourceCount: totalDomestic,
	}
}

// mapWithConcurrency runs worker for every value with a bounded number of
// in-flight calls, preserving the input order through the caller's index.
func mapWithConcurrency[T any](values []T, concurrency int, worker func(index int, value T)) {
	if len(values) == 0 {
		return
	}
	workers := concurrency
	if workers < 1 {
		workers = 1
	}
	if workers > len(values) {
		workers = len(values)
	}
	var wait sync.WaitGroup
	next := make(chan int)
	wait.Add(workers)
	for index := 0; index < workers; index++ {
		go func() {
			defer wait.Done()
			for itemIndex := range next {
				worker(itemIndex, values[itemIndex])
			}
		}()
	}
	for index := range values {
		next <- index
	}
	close(next)
	wait.Wait()
}

// toISODateTime ports toIsoDateTime for the source updatedTime shapes.
func toISODateTime(value newsnowsources.DateValue) *string {
	switch value.Kind {
	case newsnowsources.ValueNumber:
		number, ok := value.Number()
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
			return nil
		}
		millis := int64(number)
		formatted := isoTime(time.UnixMilli(millis))
		return &formatted
	case newsnowsources.ValueString:
		text, _ := value.StringValue()
		trimmed := jsTrim(text)
		if trimmed == "" {
			return nil
		}
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
			if parsed, err := time.Parse(layout, trimmed); err == nil {
				formatted := isoTime(parsed)
				return &formatted
			}
		}
		return nil
	default:
		return nil
	}
}

// stringOrNullIf builds a present nullable string only when the flag is true.
func stringOrNullIf(present bool, value string) nullableString {
	if !present {
		return nullableString{}
	}
	return stringOrNull(value)
}
