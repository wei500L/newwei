package newseventstimeline

import (
	"database/sql"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
)

// Options are the production dependencies of the timeline rebuild unit.
//
// Orgs lists the active organizations; the credentialled wiring passes the
// shared MySQL implementation. Mongo is the database holding the processeditems
// collection and may be nil, in which case every classification lookup degrades
// to "no classification" and the timeline falls back to
// ProcessedArticle.category exactly like the NestJS Mongo-failure path.
type Options struct {
	DB     *sql.DB
	Redis  *redis.Client
	Mongo  *mongo.Database
	Orgs   ActiveOrgReader
	Logger *log.Logger
	Now    func() time.Time
}

// NewScheduler builds the ten-minute timeline scheduler. The settings reader,
// the concurrency reader and the shared lease are constructed here so cmd/api
// only wires transport handles.
func NewScheduler(options Options) *Scheduler {
	return newScheduler(schedulerOptions{
		Store:       newStore(storeOptions{DB: options.DB, Mongo: options.Mongo, Now: options.Now}),
		Settings:    settingscrawl.NewNewsEventsSettingsReader(options.DB),
		Orgs:        options.Orgs,
		Concurrency: runtimesettings.NewMultiTenantConcurrencyReader(options.DB, options.Redis),
		Redis:       options.Redis,
		Logger:      options.Logger,
		Now:         options.Now,
	})
}
