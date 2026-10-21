package main

import (
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/queueorgstats"
)

// wireQueueOrgStats builds the single-owner itemPipeline organization-stats
// tracker when API_GO_QUEUE_ORG_STATS_MODE=go.
//
// The tracker needs two connections: the shared command client for the lease,
// the meta reads and the three counter scripts, and a dedicated blocking
// connection for XREAD (a client parked in XREAD BLOCK cannot run the lease).
// redisOptions is the connection configuration newRedisOptions already built for
// the blocking readers, so the tracker opens its own client from it.
//
// In legacy mode (the default, including an unset variable) it returns (nil, nil)
// and NestJS QueueOrgStatsTracker keeps maintaining the counters. main starts the
// returned tracker after the alert/situation workers and closes it before the
// shared Redis connection is closed.
func wireQueueOrgStats(cfg config.Config, redisClient *redis.Client, redisOptions *redis.Options) (*queueorgstats.Tracker, error) {
	if cfg.QueueOrgStatsMode != config.QueueOrgStatsModeGo {
		return nil, nil
	}
	if redisClient == nil || redisOptions == nil {
		return nil, fmt.Errorf("api-go: API_GO_QUEUE_ORG_STATS_MODE=go requires redis")
	}
	tracker, err := queueorgstats.New(queueorgstats.Options{
		Redis:           redisClient,
		BlockingOptions: redisOptions,
	})
	if err != nil {
		return nil, fmt.Errorf("api-go: queue org stats tracker: %w", err)
	}
	log.Printf("api-go: queue org stats tracker enabled mode=%s (single-owner lease, XREAD bull:itemPipeline:events)",
		cfg.QueueOrgStatsMode)
	return tracker, nil
}
