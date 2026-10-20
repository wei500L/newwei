package history

import (
	"context"
	"database/sql"

	"github.com/redis/go-redis/v9"
)

// ReadAssistantCapabilities exposes the assistantRuntimeCapabilities resolver
// projection to the assistant write/worker batch. It is the same read path the
// GraphQL root uses (active profile, governance guard and apiSurface/web-search
// flags), so the submit-time web-search check cannot drift from the read root.
func ReadAssistantCapabilities(ctx context.Context, db *sql.DB, redisClient *redis.Client) (AssistantRuntimeCapabilitiesModel, error) {
	service := &service{db: db, redis: redisClient}
	return service.runtimeCapabilities(ctx)
}
