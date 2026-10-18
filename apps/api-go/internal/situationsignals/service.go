package situationsignals

import (
	"context"
	"database/sql"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/situationmonitors"
)

// Service holds the dependencies of the seven routes. Every dependency is
// read-only except the two Mongo writes feedback performs (the feedback insert
// and the learning-state upsert) and the one Redis write the Telegram channelSet
// sync performs when the cached state is stale.
type Service struct {
	db    *sql.DB
	cache cacheOps
	mongo *mongo.Database
	// loadMonitors returns the caller's enabled monitors. It is a field so unit
	// tests can supply monitors without MySQL; production wiring delegates to the
	// situationmonitors adapter.
	loadMonitors func(ctx context.Context, orgID, userID string) ([]monitorRecord, error)
	embed        embeddingClient
	settings     *settingsReader
}

// NewService wires the service. The monitor adapter reuses the existing
// situationmonitors implementation so the legacy migration and row
// normalization cannot drift from the monitors HTTP contract.
func NewService(db *sql.DB, redisClient *redis.Client, mongoDatabase *mongo.Database, settings *settingsReader) *Service {
	monitors := situationmonitors.NewService(db)
	return &Service{
		db:    db,
		cache: redisCacheOps(redisClient),
		mongo: mongoDatabase,
		loadMonitors: func(ctx context.Context, orgID, userID string) ([]monitorRecord, error) {
			return loadEnabledMonitors(ctx, monitors, orgID, userID)
		},
		embed:    llmembed.NewClient(db),
		settings: settings,
	}
}

// embeddingClient is the model gateway surface the matcher uses. The concrete
// implementation is *llmembed.Client; the interface exists so unit tests can
// observe whether the gateway was called at all (the lexical fallback must never
// pretend a semantic match happened).
type embeddingClient interface {
	// Embed returns one vector per input text, in order.
	Embed(ctx context.Context, orgID string, texts []string) ([][]float64, string, error)
	// Rerank returns the scored shortlist for one query.
	Rerank(ctx context.Context, orgID, query string, documents []string) ([]llmembed.Hit, error)
}
