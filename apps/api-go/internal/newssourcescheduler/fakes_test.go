package newssourcescheduler

import (
	"context"
	"encoding/json"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

// This file holds the in-memory ports the unit tests drive the scheduler
// through. They implement the same interfaces the production wiring uses, so a
// dispatch-branch test exercises the real dispatchSource code, not a copy.

type fakeRepo struct {
	sources map[string]*source

	inFlight []inFlightJob

	persistFn    func(dispatchPersist) (dispatchPersistResult, error)
	persistCalls []dispatchPersist

	rssFn    func(rssSeedPersist) (string, error)
	rssCalls []rssSeedPersist

	articleByFingerprint []fingerprintRecord
	articleByURL         []fingerprintRecord
	activeByFingerprint  []fingerprintRecord
	activeByURL          []fingerprintRecord

	pipelineFailed     map[string]string
	taskQueued         []string
	taskFailed         map[string]string
	sourceRunUpdates   int
	manualUpdates      int
	manualRunUpdates   int
	rescheduleIfDue    int
	deepFailureUpdates int

	latestJob  *pipelineJobRecord
	taskStatus map[string]string

	notifications []notificationInsert

	syncQueueCalls int
	refreshCalls   int
	upsertCalls    int
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		sources:        map[string]*source{},
		pipelineFailed: map[string]string{},
		taskFailed:     map[string]string{},
		taskStatus:     map[string]string{},
	}
}

func (r *fakeRepo) LoadSource(_ context.Context, id string) (*source, error) {
	return r.sources[id], nil
}

