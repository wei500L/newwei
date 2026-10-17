package classificationrssops

import (
	"context"
	"database/sql"
	"errors"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// Service carries every MySQL, Mongo and Redis query behind the migrated
// endpoints. The handler only routes, authenticates and serializes, so the
// service is the single place where the NestJS service behavior is reproduced.
type Service struct {
	db    *sql.DB
	mongo *mongo.Database
	redis *redis.Client
	store *snapshotStore
	// logs reuses internal/adminlogs for machine-token authentication so the
	// SHA-256 lookup, revoked/expiry checks and lastUsedAt update have exactly
	// one implementation.
	logs *adminlogs.Service
}

// NewService assembles the read/write dependencies. A nil Mongo database makes
// every Mongo query fail closed instead of degrading to an empty result.
func NewService(db *sql.DB, database *mongo.Database, redisClient *redis.Client) *Service {
	return &Service{
		db:    db,
		mongo: database,
		redis: redisClient,
		store: &snapshotStore{db: db, redis: redisClient},
		logs:  adminlogs.NewService(db, database),
	}
}

// AuthenticateMachine resolves a mtk_ token through the shared adminlogs
// implementation: SHA-256 of the token against MachineAccessToken.tokenHash,
// joined to Org.isActive, rejecting revoked or expired rows, updating lastUsedAt
// and deriving the identity as "machine:<tokenId>" with the token's permissions.
func (s *Service) AuthenticateMachine(ctx context.Context, token string) (*authhttp.Identity, error) {
	if s == nil || s.db == nil || s.logs == nil {
		return nil, newStatus(401, "Invalid machine token")
	}
	return s.logs.AuthenticateMachine(ctx, token)
}

// collection returns a Mongo collection or fails closed when MONGO_URI was not
// configured.
func (s *Service) collection(name string) (*mongo.Collection, error) {
	if s == nil || s.mongo == nil {
		return nil, errors.New("mongo is not configured")
	}
	return s.mongo.Collection(name), nil
}

// requireDB fails closed when MySQL is not configured.
func (s *Service) requireDB() error {
	if s == nil || s.db == nil {
		return errors.New("mysql is not configured")
	}
	return nil
}
