package main

// crawl_worker_test.go locks the Frontier node wiring of the crawl worker.
//
// API_GO_CRAWL_WORKER_MODE=go must never reach crawlworker.New with a nil Frontier
// processor: crawlworker rejects that at construction, and before this wiring the
// whole switch could not be turned on. The test builds the processor directly and
// opens no MySQL, Mongo or Redis connection — every constructor involved only
// stores its handles.

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"testing"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontiernode"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// errStubNoConnection fails every stub connection attempt; the wiring under test
// must construct without dialing.
var errStubNoConnection = errors.New("crawl worker test: no connection")

// stubConnector builds a *sql.DB without registering a driver name globally.
type stubConnector struct{}

// Connect implements driver.Connector.
func (stubConnector) Connect(context.Context) (driver.Conn, error) { return nil, errStubNoConnection }

// Driver implements driver.Connector.
func (stubConnector) Driver() driver.Driver { return stubDriver{} }

// stubDriver is the driver.Driver behind stubConnector.
type stubDriver struct{}

// Open implements driver.Driver.
func (stubDriver) Open(string) (driver.Conn, error) { return nil, errStubNoConnection }

// TestCrawlFrontierNodeProcessorBuiltForGoMode is the startup-protection test:
// with every dependency present, go mode must build a non-nil processor over the
// crawl worker's own crawlexecution.Service. A nil result would make
// wireCrawlWorker fail startup instead of claiming frontier_node jobs.
func TestCrawlFrontierNodeProcessorBuiltForGoMode(t *testing.T) {
	cfg := config.Config{
		CrawlBaseURL:        "http://crawl4ai.test:11235",
		CrawlTimeoutMs:      120_000,
		CrawlHealthTTLMs:    60_000,
		CrawlMaxConcurrency: 4,
		CrawlMaxRetries:     2,
		CrawlRetryBackoffMs: 1_000,
		LiteLLMAPIBase:      "http://litellm.test:4001",
		LiteLLMTimeoutMs:    60_000,
		LiteLLMMaxRetries:   3,
	}
	db := sql.OpenDB(stubConnector{})
	t.Cleanup(func() { _ = db.Close() })
	redisClient := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
	t.Cleanup(func() { _ = redisClient.Close() })
	// The shared execution service the crawl worker builds for the ordinary task
	// path; the Frontier processor must receive this exact instance.
	execution := crawlexecution.New(crawlexecution.Options{DB: db, Redis: redisClient})
	settings := crawlqueue.NewSettingsReader(db, redisClient, nil)

	processor, err := newCrawlFrontierNodeProcessor(cfg, db, redisClient, nil, execution, settings)
	if err != nil {
		t.Fatalf("newCrawlFrontierNodeProcessor: %v", err)
	}
	if processor == nil {
		t.Fatal("API_GO_CRAWL_WORKER_MODE=go built a nil Frontier node processor")
	}
	if _, ok := processor.(*crawlfrontiernode.Service); !ok {
		t.Fatalf("processor type = %T, want *crawlfrontiernode.Service", processor)
	}
}
