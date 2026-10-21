package crawlfrontiernode

// options_test.go locks the crawlexecution.Service injection seam.
//
// The crawl worker runs ordinary tasks and Frontier nodes through the same
// process, and only its service carries the object storage reader, the item
// ingestor, the notification relay and the news source scheduler. A Frontier node
// write through a package-local service would therefore skip the media upload
// NestJS resultService.persistResults performs, so New must use the injected
// instance verbatim and keep the local construction only as the fallback.
//
// The test opens no connection: sql.OpenDB hands out a DB backed by a stub
// connector, and every constructor reached here only stores its handles.

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
)

// errStubNoConnection fails every stub connection attempt; the code under test
// must never dial.
var errStubNoConnection = errors.New("crawlfrontiernode test: no connection")

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

func TestNewUsesInjectedExecutionService(t *testing.T) {
	db := sql.OpenDB(stubConnector{})
	t.Cleanup(func() { _ = db.Close() })
	client := crawl4ai.New(crawl4ai.Options{})
	shared := crawlexecution.New(crawlexecution.Options{DB: db, Mongo: nil, Redis: nil})

	service, err := New(Options{DB: db, Crawl: client, Exec: shared})
	if err != nil {
		t.Fatalf("New with an injected execution service: %v", err)
	}
	if service.exec != shared {
		t.Fatal("New built its own crawlexecution.Service instead of using the injected one; Frontier result writes would skip media storage, ingestToItems and the notification relay")
	}
}

func TestNewFallsBackToLocalExecutionService(t *testing.T) {
	db := sql.OpenDB(stubConnector{})
	t.Cleanup(func() { _ = db.Close() })
	client := crawl4ai.New(crawl4ai.Options{})

	service, err := New(Options{DB: db, Crawl: client})
	if err != nil {
		t.Fatalf("New without an injected execution service: %v", err)
	}
	if service.exec == nil {
		t.Fatal("New without Exec must keep the package-local crawlexecution.Service")
	}
}
