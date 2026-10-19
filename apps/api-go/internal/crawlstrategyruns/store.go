package crawlstrategyruns

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
)

// Service owns the workflow-run recorder and the trial/replay runtime. It shares
// one MySQL pool with the rest of the process and reuses the crawlworkflow
// bridge and the crawlmetadata discovery chain instead of re-implementing them.
type Service struct {
	db               *sql.DB
	discoveryService *crawlmetadata.Discovery
	workflows        *crawlworkflow.Service
}

// Options configures the service. Discovery is required for trial/replay; a nil
// discovery chain makes every discovery node behave like an unconfigured
// crawl4ai service (RSS/sitemap/list still work through direct HTTP, deep
// discovery reports SEED_DEEP_CRAWL4AI_UNAVAILABLE).
type Options struct {
	DB        *sql.DB
	Discovery *crawlmetadata.Discovery
	Workflows *crawlworkflow.Service
}

// NewService builds the service.
func NewService(options Options) *Service {
	workflows := options.Workflows
	if workflows == nil && options.DB != nil {
		workflows = crawlworkflow.NewService(options.DB)
	}
	return &Service{db: options.DB, discoveryService: options.Discovery, workflows: workflows}
}

// dbtx lets the read paths share helpers between the pool and a transaction.
type dbtx interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// statusError is the Nest HttpException-equivalent error (404/400).
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// inputError is a 400 validation error with the class-validator text already
// assembled.
type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

// newRowID writes a Prisma cuid-shaped primary key (c + 24 hex characters), the
// same shape the other Go migrations write for cuid columns that have no MySQL
// default.
func newRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

// unavailable reports a database-connection-class failure (fail-closed 503).
func unavailable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, sql.ErrConnDone) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var mysqlErr *mysqlDriver.MySQLError
	if errors.As(err, &mysqlErr) {
		switch mysqlErr.Number {
		case 1040, 1042, 1043, 1053, 1159, 1160, 1161, 2002, 2003, 2006, 2013:
			return true
		}
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

// runSelect is the replay read projection: the workflow and version names come
// from the relations Prisma includes.
const runSelect = `
SELECT r.id, r.orgId, r.workflowId, r.workflowVersionId, r.workflowOrigin, r.status,
       r.runKind, r.input, w.name, v.version
FROM CrawlStrategyWorkflowRun r
LEFT JOIN CrawlStrategyWorkflow w ON w.id = r.workflowId
LEFT JOIN CrawlStrategyWorkflowVersion v ON v.id = r.workflowVersionId
WHERE r.id = ?`

// loadRunForReplay reads one run by primary key. The orgId comparison happens in
// the caller so a cross-tenant run returns the same 404 as an absent one.
func (s *Service) loadRunForReplay(ctx context.Context, runID string) (runRow, error) {
	row := s.db.QueryRowContext(ctx, runSelect, runID)
	var (
		document  runRow
		workflow  sql.NullString
		versionID sql.NullString
		input     []byte
		name      sql.NullString
		version   sql.NullInt64
	)
	err := row.Scan(
		&document.ID, &document.OrgID, &workflow, &versionID, &document.WorkflowOrigin,
		&document.Status, &document.RunKind, &input, &name, &version,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return runRow{}, errWorkflowRunMissing
	}
	if err != nil {
		return runRow{}, err
	}
	if workflow.Valid {
		document.WorkflowID = &workflow.String
	}
	if versionID.Valid {
		document.WorkflowVersionID = &versionID.String
	}
	if name.Valid {
		document.WorkflowName = &name.String
	}
	if version.Valid {
		value := int(version.Int64)
		document.VersionValue = &value
	}
	document.Input = input
	return document, nil
}

// errWorkflowRunMissing is the recorder getRun 404.
var errWorkflowRunMissing = newStatus(404, "Workflow run not found")
