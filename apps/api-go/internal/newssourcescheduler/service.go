package newssourcescheduler

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

// discoveryPort is the crawlmetadata discovery surface the seed resolver uses.
type discoveryPort interface {
	DiscoverSitemapSeedCandidates(ctx context.Context, domain, pattern string, maxURLs *int, freshnessCutoffTs *int64) ([]crawlmetadata.DiscoveryCandidate, error)
	DiscoverRSSCandidates(ctx context.Context, input crawlmetadata.RSSDiscoveryInput) ([]crawlmetadata.DiscoveryCandidate, error)
	DiscoverListCandidates(ctx context.Context, input crawlmetadata.ListDiscoveryInput) ([]crawlmetadata.DiscoveryCandidate, error)
	DiscoverDeepCandidates(ctx context.Context, input crawlmetadata.DeepDiscoveryInput) ([]crawlmetadata.DiscoveryCandidate, error)
}

// queuePort is the crawlqueue producer surface.
type queuePort interface {
	EnqueueTask(ctx context.Context, taskID, orgID string, options crawlqueue.EnqueueOptions) (crawlqueue.EnqueueResult, error)
	CountsByQueue(ctx context.Context) (hot, normal crawlqueue.QueueCounts, err error)
	LegacyCounts(ctx context.Context) (crawlqueue.QueueCounts, error)
	ListQueuedTaskIDs(ctx context.Context) (map[string]struct{}, error)
	RemoveQueuedJobsForTasks(ctx context.Context, taskIDs map[string]struct{}) (crawlqueue.RemoveQueuedJobsResult, error)
}

// workflowPort is the crawl-strategy overlay compiler.
type workflowPort interface {
	CompileNewsSourceOverlay(ctx context.Context, orgID, workflowID, workflowVersionID string) (*crawlworkflow.CompiledNewsSourceOverlay, error)
}

// itemsPort is the raw_item outbox delivery.
type itemsPort interface {
	DeliverOutboxNow(ctx context.Context, outboxID string) bool
}

// pipelinePort is the itemPipeline producer plus the retry probes.
type pipelinePort interface {
	EnqueueItem(ctx context.Context, orgID, itemMetaID, rawItemID string, opts pipelineenqueue.EnqueueOptions) (string, error)
	JobExists(ctx context.Context, jobID string) (bool, error)
	FailedJobExists(ctx context.Context, jobID string) (bool, error)
	RemoveFailedJob(ctx context.Context, jobID string) (bool, error)
}

// crawlTaskRetryPort is the crawltaskwrite retry entry point, reused unchanged
// so the rate limit, the items.write requirement and the audit log stay in one
// place.
type crawlTaskRetryPort interface {
	RetryTask(ctx context.Context, caller *authhttp.Identity, taskID string, ip *string) (crawlreadtelemetry.CrawlTaskView, error)
}

// Options configures New.
type Options struct {
	DB              *sql.DB
	Redis           *redis.Client
	Discovery       discoveryPort
	Queue           queuePort
	Workflows       workflowPort
	Items           itemsPort
	Pipeline        pipelinePort
	CrawlTasks      crawlTaskRetryPort
	Settings        Settings
	CrawlDefaults   CrawlDefaults
	ScheduleEnabled bool
	TrustProxy      string
	Now             func() time.Time
	Random          func() float64
}

// Service owns the scheduler, the shared dispatch body and the four operations
// endpoints.
type Service struct {
	db         *sql.DB
	cache      cacheStore
	repo       repository
	discovery  discoveryPort
	queue      queuePort
	workflows  workflowPort
	items      itemsPort
	pipeline   pipelinePort
	crawlTasks crawlTaskRetryPort

	settings        Settings
	crawlDefaults   CrawlDefaults
	scheduleEnabled bool
	trustProxy      string

	now         func() time.Time
	randomFloat func() float64

	settingsCache seedRuntimeSettingsCache

	overlayMutex sync.Mutex
	overlayCache map[string]*overlayCall

	discoveryMutex sync.Mutex
	discoveryCalls map[string]*discoveryCall

	actorMutex sync.Mutex
	actorByOrg map[string]string
}

// overlayCall collapses the per-tick workflow overlay compile (O7).
type overlayCall struct {
	done  chan struct{}
	value *crawlworkflow.CompiledNewsSourceOverlay
	err   error
}

// discoveryCall collapses one in-process discovery load (O8).
type discoveryCall struct {
	done  chan struct{}
	value []json.RawMessage
	err   error
}

// New builds the production service.
func New(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	random := options.Random
	if random == nil {
		source := rand.New(rand.NewSource(time.Now().UnixNano()))
		var mutex sync.Mutex
		random = func() float64 {
			mutex.Lock()
			defer mutex.Unlock()
			return source.Float64()
		}
	}
	service := &Service{
		db:              options.DB,
		discovery:       options.Discovery,
		queue:           options.Queue,
		workflows:       options.Workflows,
		items:           options.Items,
		pipeline:        options.Pipeline,
		crawlTasks:      options.CrawlTasks,
		crawlDefaults:   defaults,
		settings:        options.Settings,
		scheduleEnabled: options.ScheduleEnabled,
		trustProxy:      options.TrustProxy,
		now:             now,
		randomFloat:     random,
		overlayCache:    map[string]*overlayCall{},
		discoveryCalls:  map[string]*discoveryCall{},
		actorByOrg:      map[string]string{},
	}
	if options.DB != nil {
		service.repo = newMySQLRepository(options.DB, itemsingest.WriteRawItemOutboxTx)
	}
	if options.Redis != nil {
		service.cache = newRedisCache(options.Redis)
	}
	return service
}

