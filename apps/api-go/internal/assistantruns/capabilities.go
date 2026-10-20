package assistantruns

import (
	"context"
	"database/sql"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
)

// capabilityReader adapts the history read root's capability projection to the
// assistant submit/worker surface.
type capabilityReader struct {
	db    *sql.DB
	redis *redis.Client
}

// NewCapabilityReader builds the shared capability reader. It performs the same
// profile selection and governance guard as the assistantRuntimeCapabilities
// query, so the web-search gate is identical on both paths.
func NewCapabilityReader(db *sql.DB, redisClient *redis.Client) CapabilityReader {
	return &capabilityReader{db: db, redis: redisClient}
}

// RuntimeCapabilities reads the active profile projection.
func (r *capabilityReader) RuntimeCapabilities(ctx context.Context) (history.AssistantRuntimeCapabilitiesModel, error) {
	return history.ReadAssistantCapabilities(ctx, r.db, r.redis)
}
