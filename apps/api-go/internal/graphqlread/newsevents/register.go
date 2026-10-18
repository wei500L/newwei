// Package newsevents serves the news-event console read queries.
//
// Registered roots: newsEvents, newsEvent, newsEventReferencedArticles,
// topicGroups, eventGroups, and — only when the brief sub-switch is go —
// newsEventBrief. Each requires items.read. orgId comes from the
// server-derived identity.
//
// newsEventSourcePolicySyncStatus, newsEventSettings, source-policy reads,
// mutations, subscriptions, clustering and ingestion stay on NestJS.
//
// newsEventBrief serves a matching briefV1 cache hit and otherwise generates
// the brief synchronously through the exported publicportal completion
// surface, validates the structured output, writes the briefV1 leaf back and
// returns it. While the brief sub-switch is legacy the root is not registered
// at all, so any document selecting it falls back to NestJS as a whole; the
// other five roots keep serving from Go.
package newsevents

import (
	"database/sql"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// Options declares the optional news-event read dependencies.
type Options struct {
	// BriefEnabled registers the newsEventBrief root and enables the
	// synchronous cold path. When false the other five roots are still
	// registered and newsEventBrief falls back to NestJS.
	BriefEnabled bool
	// Brief is the model completion surface. It is required when
	// BriefEnabled is set.
	Brief publicportal.BriefCompleter
	// BriefLogs persists one llmrequestlogs row per real model attempt. Nil
	// keeps the completion working without request logging.
	BriefLogs *llmlogs.CompletionWriter
}

// Register adds the news-event read roots and the object types they project.
func Register(reg *contract.Registry, db *sql.DB, mongoDB *mongo.Database, redisClient *redis.Client, opts Options) {
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
	if opts.BriefEnabled {
		svc.brief = opts.Brief
		svc.briefObserver = newBriefAttemptObserver(opts.BriefLogs)
	}

	reg.RegisterRoot(contract.Root{Name: "newsEvents", Permission: "items.read", Resolve: svc.newsEvents})
	reg.RegisterRoot(contract.Root{Name: "newsEvent", Permission: "items.read", Resolve: svc.newsEvent})
	reg.RegisterRoot(contract.Root{Name: "newsEventReferencedArticles", Permission: "items.read", Resolve: svc.newsEventReferencedArticles})
	reg.RegisterRoot(contract.Root{Name: "topicGroups", Permission: "items.read", Resolve: svc.topicGroups})
	reg.RegisterRoot(contract.Root{Name: "eventGroups", Permission: "items.read", Resolve: svc.eventGroups})
	if opts.BriefEnabled {
		reg.RegisterRoot(contract.Root{Name: "newsEventBrief", Permission: "items.read", Resolve: svc.newsEventBrief})
	}
}