func (r *fakeRepo) FindDueSources(_ context.Context, _ time.Time, limit int) ([]*source, error) {
	out := make([]*source, 0, len(r.sources))
	for _, item := range r.sources {
		out = append(out, item)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (r *fakeRepo) DelaySources(_ context.Context, ids []string, _, _ time.Time) (int, error) {
	return len(ids), nil
}

func (r *fakeRepo) UpdateSourceRun(_ context.Context, _ string, _, _ time.Time, _ bool) error {
	r.sourceRunUpdates++
	return nil
}

func (r *fakeRepo) UpdateSourceManual(_ context.Context, _, _ string, _ time.Time) error {
	r.manualUpdates++
	return nil
}

func (r *fakeRepo) UpdateSourceManualRun(_ context.Context, _, _ string, _, _ time.Time) error {
	r.manualRunUpdates++
	return nil
}

func (r *fakeRepo) RescheduleSourceIfDue(_ context.Context, _ string, _, _ time.Time) error {
	r.rescheduleIfDue++
	return nil
}

func (r *fakeRepo) ResolveCrawlActor(_ context.Context, _ string) (*string, error) {
	actor := "user-1"
	return &actor, nil
}

func (r *fakeRepo) FindInFlightJobs(_ context.Context, _ string, _ time.Time, limit int) ([]inFlightJob, error) {
	if len(r.inFlight) > limit {
		return r.inFlight[:limit], nil
	}
	return r.inFlight, nil
}

func (r *fakeRepo) PersistDispatch(_ context.Context, input dispatchPersist) (dispatchPersistResult, error) {
	r.persistCalls = append(r.persistCalls, input)
	if r.persistFn != nil {
		return r.persistFn(input)
	}
	return dispatchPersistResult{PipelineJobID: input.PipelineJobID, CrawlTaskID: input.CrawlTaskID}, nil
}

func (r *fakeRepo) MarkPipelineJobFailed(_ context.Context, id, message string, _ time.Time) error {
	r.pipelineFailed[id] = message
	return nil
}

func (r *fakeRepo) MarkCrawlTaskQueued(_ context.Context, id string, _ time.Time) error {
	r.taskQueued = append(r.taskQueued, id)
	return nil
}

func (r *fakeRepo) MarkCrawlTaskFailed(_ context.Context, id, message string, _ time.Time) error {
	r.taskFailed[id] = message
	return nil
}

func (r *fakeRepo) PersistRSSSeed(_ context.Context, input rssSeedPersist) (string, error) {
	r.rssCalls = append(r.rssCalls, input)
	if r.rssFn != nil {
		return r.rssFn(input)
	}
	return "outbox-1", nil
}

func (r *fakeRepo) LoadLatestPipelineJob(_ context.Context, _, _ string) (*pipelineJobRecord, error) {
	return r.latestJob, nil
}

func (r *fakeRepo) LoadCrawlTaskStatus(_ context.Context, _, taskID string) (*string, error) {
	status, ok := r.taskStatus[taskID]
	if !ok {
		return nil, nil
	}
	return &status, nil
}

func (r *fakeRepo) ClearInFlightJobs(_ context.Context, _, _ string, _ time.Time) (int, error) {
	return len(r.inFlight), nil
}

func (r *fakeRepo) FindCrawlTaskIDs(_ context.Context, _, _ string, _ []string) ([]string, error) {
	return nil, nil
}

func (r *fakeRepo) FindArticleFingerprintsByFingerprint(_ context.Context, _ string, _ []string, _ time.Time) ([]fingerprintRecord, error) {
	return r.articleByFingerprint, nil
}

func (r *fakeRepo) FindArticleFingerprintsByURL(_ context.Context, _ string, _ []string, _ time.Time) ([]fingerprintRecord, error) {
	return r.articleByURL, nil
}

func (r *fakeRepo) FindActivePipelineFingerprintsByFingerprint(_ context.Context, _ string, _ []string, _ time.Time) ([]fingerprintRecord, error) {
	return r.activeByFingerprint, nil
}

func (r *fakeRepo) FindActivePipelineFingerprintsByURL(_ context.Context, _ string, _ []string, _ time.Time) ([]fingerprintRecord, error) {
	return r.activeByURL, nil
}

func (r *fakeRepo) PauseCrawlTasks(_ context.Context, _ string, _ []string, _ string, _ time.Time) error {
	return nil
}

func (r *fakeRepo) SetPipelineJobQueued(_ context.Context, _ string, _ time.Time) error {
	return nil
}

func (r *fakeRepo) SetPipelineJobFailedAfterRetry(_ context.Context, _, _ string, _ time.Time) error {
	return nil
}

func (r *fakeRepo) UpdateSourceDeepFailure(_ context.Context, _ string, _, _ time.Time, _ *time.Time) error {
	r.deepFailureUpdates++
	return nil
}

func (r *fakeRepo) SyncQueueCounts(_ context.Context, _, _ string) (int, int, error) {
	r.syncQueueCalls++
	return 0, 0, nil
}

func (r *fakeRepo) LatestJobForSnapshot(_ context.Context, _, _ string) (*latestJobSnapshot, error) {
	return nil, nil
}

func (r *fakeRepo) LatestArticleForSnapshot(_ context.Context, _, _ string) (*latestArticleSnapshot, error) {
	return nil, nil
}

func (r *fakeRepo) LatestCrawlTaskByID(_ context.Context, _, _ string) (*latestCrawlTaskSnapshot, error) {
	return nil, nil
}

func (r *fakeRepo) LatestCrawlTaskForSource(_ context.Context, _, _ string) (*latestCrawlTaskSnapshot, error) {
	return nil, nil
}

func (r *fakeRepo) RecentJobStats(_ context.Context, _, _ string, _ time.Time) ([]recentJobStat, error) {
	return nil, nil
}

func (r *fakeRepo) UpsertOpsSnapshot(_ context.Context, _, _ string, _, _, _, _ json.RawMessage, _ time.Time) error {
	r.upsertCalls++
	return nil
}

func (r *fakeRepo) InsertNotification(_ context.Context, input notificationInsert) (string, time.Time, error) {
	r.notifications = append(r.notifications, input)
	return "notification-1", time.Unix(0, 0), nil
}

// fakeCache is the Redis port fake.
type fakeCache struct {
	values    map[string]string
	ttls      map[string]time.Duration
	incrs     map[string]int64
	published []publishedMessage
}

type publishedMessage struct {
	channel string
	payload string
}

func newFakeCache() *fakeCache {
	return &fakeCache{
		values: map[string]string{},
		ttls:   map[string]time.Duration{},
		incrs:  map[string]int64{},
	}
}

func (c *fakeCache) Get(_ context.Context, key string) (string, bool, error) {
	value, ok := c.values[key]
	return value, ok, nil
}

func (c *fakeCache) GetMany(_ context.Context, keys []string) ([]string, []bool, error) {
	values := make([]string, len(keys))
	present := make([]bool, len(keys))
	for index, key := range keys {
		values[index], present[index] = c.values[key]
	}
	return values, present, nil
}

func (c *fakeCache) Set(_ context.Context, key, value string, ttl time.Duration) error {
	c.values[key] = value
	c.ttls[key] = ttl
	return nil
}

func (c *fakeCache) SetMany(_ context.Context, entries []cacheEntry) error {
	for _, entry := range entries {
		c.values[entry.Key] = entry.Value
		c.ttls[entry.Key] = entry.TTL
	}
	return nil
}

func (c *fakeCache) SetIfAbsent(_ context.Context, key, value string, ttl time.Duration) (bool, error) {
	if _, exists := c.values[key]; exists {
		return false, nil
	}
	c.values[key] = value
	c.ttls[key] = ttl
	return true, nil
}

func (c *fakeCache) Del(_ context.Context, keys ...string) error {
	for _, key := range keys {
		delete(c.values, key)
	}
	return nil
}

func (c *fakeCache) Incr(_ context.Context, key string) (int64, error) {
	c.incrs[key]++
	return c.incrs[key], nil
}

func (c *fakeCache) IncrMany(_ context.Context, keys []string) ([]int64, error) {
	out := make([]int64, len(keys))
	for index, key := range keys {
		c.incrs[key]++
		out[index] = c.incrs[key]
	}
	return out, nil
}

func (c *fakeCache) Expire(_ context.Context, key string, ttl time.Duration) error {
	c.ttls[key] = ttl
	return nil
}

func (c *fakeCache) ExpireMany(_ context.Context, keys []string, ttl time.Duration) error {
	for _, key := range keys {
		c.ttls[key] = ttl
	}
	return nil
}

func (c *fakeCache) HIncrBy(_ context.Context, key, _ string, value int64) (int64, error) {
	c.incrs[key] += value
	return c.incrs[key], nil
}

func (c *fakeCache) Publish(_ context.Context, channel string, payload []byte) error {
	c.published = append(c.published, publishedMessage{channel: channel, payload: string(payload)})
	return nil
}

func (c *fakeCache) ReleaseLease(_ context.Context, key, _ string) error {
	delete(c.values, "lock:"+key)
	return nil
}

func (c *fakeCache) RenewLease(_ context.Context, _, _ string, _ time.Duration) error {
	return nil
}

// fakeDiscovery is the crawl metadata port fake.
type fakeDiscovery struct {
	candidates []crawlmetadata.DiscoveryCandidate
	err        error
	calls      int
}

func (d *fakeDiscovery) DiscoverSitemapSeedCandidates(_ context.Context, _, _ string, _ *int, _ *int64) ([]crawlmetadata.DiscoveryCandidate, error) {
	d.calls++
	return d.candidates, d.err
}

func (d *fakeDiscovery) DiscoverRSSCandidates(_ context.Context, _ crawlmetadata.RSSDiscoveryInput) ([]crawlmetadata.DiscoveryCandidate, error) {
	d.calls++
	return d.candidates, d.err
}

func (d *fakeDiscovery) DiscoverListCandidates(_ context.Context, _ crawlmetadata.ListDiscoveryInput) ([]crawlmetadata.DiscoveryCandidate, error) {
	d.calls++
	return d.candidates, d.err
}

func (d *fakeDiscovery) DiscoverDeepCandidates(_ context.Context, _ crawlmetadata.DeepDiscoveryInput) ([]crawlmetadata.DiscoveryCandidate, error) {
	d.calls++
	return d.candidates, d.err
}

// fakeQueue is the crawlqueue port fake.
type fakeQueue struct {
	results    map[string]crawlqueue.EnqueueResult
	errors     map[string]error
	failAll    error
	calls      []string
	pending    int64
	listed     map[string]struct{}
	removeFn   func(map[string]struct{}) (crawlqueue.RemoveQueuedJobsResult, error)
	removeCall int
}

func newFakeQueue() *fakeQueue {
	return &fakeQueue{
		results: map[string]crawlqueue.EnqueueResult{},
		errors:  map[string]error{},
		listed:  map[string]struct{}{},
	}
}

func (q *fakeQueue) EnqueueTask(_ context.Context, taskID, _ string, _ crawlqueue.EnqueueOptions) (crawlqueue.EnqueueResult, error) {
	q.calls = append(q.calls, taskID)
	if q.failAll != nil {
		return crawlqueue.EnqueueResult{}, q.failAll
	}
	if err, ok := q.errors[taskID]; ok {
		return crawlqueue.EnqueueResult{}, err
	}
	if result, ok := q.results[taskID]; ok {
		return result, nil
	}
	return crawlqueue.EnqueueResult{JobID: taskID + "-job"}, nil
}

func (q *fakeQueue) CountsByQueue(_ context.Context) (crawlqueue.QueueCounts, crawlqueue.QueueCounts, error) {
	return crawlqueue.QueueCounts{Waiting: q.pending}, crawlqueue.QueueCounts{}, nil
}

func (q *fakeQueue) LegacyCounts(_ context.Context) (crawlqueue.QueueCounts, error) {
	return crawlqueue.QueueCounts{}, nil
}

func (q *fakeQueue) ListQueuedTaskIDs(_ context.Context) (map[string]struct{}, error) {
	return q.listed, nil
}

func (q *fakeQueue) RemoveQueuedJobsForTasks(_ context.Context, taskIDs map[string]struct{}) (crawlqueue.RemoveQueuedJobsResult, error) {
	q.removeCall++
	if q.removeFn != nil {
		return q.removeFn(taskIDs)
	}
	return crawlqueue.RemoveQueuedJobsResult{RemovedTaskIDs: []string{}}, nil
}

// fakeWorkflows is the overlay compiler fake.
type fakeWorkflows struct {
	overlay *crawlworkflow.CompiledNewsSourceOverlay
	calls   int
}

func (w *fakeWorkflows) CompileNewsSourceOverlay(_ context.Context, _, _, _ string) (*crawlworkflow.CompiledNewsSourceOverlay, error) {
	w.calls++
	return w.overlay, nil
}

// fakeItems is the outbox delivery fake.
type fakeItems struct {
	delivered []string
	result    bool
}

func (i *fakeItems) DeliverOutboxNow(_ context.Context, outboxID string) bool {
	i.delivered = append(i.delivered, outboxID)
	return i.result
}

// fakePipeline is the itemPipeline fake.
type fakePipeline struct {
	enqueued      []string
	enqueueErr    error
	failedJobs    map[string]bool
	existingJobs  map[string]bool
	removedFailed []string
}

func newFakePipeline() *fakePipeline {
	return &fakePipeline{failedJobs: map[string]bool{}, existingJobs: map[string]bool{}}
}

func (p *fakePipeline) EnqueueItem(_ context.Context, _, itemMetaID, rawItemID string, _ pipelineenqueue.EnqueueOptions) (string, error) {
	if p.enqueueErr != nil {
		return "", p.enqueueErr
	}
	p.enqueued = append(p.enqueued, itemMetaID+"-"+rawItemID)
	return itemMetaID + "-" + rawItemID, nil
}

func (p *fakePipeline) JobExists(_ context.Context, jobID string) (bool, error) {
	return p.existingJobs[jobID], nil
}

func (p *fakePipeline) FailedJobExists(_ context.Context, jobID string) (bool, error) {
	return p.failedJobs[jobID], nil
}

func (p *fakePipeline) RemoveFailedJob(_ context.Context, jobID string) (bool, error) {
	p.removedFailed = append(p.removedFailed, jobID)
	return true, nil
}

// fakeCrawlTasks is the crawltaskwrite retry fake.
type fakeCrawlTaskRetry struct {
	calls  int
	status string
	err    error
}

func (r *fakeCrawlTaskRetry) RetryTask(_ context.Context, _ *authhttp.Identity, _ string, _ *string) (crawlreadtelemetry.CrawlTaskView, error) {
	r.calls++
	if r.err != nil {
		return crawlreadtelemetry.CrawlTaskView{}, r.err
	}
	return crawlreadtelemetry.CrawlTaskView{Status: crawlreadtelemetry.CrawlTaskStatus(r.status)}, nil
}

// testSettings is the scheduler configuration the tests use.
func testSettings() Settings {
	return Settings{
		Enabled:                    true,
		BatchSize:                  20,
		LockTTL:                    120 * time.Second,
		InFlightLookback:           6 * time.Hour,
		InFlightRescheduleDelay:    5 * time.Minute,
		JitterMax:                  60 * time.Second,
		MaxEnqueuePerTick:          100,
		BackpressureMaxPendingJobs: 100,
		BackpressureDelay:          5 * time.Minute,
		FailureRecoveryDelay:       10 * time.Minute,
		FailureMaxDelay:            6 * time.Hour,
		CircuitBreakerThreshold:    3,
		CircuitBreakerBaseDelay:    time.Hour,
		CircuitBreakerMaxDelay:     24 * time.Hour,
		SourceConcurrency:          1,
	}
}

// newTestService wires the fakes into a real Service.
func newTestService(repo *fakeRepo, cache *fakeCache, options Options) *Service {
	if options.Settings == (Settings{}) {
		options.Settings = testSettings()
	}
	if options.Now == nil {
		options.Now = func() time.Time {
			return time.Date(2026, 10, 20, 13, 30, 25, 123_000_000, time.UTC)
		}
	}
	if options.Random == nil {
		options.Random = func() float64 { return 0.5 }
	}
	return newServiceWithPorts(repo, cache, options)
}

// testSource builds a NewsSource row.
func testSource(id, orgID string, config map[string]any) *source {
	encoded, _ := json.Marshal(config)
	return &source{
		ID:               id,
		OrgID:            orgID,
		Name:             "Example",
		URL:              "https://example.com/news",
		SiteType:         "general",
		FrequencySeconds: 3600,
		Priority:         0,
		IsActive:         true,
		Config:           encoded,
		UpdatedAt:        time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC),
	}
}

// itemsingestOutbox is a compile-time reminder that the RSS path uses the shared
// envelope type.
var _ = itemsingest.OutboxWrite{}
