// Package itemsingest owns the write side of the items domain: the REST
// POST /api/items, the five item/crawl mutations, raw_item MongoOutbox
// immediate delivery and its scheduled replay owner.
//
// All organization and user identifiers come from the caller's authenticated
// identity. The package never trusts an orgId from a request body, crawl
// metadata or a queue payload.
package itemsingest

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// Permission names used by the migrated entries.
const (
	ReadPermission  = "items.read"
	WritePermission = "items.write"
	CrawlRead       = "crawl.read"
	CrawlWrite      = "crawl.write"
)

// Failure is the typed error contract shared by the HTTP and GraphQL adapters.
// The fields mirror the NestJS HttpException/GqlPermissionsGuard payloads.
type Failure struct {
	Status              int
	Message             string
	Code                string
	Detail              string
	RequiredPermissions []string
	PermissionsMode     string
	MissingPermissions  []string
}

// Error implements error.
func (f *Failure) Error() string {
	if f == nil {
		return ""
	}
	return f.Message
}

// NewFailure builds a plain exception.
func NewFailure(status int, message string) *Failure {
	return &Failure{Status: status, Message: message}
}

// itemNotFound is the REST/update/crawl-import miss contract.
func itemNotFound() *Failure { return NewFailure(http.StatusNotFound, "Item not found") }

// crawlTaskNotFound is the exact CrawlTaskService message.
func crawlTaskNotFound() *Failure { return NewFailure(http.StatusNotFound, "crawl task not found") }

// crawlResultNotFound is the single-result miss contract.
func crawlResultNotFound() *Failure { return NewFailure(http.StatusNotFound, "Crawl result not found") }

// invalidPayload wraps the first normalized-schema failure.
func invalidPayload(message string) *Failure {
	return NewFailure(http.StatusBadRequest, "Invalid payload: "+message)
}

// permissionFailureAll is the @PermissionsAll failure shape.
func PermissionFailureAll(required []string, held map[string]bool) *Failure {
	missing := make([]string, 0, len(required))
	for _, permission := range required {
		if !held[permission] {
			missing = append(missing, permission)
		}
	}
	detail := "Missing permissions: "
	if len(missing) == 0 {
		detail += "unknown"
	} else {
		for index, permission := range missing {
			if index > 0 {
				detail += ", "
			}
			detail += permission
		}
	}
	return &Failure{
		Status:              http.StatusForbidden,
		Message:             "Insufficient permissions",
		Code:                "INSUFFICIENT_PERMISSIONS",
		Detail:              detail,
		RequiredPermissions: required,
		PermissionsMode:     "all",
		MissingPermissions:  missing,
	}
}

// RequireAllPermissions reports the @PermissionsAll result for an adapter.
func RequireAllPermissions(held map[string]bool, required ...string) error {
	for _, permission := range required {
		if !held[permission] {
			return PermissionFailureAll(required, held)
		}
	}
	return nil
}

// CreateItemInput is the validated input shared by the REST and GraphQL create
// entries. Payload is the JSON object text; the two entry points validate their
// own DTO shape before reaching the service.
type CreateItemInput struct {
	ExternalID string
	Name       string
	Status     *string
	Payload    []byte
}

// UpdateItemInput is the validated GraphQL update input. Payload is nil when
// the caller omitted it or sent an empty/null JSON string.
type UpdateItemInput struct {
	ID      string
	Name    *string
	Status  *string
	Payload []byte
}

// CreateItemResult is the ItemsIngestService.create return value: the ItemMeta
// fields plus the rawItemId used by the REST contract.
type CreateItemResult struct {
	Meta      itemsreading.ItemMetaRow
	RawItemID string
}

// IngestBatchOptions carries the pagination inputs of
// ingestCrawlTaskResultsToItems.
type IngestBatchOptions struct {
	After       *string
	Limit       *float64
	OnlyMissing *bool
}

// IngestBatchSummary is CrawlIngestBatchModel. The counters stay float64 because
// the SDL declares them as Float.
type IngestBatchSummary struct {
	TaskID          string
	Scanned         float64
	Attempted       float64
	Ingested        float64
	SkippedExisting float64
	Failed          float64
	NextCursor      *string
	HasMore         bool
}

// CrawlResultRow is the CRAWL_RESULT_ITEM_INGEST_SELECT projection.
type CrawlResultRow struct {
	ID          string
	TaskID      string
	SourceURL   string
	FetchedAt   time.Time
	ContentHash string
	Metadata    []byte
	Task        CrawlTaskConfigRow
}

// CrawlTaskConfigRow is the nested task projection used to build the payload.
type CrawlTaskConfigRow struct {
	ID          string
	DisplayName *string
	TargetURL   *string
	Keywords    []byte
	Config      []byte
}

// CreateFromCrawlResultsInput mirrors the two NestJS batch call shapes.
type CreateFromCrawlResultsInput struct {
	CrawlResultIDs []string
	CrawlResults   []CrawlResultRow
}

// CreateFromCrawlResultOutcome is one requested result.
type CreateFromCrawlResultOutcome struct {
	CrawlResultID string
	Meta          *itemsreading.ItemMetaRow
	Err           error
}

// OutboxEntry is one MongoOutbox row projection.
type OutboxEntry struct {
	ID        string
	OrgID     string
	Payload   []byte
	Status    string
	Attempts  int
	CreatedAt time.Time
}

// OutboxPayload is the raw_item outbox envelope.
type OutboxPayload struct {
	Type          string
	OrgID         string
	ItemMetaID    string
	RawItemID     string
	Source        string
	Payload       NormalizedNewsPayload
	PipelineJobID *string
	SourceID      *string
	Priority      *int64
}

// Enqueuer is the narrow itemPipeline producer port.
type Enqueuer interface {
	EnqueueItem(ctx context.Context, orgID, itemMetaID, rawItemID string, opts EnqueueOptions) (string, error)
}

// EnqueueOptions is the producer metadata this package passes through.
type EnqueueOptions struct {
	Priority      *int64
	TraceID       string
	PipelineJobID *string
	SourceID      *string
}

// Hydrator is the narrow read-model port implemented by itemsreading.
type Hydrator interface {
	HydrateItemReadModel(ctx context.Context, orgID, itemMetaID string) error
}

// ErrCursorNotFound mirrors Prisma P2025 for an unresolvable row cursor. It is
// an internal failure, not a validation error.
var ErrCursorNotFound = errors.New("crawl result cursor not found")
