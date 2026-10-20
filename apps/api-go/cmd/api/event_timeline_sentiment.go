package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/newseventstimeline"
	"github.com/wei500L/newwei/apps/api-go/internal/sentimentsnapshot"
	"github.com/wei500L/newwei/apps/api-go/internal/userdigest"
)

// eventTimelineSentimentUnit owns the two organization-scoped aggregate cron
// jobs that rebuild derived news data:
//
//   - API_GO_NEWS_EVENTS_TIMELINE_MODE=go starts the ten-minute news-event
//     timeline rebuild (NewsEventTimelineEntry rows plus metadata.timeline);
//   - API_GO_SENTIMENT_SNAPSHOT_MODE=go starts the hourly sentiment snapshot
//     rebuild (EntitySentimentSnapshot and TopicSentimentSnapshot).
//
// The switches are independent. Both units take the same Redis tick gate and
// organization lease keys as the NestJS Cron, so a flip between the processes
// can never run one organization twice at the same time. Neither registers an
// HTTP route or needs a JWT.
//
// Every method is nil-safe, so the default (both legacy) deployment keeps a nil
// unit and constructs no scheduler.
type eventTimelineSentimentUnit struct {
	timeline  *newseventstimeline.Scheduler
	sentiment *sentimentsnapshot.Scheduler
}

// wireEventTimelineSentiment builds the schedulers for the switches that select
// Go. It returns nil when both switches are legacy, which is the default
// deployment. Config validation already guarantees MySQL, Redis and a usable
// MONGO_URI for either switch.
func wireEventTimelineSentiment(
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	graphqlMongo **dashboardstats.Connection,
	dashboardMongo **dashboardstats.Connection,
) (*eventTimelineSentimentUnit, error) {
	timelineOwnedByGo := cfg.NewsEventsTimelineMode == config.NewsEventsTimelineModeGo
	sentimentOwnedByGo := cfg.SentimentSnapshotMode == config.SentimentSnapshotModeGo
	if !timelineOwnedByGo && !sentimentOwnedByGo {
		return nil, nil
	}
	if db == nil || redisClient == nil {
		return nil, fmt.Errorf("api-go: the event-timeline and sentiment snapshot cron units require mysql and redis")
	}
	if cfg.MongoURI == "" {
		return nil, fmt.Errorf("api-go: the event-timeline and sentiment snapshot cron units require a valid MONGO_URI")
	}

	mongoConnection := *graphqlMongo
	if mongoConnection == nil {
		mongoConnection = *dashboardMongo
	}
	if mongoConnection == nil {
		opened, err := dashboardstats.Open(cfg.MongoURI)
		if err != nil {
			return nil, fmt.Errorf("api-go: the event-timeline and sentiment snapshot cron units require a valid MONGO_URI: %w", err)
		}
		*graphqlMongo = opened
		mongoConnection = opened
	}
	mongoDatabase := mongoConnection.Database()

	// The active-organization list is the same MySQL read both NestJS crons use:
	// every active organization ordered by id ascending.
	orgs := userdigest.NewMySQLDeliveryRepository(db)
	unit := &eventTimelineSentimentUnit{}
	if timelineOwnedByGo {
		unit.timeline = newseventstimeline.NewScheduler(newseventstimeline.Options{
			DB:     db,
			Redis:  redisClient,
			Mongo:  mongoDatabase,
			Orgs:   orgs,
			Logger: log.Default(),
		})
	}
	if sentimentOwnedByGo {
		unit.sentiment = sentimentsnapshot.NewScheduler(sentimentsnapshot.Options{
			DB:     db,
			Redis:  redisClient,
			Mongo:  mongoDatabase,
			Orgs:   orgs,
			Logger: log.Default(),
		})
	}
	return unit, nil
}

// Start launches the schedulers whose switch is go. Neither runs a catch-up tick
// for boundaries that elapsed before startup.
func (u *eventTimelineSentimentUnit) Start(cfg config.Config) {
	if u == nil {
		return
	}
	if u.timeline != nil && cfg.NewsEventsTimelineMode == config.NewsEventsTimelineModeGo {
		u.timeline.Start(context.Background())
		log.Printf("api-go: news-event timeline rebuild scheduler started (interval=10m)")
	}
	if u.sentiment != nil && cfg.SentimentSnapshotMode == config.SentimentSnapshotModeGo {
		u.sentiment.Start(context.Background())
		log.Printf("api-go: sentiment snapshot scheduler started (interval=1h)")
	}
}

// Close stops both loops and waits for the in-flight organizations to drain
// before the shared Redis and Mongo connections close.
func (u *eventTimelineSentimentUnit) Close(ctx context.Context) error {
	if u == nil {
		return nil
	}
	if u.timeline != nil {
		if err := u.timeline.Close(ctx); err != nil {
			return err
		}
	}
	if u.sentiment != nil {
		if err := u.sentiment.Close(ctx); err != nil {
			return err
		}
	}
	return nil
}
