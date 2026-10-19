package newsnowsources

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"regexp"
	"sync"
	"time"
)

// Compatible Redis keys. The prefix and suffixes are identical to the NestJS
// constants so the warm scheduler, recommendations and the hottest-analysis
// path keep reading what Go writes (and vice versa).
const (
	cachePrefix = "news-aggregator"
	// maxItems is MAX_ITEMS: the normalisation cap.
	maxItems = 50
	// batchLimit is BATCH_LIMIT: the service-side dedupe/truncate cap.
	batchLimit = 100
	// batchConcurrency is the number of concurrent fetchSource calls.
	batchConcurrency = 10
	// staleTTLSeconds is STALE_TTL (24 hours).
	staleTTLSeconds = 24 * 60 * 60
	// refreshLockTTL is REFRESH_LOCK_TTL_MS.
	refreshLockTTL = 45 * time.Second
	// lockPollInterval and lockPollMaxWait mirror the NestJS contention loop.
	lockPollInterval = 200 * time.Millisecond
	lockPollMaxWait  = refreshLockTTL
	// freebufEmptyCacheRetry is FREEBUF_EMPTY_CACHE_RETRY_MS.
	freebufEmptyCacheRetry = 2 * time.Minute
	// defaultInterval is Time.Default and the fallback for a missing interval.
	defaultInterval = 10 * 60 * 1000
	staleKeySuffix  = ":stale"
)

// SourceMeta is the narrow metadata projection the service needs.
type SourceMeta struct {
	ID       string
	Redirect string
	Interval int
}

// SourceRegistry is the read-only source registry port.
type SourceRegistry interface {
	Lookup(sourceID string) (SourceMeta, bool)
}

// RuntimeSecrets resolves the merged runtime secrets for a requested and a
// resolved source id.
type RuntimeSecrets interface {
	SecretsForSource(ctx context.Context, sourceID, overrideSourceID string) map[string]string
}

// ServiceConfig wires the shared resources. Every field is required except Now
// and Env, which default to time.Now and os.Getenv.
type ServiceConfig struct {
	Registry SourceRegistry
	Secrets  RuntimeSecrets
	Store    Store
	Now      func() time.Time
	Env      func(string) string
}

// Service implements both source endpoints.
type Service struct {
	registry     SourceRegistry
	secrets      RuntimeSecrets
	store        Store
	client       *fetchClient
	now          func() time.Time
	env          func(string) string
	getters      map[string]Getter
	pollInterval time.Duration
	pollMaxWait  time.Duration
}

// NewService builds the service. It performs no network, database or Redis call
// at construction time.
func NewService(cfg ServiceConfig) *Service {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	env := cfg.Env
	if env == nil {
		env = func(string) string { return "" }
	}
	service := &Service{
		registry:     cfg.Registry,
		secrets:      cfg.Secrets,
		store:        cfg.Store,
		client:       newFetchClient(),
		now:          now,
		env:          env,
		pollInterval: lockPollInterval,
		pollMaxWait:  lockPollMaxWait,
	}
	service.getters = service.buildGetters()
	return service
}

// CloseIdleConnections releases pooled upstream connections at shutdown.
func (s *Service) CloseIdleConnections() {
	if s != nil && s.client != nil {
		s.client.closeIdleConnections()
	}
}

