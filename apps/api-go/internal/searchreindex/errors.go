package searchreindex

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// The 409 conflict is byte-identical to the NestJS ConflictException payload:
// SEARCH_REINDEX_IN_PROGRESS with the fixed message and no detail.
const (
	reindexConflictCode    = "SEARCH_REINDEX_IN_PROGRESS"
	reindexConflictMessage = "Search reindex is already running for this organization."
)

// Sentinels used by the service layer.
var (
	// errReindexInProgress marks a lock conflict; the handler answers the coded
	// 409 instead of the generic HTTP exception shape.
	errReindexInProgress = errors.New("search reindex already in progress")
	// errRedis marks a Redis failure so the handler can answer 500.
	errRedis = errors.New("search reindex: redis failure")
	// errMongo marks a Mongo failure so the handler can answer 500.
	errMongo = errors.New("search reindex: mongo failure")
)

// writeServiceError maps a service error onto the shared authhttp error shapes,
// reusing the adminlogs HTTP mapping for the mtk_ machine token failures (the
// same mapping crawlreadtelemetry and qualityoverview use).
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	if errors.Is(err, errReindexInProgress) {
		authhttp.WriteCodedConflict(w, r, reindexConflictCode, reindexConflictMessage, "")
		return
	}
	if status, message, ok := adminlogs.HTTPStatus(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	// Redis, Mongo and Elasticsearch failures are non-HttpException errors in
	// NestJS, so the GlobalExceptionFilter answers 500 "Internal server error".
	log.Printf("search reindex: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
