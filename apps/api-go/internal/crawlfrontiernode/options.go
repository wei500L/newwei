package crawlfrontiernode

// options.go wires the package. The crawl worker builds one Service per process
// and calls ProcessQueuedNode from the two crawl queues' frontier_node branch.

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// Options are the shared handles plus the test seams. DB and Crawl are
// required; Mongo is required when a crawl stores media.
type Options struct {
	DB    *sql.DB
	Mongo *mongo.Database
	Redis *redis.Client

	// Crawl is the crawl4ai /crawl client the two execution branches call.
	Crawl *crawl4ai.Client
	// Settings resolves the crawl client settings once per request. A nil
	// function uses crawl4ai.DefaultSettings.
	Settings func(ctx context.Context) crawl4ai.Settings

	// LLM is the judge model client. A nil value disables candidate assistance,
	// exactly like an unconfigured CrawlFrontierLlmService.
	LLM *crawlfrontierllm.LLMClient
	// Workflows compiles the profile overlay; nil keeps the base profile.
	Workflows *crawlworkflow.Service
	// Enqueuer is the BullMQ producer surface (crawlqueue.Producer).
	Enqueuer crawlfrontierllm.FrontierEnqueuer
	// Metadata is the sitemap discovery surface; nil builds the default one.
	Metadata *crawlmetadata.Discovery

	// HTTPClient is the seam for sitemap/robots HTTP calls.
	HTTPClient *http.Client
	// Now is the clock seam. Tests pin it to compare ISO timestamps.
	Now func() time.Time

	// ExecConfig carries the crawlexecution settings used when Exec is nil. Only
	// the result-write path is used, so the crawl transport fields may stay
	// zero.
	ExecConfig crawlexecution.Config

	// Exec optionally injects an already-built crawlexecution.Service. The crawl
	// worker shares the instance it runs ordinary tasks with, so a Frontier
	// result write stores media through the same object storage reader and relays
	// notifications through the same publisher, exactly like the ordinary task
	// path and like NestJS resultService.persistResults. The shared service also
	// carries the item ingestor, but PersistFrontierResults keeps
	// ingestToItems=false because NestJS persistFrontierResponse never ingests.
	//
	// A nil value keeps the package-local construction from DB/Mongo/Redis,
	// ExecConfig and HTTPClient. That fallback carries no storage reader, no item
	// ingestor, no relay and no scheduler, so Frontier result media is not
	// stored; it exists for the package's own tests and for callers that only
	// exercise the read path.
	Exec *crawlexecution.Service
}

// Service runs one Frontier node: the processQueuedNode state machine plus the
// layered/native execution branches.
type Service struct {
	db       *sql.DB
	mongo    *mongo.Database
	redis    *redis.Client
	crawl    *crawl4ai.Client
	settings func(ctx context.Context) crawl4ai.Settings
	frontier *crawlfrontierllm.Service
	exec     *crawlexecution.Service
	metadata *crawlmetadata.Discovery
	http     *http.Client
	now      func() time.Time
}

// New builds the node execution service.
func New(options Options) (*Service, error) {
	if options.DB == nil {
		return nil, errors.New("crawlfrontiernode: mysql is required")
	}
	if options.Crawl == nil {
		return nil, errors.New("crawlfrontiernode: crawl4ai client is required")
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	settings := options.Settings
	if settings == nil {
		settings = func(context.Context) crawl4ai.Settings { return crawl4ai.DefaultSettings() }
	}
	// The LLM surface is an interface field, so a typed nil *LLMClient would
	// become a NON-nil interface and HasLlmJudge would report a judge client that
	// does not exist. NestJS gates the deferred judge on `this.frontierLlm`
	// presence, so the nil case must be a nil interface here too.
	var llm crawlfrontierllm.FrontierLLM
	if options.LLM != nil {
		llm = options.LLM
	}
	frontier := crawlfrontierllm.New(crawlfrontierllm.Options{
		DB:        options.DB,
		Redis:     options.Redis,
		Enqueuer:  options.Enqueuer,
		LLM:       llm,
		Workflows: options.Workflows,
		Now:       now,
	})
	// The crawl worker shares its crawlexecution.Service so the Frontier result
	// write keeps the media storage reader, the item ingestor, the notification
	// relay and the news-source scheduler. Without it the local construction only
	// has DB/Mongo/Redis and silently skips media storage.
	exec := options.Exec
	if exec == nil {
		exec = crawlexecution.New(crawlexecution.Options{
			DB:         options.DB,
			Mongo:      options.Mongo,
			Redis:      options.Redis,
			Config:     options.ExecConfig,
			HTTPClient: options.HTTPClient,
			Now:        now,
		})
	}
	metadata := options.Metadata
	if metadata == nil {
		metadata = crawlmetadata.NewDiscovery(
			crawlmetadata.NewService(options.DB, options.Redis),
			options.Crawl,
			settings,
		)
	}
	return &Service{
		db:       options.DB,
		mongo:    options.Mongo,
		redis:    options.Redis,
		crawl:    options.Crawl,
		settings: settings,
		frontier: frontier,
		exec:     exec,
		metadata: metadata,
		http:     options.HTTPClient,
		now:      now,
	}, nil
}

// derefString reads an optional string column.
func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// stringPointer returns a pointer to value (nil is spelled as a nil pointer at
// the call site).
func stringPointer(value string) *string { return &value }

// intPointer returns a pointer to value.
func intPointer(value int) *int { return &value }

// floatPointer returns a pointer to value.
func floatPointer(value float64) *float64 { return &value }
