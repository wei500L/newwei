package sentimentsnapshot

import (
	"database/sql"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
)

// Options are the production dependencies of the sentiment snapshot unit.
type Options struct {
	DB     *sql.DB
	Redis  *redis.Client
	Mongo  *mongo.Database
	Orgs   ActiveOrgReader
	Logger *log.Logger
	Now    func() time.Time
}

// NewScheduler builds the hourly sentiment snapshot scheduler. The concurrency
// reader and the shared lease are constructed here so cmd/api only wires
// transport handles.
func NewScheduler(options Options) *Scheduler {
	return newScheduler(schedulerOptions{
		Store:       newStore(storeOptions{DB: options.DB, Mongo: options.Mongo, Now: options.Now}),
		Orgs:        options.Orgs,
		Concurrency: runtimesettings.NewMultiTenantConcurrencyReader(options.DB, options.Redis),
		Redis:       options.Redis,
		Logger:      options.Logger,
		Now:         options.Now,
	})
}