// newServiceWithPorts builds a service around explicit ports for the tests.
func newServiceWithPorts(repo repository, cache cacheStore, options Options) *Service {
	service := New(options)
	service.repo = repo
	service.cache = cache
	return service
}

// logInfo logs an INFO line with key=value pairs.
func (s *Service) logInfo(message string, keyValues ...any) {
	log.Printf("newssourcescheduler: %s%s", message, formatLogFields(keyValues))
}

// logWarn logs a WARN line with key=value pairs.
func (s *Service) logWarn(message string, keyValues ...any) {
	log.Printf("newssourcescheduler: WARN %s%s", message, formatLogFields(keyValues))
}

// logError logs an ERROR line with key=value pairs.
func (s *Service) logError(message string, keyValues ...any) {
	log.Printf("newssourcescheduler: ERROR %s%s", message, formatLogFields(keyValues))
}

// formatLogFields renders the key/value pairs appended to a log line.
func formatLogFields(keyValues []any) string {
	if len(keyValues) == 0 {
		return ""
	}
	out := ""
	for index := 0; index+1 < len(keyValues); index += 2 {
		out += " " + formatJSString(keyValues[index]) + "=" + formatJSString(keyValues[index+1])
	}
	return out
}

// formatJSString renders one log field value.
func formatJSString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case error:
		return typed.Error()
	case time.Time:
		return isoMillis(typed)
	default:
		return fmt.Sprintf("%v", value)
	}
}

// scheduleTicksEnabled reports whether the scheduler loop may own ticks:
// SCHEDULE_ENABLED must not be false and NEWS_SOURCE_SCHEDULER_ENABLED must not
// be false.
func (s *Service) scheduleTicksEnabled() bool {
	return s.scheduleEnabled && s.settings.Enabled
}

// resolveCrawlActorID is resolveCrawlActorId: the first membership of the
// organization, cached in-process once found.
func (s *Service) resolveCrawlActorID(ctx context.Context, orgID string) (*string, error) {
	s.actorMutex.Lock()
	cached, ok := s.actorByOrg[orgID]
	s.actorMutex.Unlock()
	if ok && cached != "" {
		value := cached
		return &value, nil
	}
	userID, err := s.repo.ResolveCrawlActor(ctx, orgID)
	if err != nil {
		return nil, err
	}
	if userID == nil || *userID == "" {
		return nil, nil
	}
	s.actorMutex.Lock()
	s.actorByOrg[orgID] = *userID
	s.actorMutex.Unlock()
	return userID, nil
}

// compileOverlayCached compiles the workflow overlay once per tick per
// (workflowId, workflowVersionId, bindingMode) tuple (O7). Concurrent source
// dispatches that need the same tuple wait for the first compile instead of
// repeating it.
func (s *Service) compileOverlayCached(ctx context.Context, source *source) (*crawlworkflow.CompiledNewsSourceOverlay, error) {
	workflowID := ""
	if source.WorkflowID != nil {
		workflowID = *source.WorkflowID
	}
	versionID := ""
	if source.WorkflowVersionID != nil {
		versionID = *source.WorkflowVersionID
	}
	if workflowID == "" && versionID == "" {
		// compileNewsSourceOverlay returns null without touching the database.
		return nil, nil
	}
	if s.workflows == nil {
		return nil, nil
	}
	key := workflowID + "\x00" + versionID + "\x00" + source.WorkflowBindingMode

	s.overlayMutex.Lock()
	if existing, ok := s.overlayCache[key]; ok {
		s.overlayMutex.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-existing.done:
		}
		return existing.value, existing.err
	}
	call := &overlayCall{done: make(chan struct{})}
	s.overlayCache[key] = call
	s.overlayMutex.Unlock()

	value, err := s.workflows.CompileNewsSourceOverlay(ctx, source.OrgID, workflowID, versionID)

	s.overlayMutex.Lock()
	call.value = value
	call.err = err
	close(call.done)
	s.overlayMutex.Unlock()
	return value, err
}

// resetOverlayCache clears the per-tick overlay cache.
func (s *Service) resetOverlayCache() {
	s.overlayMutex.Lock()
	s.overlayCache = map[string]*overlayCall{}
	s.overlayMutex.Unlock()
}

// resolveDiscoverySingleflight collapses concurrent discovery loads for the same
// cache key inside this process (O8). The Redis cache.wrap lock still protects
// cross-process races.
func (s *Service) resolveDiscoverySingleflight(ctx context.Context, key string, load func() ([]json.RawMessage, error)) ([]json.RawMessage, error) {
	s.discoveryMutex.Lock()
	if existing, ok := s.discoveryCalls[key]; ok {
		s.discoveryMutex.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-existing.done:
		}
		return existing.value, existing.err
	}
	call := &discoveryCall{done: make(chan struct{})}
	s.discoveryCalls[key] = call
	s.discoveryMutex.Unlock()

	value, err := load()

	s.discoveryMutex.Lock()
	call.value = value
	call.err = err
	close(call.done)
	delete(s.discoveryCalls, key)
	s.discoveryMutex.Unlock()
	return value, err
}
