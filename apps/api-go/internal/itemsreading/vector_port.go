package itemsreading

import (
	"context"
	"encoding/json"
	"time"
)

// ArchiveVectorRequest is the archive semantic-search recall body. It
// deliberately has no LookbackMs member: the NestJS archive call omits
// `lookbackMs`, and sending the Go zero value would add a 0 window the source
// never sends. The items search keeps its own VectorSearchRequest.
type ArchiveVectorRequest struct {
	OrgID          string
	EmbeddingModel string
	Vector         []float64
	Limit          int
	MinScore       float64
}

// archiveVectorWire is the encoded body shared by every attempt.
type archiveVectorWire struct {
	OrgID          string    `json:"orgId"`
	EmbeddingModel string    `json:"embeddingModel"`
	Vector         []float64 `json:"vector"`
	Limit          int       `json:"limit"`
	MinScore       float64   `json:"minScore"`
}

// ArchiveVectorClient is the narrow archive recall port. It reuses the vector-go
// transport and retry policy of this package but never falls back to Mongo and
// never consults ITEMS_VECTOR_HARD_FAIL_ENABLED: for the archive path a nil
// searcher is an infrastructure failure, not a signal to read Mongo.
type ArchiveVectorClient struct {
	searcher *vectorSearcher
}

// NewArchiveVectorClient builds the client from the shared vector environment.
// A nil/incomplete configuration is kept as an unavailable client so the caller
// can project ARCHIVE_VECTOR_UNAVAILABLE instead of silently degrading.
func NewArchiveVectorClient() *ArchiveVectorClient {
	return &ArchiveVectorClient{searcher: newVectorSearcherFromEnv()}
}

// Search returns (matches, true) for a valid response, where an omitted matches
// member is a legal empty recall, and (nil, false) when the vector service is
// not configured, unreachable or answered an invalid payload.
func (c *ArchiveVectorClient) Search(ctx context.Context, req ArchiveVectorRequest) ([]VectorSearchMatch, bool) {
	if c == nil || c.searcher == nil {
		return nil, false
	}
	body, err := json.Marshal(archiveVectorWire{
		OrgID:          req.OrgID,
		EmbeddingModel: req.EmbeddingModel,
		Vector:         req.Vector,
		Limit:          req.Limit,
		MinScore:       req.MinScore,
	})
	if err != nil {
		return nil, false
	}
	attempts := c.searcher.maxRetries + 1
	if attempts < 1 {
		attempts = 1
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		matches, retryable, attemptErr := c.searcher.searchOnce(ctx, body)
		if attemptErr == nil {
			return matches, true
		}
		if !retryable || attempt >= attempts {
			return nil, false
		}
		delay := vectorServiceRetryBaseDelay * time.Duration(1<<(attempt-1))
		if sleepErr := sleepContext(ctx, delay); sleepErr != nil {
			return nil, false
		}
	}
	return nil, false
}
