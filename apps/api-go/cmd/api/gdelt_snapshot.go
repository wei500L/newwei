package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

// gdeltSnapshotUnit is the optional Go side of the situation-monitor GDELT
// external snapshot chain. It owns both execution surfaces:
//
//   - API_GO_GDELT_SNAPSHOT_MODE=go starts the quarter-hour scheduler;
//   - API_GO_GDELT_SNAPSHOT_REFRESH_MODE=go registers the forced-refresh POST.
//
// The two switches are independent, and both executions share the Redis rebuild
// lease with NestJS. The unit keeps the snapshot package out of main.go: main
// only builds it, starts it and closes it. Every method is nil-safe so the
// default (both legacy) deployment keeps a nil unit.
type gdeltSnapshotUnit struct {
	service   *gdeltsnapshot.Service
	scheduler *gdeltsnapshot.Scheduler
}

// newGdeltSnapshotUnit builds the snapshot service when either switch selects
// Go. It returns nil when both are legacy, which is the default deployment.
// Config validation guarantees MySQL and Redis for either switch.
func newGdeltSnapshotUnit(cfg config.Config, db *sql.DB, redisClient *redis.Client) *gdeltSnapshotUnit {
	if db == nil || redisClient == nil {
		log.Printf("api-go: GDELT snapshot unit not built (mysql or redis missing)")
		return nil
	}
	return &gdeltSnapshotUnit{
		service: gdeltsnapshot.NewService(gdeltsnapshot.Options{
			DB:           db,
			Redis:        redisClient,
			GDeltEnabled: cfg.SituationMonitorGdeltEnabled,
		}),
	}
}

// Start launches the quarter-hour scheduler when API_GO_GDELT_SNAPSHOT_MODE=go.
// It does not run a catch-up tick for boundaries that elapsed before startup.
func (u *gdeltSnapshotUnit) Start(cfg config.Config) {
	if u == nil || u.service == nil {
		return
	}
	u.scheduler = gdeltsnapshot.NewScheduler(u.service)
	u.scheduler.Start(context.Background())
	log.Printf("api-go: situation-monitor GDELT snapshot scheduler started (interval=15m)")
}

// RegisterRoute registers the exact forced-refresh POST when
// API_GO_GDELT_SNAPSHOT_REFRESH_MODE=go. legacy leaves the route on NestJS.
func (u *gdeltSnapshotUnit) RegisterRoute(gateway *legacyproxy.Gateway, cfg config.Config, db *sql.DB, authenticator *authhttp.Authenticator) error {
	if u == nil || u.service == nil || db == nil || authenticator == nil {
		return fmt.Errorf("api-go: GDELT snapshot refresh takeover requires mysql, jwt, and redis")
	}
	handler := gdeltsnapshot.NewHandler(authenticator, db, u.service)
	policy := cors.New(cfg.CorsOrigin)
	gateway.RegisterGoHandler(legacyproxy.GdeltSnapshotKey, func(w http.ResponseWriter, r *http.Request) {
		if policy.FinishOptions(w, r) {
			return
		}
		if r.Method == http.MethodOptions {
			gateway.Reject(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	log.Printf("api-go: situation-monitor GDELT snapshot refresh takeover registered")
	return nil
}

// Close stops the scheduler, waits for the in-flight rebuild and returns the
// wait error when the caller's deadline expires. The shared lease is released by
// the rebuild itself or expires after lockTTL.
func (u *gdeltSnapshotUnit) Close(ctx context.Context) error {
	if u == nil || u.scheduler == nil {
		return nil
	}
	return u.scheduler.Close(ctx)
}
