package main

// GraphQL assembly: the /graphql handler, its read roots and the independent
// write roots. Every unit is always on in the Go-only runtime, so this function
// registers the full contract exactly once and shares the process-wide MySQL,
// Redis and Mongo clients opened by main. Model registrations that were
// previously conditioned on sibling read switches are unconditional here; the
// read roots always register the shared workspace/alert/history/settings model
// sets first, so the write batches never re-register them.

import (
	"database/sql"
	"fmt"
	"log"
	"strings"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/alertqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/assistantruns"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/cors"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	archivereadinggraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/archivereading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/assistantwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	graphqlcrawlmetadata "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/crawlmetadata"
	graphqlcrawltaskwrite "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/crawltaskwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
	economicdatagraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economicdata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	itemsingestgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsingest"
	itemsgraphql "github.com/wei500L/newwei/apps/api-go/internal/graphqlread/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/kgimpact"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/knowledgegraph"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsindicators"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsindicatorwrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/orgaccesswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/policy"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspacewrite"
	"github.com/wei500L/newwei/apps/api-go/internal/httproute"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/newsbehavior"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
	"github.com/wei500L/newwei/apps/api-go/internal/platform/mongodb"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// wireGraphQL builds the single /graphql executor and registers every Query and
// Mutation root. It also registers the GraphQL stats handler. The returned
// handler is closed during teardown.
func wireGraphQL(
	gateway *httproute.Router,
	cfg config.Config,
	db *sql.DB,
	redisClient *redis.Client,
	authenticator *authhttp.Authenticator,
	mongoClient *mongodb.Client,
	graphqlLimiter *policy.Limiter,
	archiveReadingService *archivereading.Service,
	metadataService *crawlmetadata.Service,
	storageConfigReader objectstorage.ConfigReader,
	itemsIngestService *itemsingest.Service,
	assistantRunService *assistantruns.Service,
	economicService *economicdata.Service,
	crawlTaskService *crawltaskwrite.Service,
	exceptions *exceptionRecorder,
) (*graphqlread.Handler, error) {
	if db == nil || authenticator == nil || redisClient == nil || mongoClient == nil {
		return nil, fmt.Errorf("api-go: GraphQL go execution requires mysql, jwt, redis, and mongo")
	}
	mongoDatabase := mongoClient.Database()
	reg := contract.NewRegistry()

	// Read roots.
	if archiveReadingService == nil {
		return nil, fmt.Errorf("api-go: archive reading GraphQL registration requires the archive service")
	}
	archivereadinggraphql.Register(reg, archiveReadingService)
	alerts.Register(reg, db)
	history.Register(reg, db, mongoDatabase, redisClient)
	economic.Register(reg, db)
	briefOptions := newsevents.Options{
		BriefEnabled: true,
		Brief: publicportal.NewBriefCompleter(publicportal.NewMySQLStore(db), publicportal.GatewayEnv{
			EncryptionKey: cfg.SettingsEncryptionKey,
			APIBase:       cfg.LiteLLMAPIBase,
			APIKey:        cfg.LiteLLMAPIKey,
			TimeoutMs:     cfg.LiteLLMTimeoutMs,
			MaxRetries:    cfg.LiteLLMMaxRetries,
		}),
		BriefLogs: llmlogs.NewCompletionWriter(db, mongoDatabase),
	}
	newsevents.Register(reg, db, mongoDatabase, redisClient, briefOptions)
	newsindicators.Register(reg, db)
	kgimpact.Register(reg, db, mongoDatabase, redisClient)
	knowledgegraph.Register(reg, db, redisClient)
	workspace.Register(reg, db, mongoDatabase, redisClient)
	if metadataService == nil {
		return nil, fmt.Errorf("api-go: GraphQL crawl metadata registration requires the metadata service")
	}
	graphqlcrawlmetadata.Register(reg, metadataService)
	settingscrawl.Register(reg, db, settingscrawl.Options{
		JWTSecret:     cfg.JWTSecret,
		StorageConfig: storageConfigReader,
		Mongo:         mongoDatabase,
		Redis:         redisClient,
	})
	itemReadService := itemsreading.NewService(itemsreading.Options{
		DB:                    db,
		Mongo:                 mongoDatabase,
		Redis:                 redisClient,
		ReadModelEnabled:      cfg.ItemsReadModelEnabled,
		VectorHardFailEnabled: cfg.ItemsVectorHardFailEnabled,
		Personalization:       newsbehavior.NewService(db, redisClient),
	})
	itemsgraphql.Register(reg, itemReadService, true)
	itemsgraphql.RegisterList(reg, itemReadService)

	// Write roots. The read registration above already added every shared model
	// set, so the write batches register only their own roots.
	if itemsIngestService == nil {
		return nil, fmt.Errorf("api-go: item/crawl GraphQL writes require the items ingest service")
	}
	writeItemReadService := itemsreading.NewService(itemsreading.Options{
		DB:               db,
		Mongo:            mongoDatabase,
		Redis:            redisClient,
		ReadModelEnabled: cfg.ItemsReadModelEnabled,
	})
	itemsingestgraphql.Register(reg, itemsIngestService, writeItemReadService)
	if economicService == nil {
		return nil, fmt.Errorf("api-go: economic-data GraphQL takeover requires the service")
	}
	economicdatagraphql.Register(reg, economicService)
	orgaccesswrite.Register(reg, db, redisClient)
	assistantwrite.Register(reg, assistantRunService)
	workspacewrite.Register(reg, db)
	alerts.RegisterRules(reg, db, alertqueue.New(redisClient))
	settingswrite.Register(reg, db, redisClient, settingswrite.Options{
		RateLimitSettingsCacheTTLSeconds: cfg.RateLimitSettingsCacheTTLSeconds,
	})
	graphqlcrawltaskwrite.Register(reg, crawlTaskService)
	newsindicatorwrite.Register(reg, db, redisClient)
	settingswrite.RegisterSourcePolicy(reg, db, redisClient)
	registerKnowledgeReview(reg, db, redisClient, true)
	if err := registerGraphQLRssTranslation(reg, cfg, db, redisClient, mongoDatabase); err != nil {
		return nil, err
	}
	if err := registerAnalysisRunMutations(reg, cfg, db, redisClient, mongoDatabase); err != nil {
		return nil, err
	}

	handler, err := graphqlread.NewHandler(graphqlread.Options{
		Registry:        reg,
		Authenticator:   authenticator,
		Limiter:         graphqlLimiter,
		Cache:           policy.NewResponseCache(redisClient),
		CORS:            cors.New(cfg.CorsOrigin),
		TrustProxy:      cfg.TrustProxy,
		APQEnabled:      cfg.GraphQLAPQEnabled,
		DepthLimit:      cfg.GraphQLDepthLimit,
		ComplexityLimit: cfg.GraphQLComplexity,
		CacheEnabled:    cfg.GraphQLCacheEnabled,
		CacheTTL:        cfg.GraphQLCacheTTL,
		ErrorRecorder:   exceptions.graphql,
	})
	if err != nil {
		return nil, err
	}
	gateway.Handle(graphqlread.StatsPath, handler.ServeStats)

	log.Printf("api-go: GraphQL executor under go (reads: news events, indicators, kg impact, knowledge graph, workspace, items, crawl metadata, settings/crawl; writes: org access, workspace, items/crawl, alert rules, settings, source policy, knowledge review, assistant, crawl task, economic, rss translation, analysis runs)")
	log.Printf("api-go: GraphQL org-access writes registered (%s)", strings.Join(orgaccesswrite.RegisteredMutations, ", "))
	log.Printf("api-go: GraphQL workspace writes registered (%s)", strings.Join(workspacewrite.RegisteredMutations, ", "))
	log.Printf("api-go: GraphQL item/crawl writes registered (%s)", strings.Join(itemsingestgraphql.RegisteredMutations, ", "))
	log.Printf("api-go: GraphQL settings writes registered (%s)", strings.Join(settingswrite.RegisteredMutations, ", "))
	if len(economicdatagraphql.RegisteredMutations) > 0 {
		log.Printf("api-go: GraphQL economic-data mutations registered (%s)", strings.Join(economicdatagraphql.RegisteredMutations, ", "))
	}
	return handler, nil
}