// FetchSource mirrors NewsAggregatorService.fetchSource: resolve the alias,
// require a getter, serve a fresh cache hit unless forced, otherwise refresh
// under the physical lock with polled fresh, then stale, fallback.
func (s *Service) FetchSource(ctx context.Context, sourceID string, forceRefresh bool) (SourceResponse, error) {
	meta, ok := s.registry.Lookup(sourceID)
	if !ok {
		return SourceResponse{}, UnknownSourceError(sourceID)
	}
	resolvedID := s.resolveSourceID(sourceID)
	getter, ok := s.getters[resolvedID]
	if !ok {
		return SourceResponse{}, MissingGetterError(resolvedID)
	}

	freshKey := buildFreshKey(sourceID)
	staleKey := buildStaleKey(sourceID)
	skipEmptyCache := sourceID == "freebuf"

	if !forceRefresh {
		if cached := s.safeGetCache(ctx, freshKey); cached != nil {
			if skipEmptyCache && shouldRetryAfterEmptyCache(*cached, s.now()) {
				log.Printf("newsnowsources: empty cache ignored for %q, forcing refresh", sourceID)
			} else {
				cached.Status = StatusCache
				cached.ID = sourceID
				cached.EnsureItemsArray()
				return *cached, nil
			}
		}
	}

	refresh := func() (SourceResponse, error) {
		return s.refresh(ctx, meta, resolvedID, sourceID, getter, freshKey, staleKey)
	}

	lock, err := s.acquireRefreshLock(ctx, freshKey)
	if err != nil {
		return SourceResponse{}, FetchFailedAPIError(sourceID, err)
	}
	if lock != nil {
		renewStop := lock.startAutoRenew()
		response, refreshErr := refresh()
		renewStop()
		lock.release()
		if refreshErr != nil {
			return SourceResponse{}, refreshErr
		}
		return response, nil
	}

	// Lock not acquired: poll the fresh key for up to 45 seconds.
	if polled := s.pollForCache(ctx, freshKey); polled != nil {
		if skipEmptyCache && shouldRetryAfterEmptyCache(*polled, s.now()) {
			log.Printf("newsnowsources: empty polled cache ignored for %q, retrying refresh path", sourceID)
		} else {
			polled.Status = StatusCache
			polled.ID = sourceID
			polled.EnsureItemsArray()
			return *polled, nil
		}
	}

	// Stale fallback before a redundant refresh.
	if stale := s.safeGetCache(ctx, staleKey); stale != nil {
		if skipEmptyCache && shouldRetryAfterEmptyCache(*stale, s.now()) {
			log.Printf("newsnowsources: empty stale cache ignored for %q, forcing refresh", sourceID)
		} else {
			log.Printf("newsnowsources: lock contention for %q, serving stale data", sourceID)
			stale.Status = StatusCache
			stale.ID = sourceID
			stale.EnsureItemsArray()
			return *stale, nil
		}
	}

	return refresh()
}

// refresh performs the cold fetch and cache write. A cache write failure fails
// the request; the realtime relay failure only logs.
func (s *Service) refresh(
	ctx context.Context,
	meta SourceMeta,
	resolvedID string,
	requestedID string,
	getter Getter,
	freshKey string,
	staleKey string,
) (SourceResponse, error) {
	previous := s.safeGetCache(ctx, freshKey)
	secrets := s.secrets.SecretsForSource(ctx, requestedID, resolvedID)
	rawItems, err := getter(ctx, RuntimeContext{
		SourceID:          resolvedID,
		RequestedSourceID: requestedID,
		Secrets:           secrets,
	})
	if err != nil {
		return SourceResponse{}, s.mapProviderError(requestedID, err)
	}

	response := SourceResponse{
		Status:      StatusSuccess,
		ID:          requestedID,
		UpdatedTime: Millis(millisOf(s.now())),
		Items:       normalizeItems(rawItems),
	}
	response.EnsureItemsArray()

	interval := meta.Interval
	if interval <= 0 {
		interval = defaultInterval
	}
	freshTTL := interval / 1000
	if freshTTL < 1 {
		freshTTL = 1
	}

	if err := s.writeBothCaches(ctx, freshKey, staleKey, response, freshTTL); err != nil {
		return SourceResponse{}, FetchFailedAPIError(requestedID, err)
	}

	s.publishRefresh(ctx, requestedID, interval, previous, response)
	return response, nil
}

// mapProviderError converts a provider failure into the HTTP contract.
func (s *Service) mapProviderError(sourceID string, err error) *APIError {
	var secretErr *SecretRequiredError
	if errors.As(err, &secretErr) {
		return RuntimeSecretAPIError(sourceID, secretErr.RequiredKeys)
	}
	return FetchFailedAPIError(sourceID, err)
}

// writeBothCaches writes fresh and stale concurrently and requires both writes.
func (s *Service) writeBothCaches(ctx context.Context, freshKey, staleKey string, response SourceResponse, freshTTL int64) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	var wait sync.WaitGroup
	errs := make([]error, 2)
	wait.Add(2)
	go func() {
		defer wait.Done()
		errs[0] = s.cacheSet(ctx, freshKey, payload, freshTTL)
	}()
	go func() {
		defer wait.Done()
		errs[1] = s.cacheSet(ctx, staleKey, payload, staleTTLSeconds)
	}()
	wait.Wait()
	for _, writeErr := range errs {
		if writeErr != nil {
			return writeErr
		}
	}
	return nil
}

// resolveSourceID follows redirects. A cycle returns the originally requested
// id, exactly like the NestJS implementation.
func (s *Service) resolveSourceID(sourceID string) string {
	visited := make(map[string]struct{}, 4)
	current := sourceID
	for {
		if _, seen := visited[current]; seen {
			log.Printf("newsnowsources: redirect cycle detected for %q", sourceID)
			return sourceID
		}
		visited[current] = struct{}{}
		meta, ok := s.registry.Lookup(current)
		if !ok || meta.Redirect == "" {
			return current
		}
		current = meta.Redirect
	}
}

