package vectorclient

// This file declares the read-side port the migrated news pipeline dedupe stage
// uses. The implementation (vector-go /v1/search request, effective settings
// resolution from the SystemSetting row plus the VECTOR_SERVICE_* env defaults,
// retry policy and the "unavailable means fallback" contract) is added by the
// dedupe unit in search.go; keeping the port here lets the pipeline depend on a
// narrow, typed surface and lets the wiring pass one concrete searcher.

import (
	"context"
	"database/sql"
	"time"

	"github.com/redis/go-redis/v9"
)

// SearchRequest is one VectorClientService.searchBestEffort call.
type SearchRequest struct {
	OrgID          string
	EmbeddingModel string
	Vector         []float64
	Limit          int
	MinScore       *float64
	LookbackMS     *int64
	TraceID        string
}

// SearchMatch is one vector search hit.
type SearchMatch struct {
	ProcessedItemID string
	ItemMetaID      string
	CreatedAtMS     int64
	Score           float64
}

// Searcher is the news dedupe search port. An error means the vector service is
// unavailable (the NestJS searchBestEffort null result), which makes the caller
// apply its Mongo fallback rules; a nil error with an empty slice means the
// search ran and found nothing.
type Searcher interface {
	SearchBestEffort(ctx context.Context, request SearchRequest) ([]SearchMatch, error)
}

// SearcherEnv is the vector-service environment default block.
type SearcherEnv struct {
	Enabled         bool
	FallbackToMongo bool
	BaseURL         string
	Token           string
	TimeoutMS       int
	MaxRetries      int
	// EncryptionKey decrypts a stored encrypted token, matching the Settings
	// crypto helper.
	EncryptionKey string
}

// SearcherOptions wires the vector search client.
type SearcherOptions struct {
	DB    *sql.DB
	Redis *redis.Client
	Env   SearcherEnv
	// Health is the process-wide circuit state shared with every other vector
	// client of the process. A nil value makes NewSearcher build a private
	// zero-value Health, so an unwired caller keeps the previous behaviour and
	// a standalone searcher still gets a working window.
	Health *Health
	Now    func() time.Time
	Random func() float64
}
