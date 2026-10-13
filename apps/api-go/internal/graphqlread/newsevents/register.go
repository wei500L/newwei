// Package newsevents serves the news-event console read queries.
//
// Registered roots: newsEvents, newsEvent, newsEventBrief,
// newsEventReferencedArticles, topicGroups, eventGroups.
// Each requires items.read. orgId comes from the server-derived identity.
//
// newsEventSourcePolicySyncStatus, newsEventSettings, source-policy reads,
// mutations, subscriptions, clustering and ingestion stay on NestJS.
// newsEventBrief serves a matching briefV1 cache hit. A miss or forceRefresh
// does not return an empty brief: generation failure is an internal error,
// the same production Nest message.
package newsevents

import (
	"database/sql"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register adds the six read roots and the object types they project.
func Register(reg *contract.Registry, db *sql.DB, mongoDB *mongo.Database, redisClient *redis.Client) {
	if reg == nil {
		panic("graphqlread: newsevents.Register requires a registry")
	}
	reg.RegisterType("NewsEventModel", NewsEventModel{})
	reg.RegisterType("NewsEventItemModel", NewsEventItemModel{})
	reg.RegisterType("NewsEventProcessedArticleModel", NewsEventProcessedArticleModel{})
	reg.RegisterType("NewsEventArticleModel", NewsEventArticleModel{})
	reg.RegisterType("NewsEventTimelineEntryModel", NewsEventTimelineEntryModel{})
	reg.RegisterType("NewsEventSourceEvidenceModel", NewsEventSourceEvidenceModel{})
	reg.RegisterType("NewsEventReferencedArticleModel", NewsEventReferencedArticleModel{})
	reg.RegisterType("NewsEventBriefModel", NewsEventBriefModel{})
	reg.RegisterType("NewsEventBriefPointModel", NewsEventBriefPointModel{})
	reg.RegisterType("NewsEventBriefComparisonModel", NewsEventBriefComparisonModel{})
	reg.RegisterType("NewsEventBriefSourceModel", NewsEventBriefSourceModel{})
	reg.RegisterType("TopicGroupModel", TopicGroupModel{})
	reg.RegisterType("TopicItemModel", TopicItemModel{})
	reg.RegisterType("EventGroupModel", EventGroupModel{})
	reg.RegisterType("EventGroupItemModel", EventGroupItemModel{})

	svc := &service{db: db, mongo: mongoDB, redis: redisClient}
	reg.RegisterRoot(contract.Root{Name: "newsEvents", Permission: "items.read", Resolve: svc.newsEvents})
	reg.RegisterRoot(contract.Root{Name: "newsEvent", Permission: "items.read", Resolve: svc.newsEvent})
	reg.RegisterRoot(contract.Root{Name: "newsEventBrief", Permission: "items.read", Resolve: svc.newsEventBrief})
	reg.RegisterRoot(contract.Root{Name: "newsEventReferencedArticles", Permission: "items.read", Resolve: svc.newsEventReferencedArticles})
	reg.RegisterRoot(contract.Root{Name: "topicGroups", Permission: "items.read", Resolve: svc.topicGroups})
	reg.RegisterRoot(contract.Root{Name: "eventGroups", Permission: "items.read", Resolve: svc.eventGroups})
}