// FetchBatch mirrors fetchBatch with a continuous worker pool: at most ten
// fetchSource calls run, each completion claims the next input index, and the
// output keeps the input order separately for successes and errors.
func (s *Service) FetchBatch(ctx context.Context, ids []string, forceRefresh bool) BatchResponse {
	unique := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	if len(unique) > batchLimit {
		unique = unique[:batchLimit]
	}

	results := make([]SourceResponse, len(unique))
	errs := make([]error, len(unique))
	jobs := make(chan int)
	var wait sync.WaitGroup
	workers := batchConcurrency
	if len(unique) < workers {
		workers = len(unique)
	}
	wait.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer wait.Done()
			for index := range jobs {
				item, err := s.FetchSource(ctx, unique[index], forceRefresh)
				results[index] = item
				errs[index] = err
			}
		}()
	}
	for index := range unique {
		jobs <- index
	}
	close(jobs)
	wait.Wait()

	response := BatchResponse{
		Requested: len(ids),
		Processed: len(unique),
		Results:   make([]SourceResponse, 0, len(unique)),
		Errors:    make([]BatchError, 0),
	}
	for index, id := range unique {
		if errs[index] != nil {
			response.Errors = append(response.Errors, BatchError{ID: id, Message: errs[index].Error()})
			continue
		}
		response.Results = append(response.Results, results[index])
	}
	return response
}

// BatchError is one failed batch member.
type BatchError struct {
	ID      string `json:"id"`
	Message string `json:"message"`
}

// BatchResponse is the POST /sources/batch payload.
type BatchResponse struct {
	Requested int              `json:"requested"`
	Processed int              `json:"processed"`
	Results   []SourceResponse `json:"results"`
	Errors    []BatchError     `json:"errors"`
}

// buildFreshKey mirrors buildCacheKey.
func buildFreshKey(sourceID string) string { return cachePrefix + ":source:" + sourceID }

// buildStaleKey mirrors buildStaleKey.
func buildStaleKey(sourceID string) string { return buildFreshKey(sourceID) + staleKeySuffix }

// safeGetCache mirrors safeGetCache: read/decode failures are a cache miss with
// a warning, never a request failure.
func (s *Service) safeGetCache(ctx context.Context, key string) *SourceResponse {
	if s.store == nil {
		return nil
	}
	value, found, err := s.store.Get(ctx, key)
	if err != nil {
		log.Printf("newsnowsources: cache read failed for %q: %v", key, err)
		return nil
	}
	if !found {
		return nil
	}
	response := &SourceResponse{}
	if decodeErr := json.Unmarshal([]byte(value), response); decodeErr != nil {
		log.Printf("newsnowsources: cache decode failed for %q: %v", key, decodeErr)
		return nil
	}
	return response
}

// cacheSet stores one compatible JSON document.
func (s *Service) cacheSet(ctx context.Context, key string, payload []byte, ttlSeconds int64) error {
	return s.store.Set(ctx, key, string(payload), time.Duration(ttlSeconds)*time.Second)
}

// pollForCache mirrors pollForCache: sleep first, then read fresh, for at most
// 45 seconds.
func (s *Service) pollForCache(ctx context.Context, key string) *SourceResponse {
	deadline := s.now().Add(s.pollMaxWait)
	for s.now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(s.pollInterval):
		}
		if cached := s.safeGetCache(ctx, key); cached != nil {
			return cached
		}
	}
	return nil
}

// shouldRetryAfterEmptyCache mirrors the Freebuf-only empty-cache rule.
func shouldRetryAfterEmptyCache(response SourceResponse, now time.Time) bool {
	if len(response.Items) > 0 {
		return false
	}
	updated, ok := response.UpdatedTime.Number()
	if !ok {
		return true
	}
	return millisOf(now)-int64(updated) >= freebufEmptyCacheRetry.Milliseconds()
}

// normalizeItems mirrors normalizeItems: only nullish ids, empty/non-string
// titles, empty/non-string URLs and non-http(s) URLs are removed. Order is
// preserved and the list is capped at 50.
func normalizeItems(items []NewsItem) []NewsItem {
	out := make([]NewsItem, 0, len(items))
	for _, item := range items {
		if item.ID.Kind == ValueAbsent || item.ID.Kind == ValueNull {
			continue
		}
		if item.Title == "" || item.URL == "" {
			continue
		}
		if !httpURLPattern.MatchString(item.URL) {
			continue
		}
		out = append(out, item)
		if len(out) >= maxItems {
			break
		}
	}
	return out
}

// httpURLPattern mirrors /^https?:\/\//i.
var httpURLPattern = regexp.MustCompile(`(?i)^https?://`)
