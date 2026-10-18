package settingscrawl

import (
	"database/sql"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// Permission names used by the twenty roots.
const (
	permissionSettingsManage      = "settings.manage"
	permissionDashboardsRead      = "dashboards.read"
	permissionItemsRead           = "items.read"
	permissionCrawlRead           = "crawl.read"
	permissionKnowledgeGraphApply = "knowledgegraph.review"
)

// Options configures Register.
type Options struct {
	// JWTSecret signs the crawl media asset URLs. The crawl detail root reuses
	// the crawl read/telemetry service, which needs the same secret the REST
	// route uses.
	JWTSecret string
	// StorageConfig resolves the storage configuration snapshot that signs S3
	// media URLs. The GraphQL crawlTask root builds its own crawl read service,
	// so it must receive the same runtime storage reader as the REST route;
	// without it the S3 previewUrl/downloadUrl members stay unset. A nil reader
	// is accepted (tests) and degrades to the documented "no S3 URL" branch.
	StorageConfig objectstorage.ConfigReader
	// Mongo is the dashboard Mongo database that stores crawl run logs.
	Mongo *mongo.Database
	// Redis is used by the source policy sync-status comparison only.
	Redis *redis.Client
	// Now overrides the clock. It exists for tests and must stay nil in
	// production.
	Now func() time.Time
}

// Register wires the twenty settings center, source policy, sync status,
// knowledge-graph evidence review queue and crawl task read roots together with
// every object type they project.
//
// The caller must only invoke Register when both API_GO_GRAPHQL_READ_MODE and
// API_GO_GRAPHQL_SETTINGS_CRAWL_READ_MODE are go. While the settings/crawl
// switch is legacy these roots are not registered, so any document selecting
// one of them fails closed into the NestJS legacy proxy as a whole.
func Register(reg *contract.Registry, db *sql.DB, options Options) {
	if reg == nil {
		panic("graphqlread: settingscrawl.Register requires a registry")
	}

	registerTypes(reg)

	st := &store{db: db, mongo: options.Mongo, redis: options.Redis, now: options.Now}
	settings := &settingsReader{s: st}
	policies := &policyReader{s: st, settings: settings}
	review := &reviewReader{s: st, settings: settings}
	crawl := newCrawlReader(db, st, options)

	registerSettingsRoots(reg, settings, policies)
	registerReviewRoot(reg, review)
	registerCrawlRoots(reg, crawl)
}

// newCrawlReader builds the crawl read service shared by the crawlTask root.
// It is the single construction point for the GraphQL route, so the GraphQL
// detail query injects exactly the same runtime storage configuration reader as
// the REST handler (without it the S3 previewUrl/downloadUrl members stay
// unset).
func newCrawlReader(db *sql.DB, st *store, options Options) *crawlReader {
	return &crawlReader{
		s: st,
		svc: crawlreadtelemetry.NewService(
			db, options.Redis, options.Mongo, options.JWTSecret, options.StorageConfig),
	}
}

// registerTypes records every GraphQL object type the twenty roots project. An
// unregistered nested type makes the whole operation fall back to NestJS, so
// the list must stay complete.
func registerTypes(reg *contract.Registry) {
	registerSettingsModelTypes(reg)
	registerPolicyAndCrawlTypes(reg)
}

// RegisterSettingsModelTypes records only the settings center object types, and
// registers no root. The settings write package returns these same models, so a
// deployment that runs the write mutations with the read executor still must
// register them exactly once. RegisterType is idempotent, but the write path
// calls this only when the settings/crawl read roots did not already register
// the models.
func RegisterSettingsModelTypes(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: settingscrawl.RegisterSettingsModelTypes requires a registry")
	}
	registerSettingsModelTypes(reg)
}

// registerSettingsModelTypes records the twenty settings center object types.
func registerSettingsModelTypes(reg *contract.Registry) {
	reg.RegisterType("RateLimitBucketModel", RateLimitBucketModel{})
	reg.RegisterType("RateLimitSettingsModel", RateLimitSettingsModel{})
	reg.RegisterType("EntityImpactGraphSettingsModel", EntityImpactGraphSettingsModel{})
	reg.RegisterType("KnowledgeGraphSettingsModel", KnowledgeGraphSettingsModel{})
	reg.RegisterType("NewsEventSettingsModel", NewsEventSettingsModel{})
	reg.RegisterType("NewsClassificationTaxonomyNodeModel", NewsClassificationTaxonomyNodeModel{})
	reg.RegisterType("NewsClassificationSettingsModel", NewsClassificationSettingsModel{})
	reg.RegisterType("ClassificationQualitySettingsModel", ClassificationQualitySettingsModel{})
	reg.RegisterType("NewsDedupeScopedThresholdModel", NewsDedupeScopedThresholdModel{})
	reg.RegisterType("NewsDedupeSettingsModel", NewsDedupeSettingsModel{})
	reg.RegisterType("NewsIndicatorSettingsModel", NewsIndicatorSettingsModel{})
	reg.RegisterType("AuthCacheSettingsModel", AuthCacheSettingsModel{})
	reg.RegisterType("CrawlClientSettingsModel", CrawlClientSettingsModel{})
	reg.RegisterType("AuditLogRetentionModel", AuditLogRetentionModel{})
	reg.RegisterType("NewsExtractionPreflightGateSettingsModel", NewsExtractionPreflightGateSettingsModel{})
	reg.RegisterType("NewsExtractionPostCleanGateSettingsModel", NewsExtractionPostCleanGateSettingsModel{})
	reg.RegisterType("NewsExtractionCapabilitiesSettingsModel", NewsExtractionCapabilitiesSettingsModel{})
	reg.RegisterType("NewsExtractionProvidersSettingsModel", NewsExtractionProvidersSettingsModel{})
	reg.RegisterType("NewsExtractionSettingsModel", NewsExtractionSettingsModel{})
	reg.RegisterType("NewsPromptConfigModel", NewsPromptConfigModel{})
}

// registerPolicyAndCrawlTypes records the source policy, knowledge-graph
// evidence review and crawl task object types, which only the read roots
// project.
func registerPolicyAndCrawlTypes(reg *contract.Registry) {
	reg.RegisterType("NewsEventSourcePolicyDeltaModel", NewsEventSourcePolicyDeltaModel{})
	reg.RegisterType("NewsEventSourcePolicyConflictModel", NewsEventSourcePolicyConflictModel{})
	reg.RegisterType("NewsEventSourceCategoryAuthorityDomainBoostModel", NewsEventSourceCategoryAuthorityDomainBoostModel{})
	reg.RegisterType("NewsEventSourceCategoryAuthorityRuleModel", NewsEventSourceCategoryAuthorityRuleModel{})
	reg.RegisterType("NewsEventSourcePolicyRevisionModel", NewsEventSourcePolicyRevisionModel{})
	reg.RegisterType("NewsEventSourcePolicySettingsModel", NewsEventSourcePolicySettingsModel{})
	reg.RegisterType("NewsEventSourcePolicyPresetSettingsModel", NewsEventSourcePolicyPresetSettingsModel{})
	reg.RegisterType("NewsEventSourcePolicyRevisionDiffModel", NewsEventSourcePolicyRevisionDiffModel{})
	reg.RegisterType("NewsEventSourcePolicySyncStatusModel", NewsEventSourcePolicySyncStatusModel{})

	reg.RegisterType("KnowledgeGraphNodeModel", KnowledgeGraphNodeModel{})
	reg.RegisterType("KnowledgeGraphReviewArticleModel", KnowledgeGraphReviewArticleModel{})
	reg.RegisterType("KnowledgeGraphReviewEdgeModel", KnowledgeGraphReviewEdgeModel{})
	reg.RegisterType("KnowledgeGraphEvidenceReviewItemModel", KnowledgeGraphEvidenceReviewItemModel{})

	reg.RegisterType("CrawlTaskEdge", CrawlTaskEdge{})
	reg.RegisterType("PageInfo", PageInfo{})
	reg.RegisterType("CrawlTaskConnection", CrawlTaskConnection{})
	reg.RegisterType("CrawlMemoryStatsModel", CrawlMemoryStatsModel{})
	reg.RegisterType("CrawlExecutionSummaryModel", CrawlExecutionSummaryModel{})
	reg.RegisterType("CrawlLinkModel", CrawlLinkModel{})
	reg.RegisterType("CrawlLinkBucketModel", CrawlLinkBucketModel{})
	reg.RegisterType("CrawlLinkStatsModel", CrawlLinkStatsModel{})
	reg.RegisterType("CrawlLinkAnalysisModel", CrawlLinkAnalysisModel{})
	reg.RegisterType("CrawlResultModel", CrawlResultModel{})
	reg.RegisterType("CrawlTaskModel", CrawlTaskModel{})
}

// registerSettingsRoots registers the sixteen settings roots, the three source
// policy roots and the sync-status root with their exact permissions.
func registerSettingsRoots(reg *contract.Registry, settings *settingsReader, policies *policyReader) {
	// Root 1 is admin gated, so the loader receives the identity.
	reg.RegisterRoot(contract.Root{
		Name:       "rateLimitSettings",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (RateLimitSettingsModel, error) {
			return settings.rateLimitSettings(ctx.Ctx, ctx.Identity)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "entityImpactGraphSettings",
		Permission: permissionDashboardsRead,
		Resolve: contract.Bind(func(ctx contract.Context) (EntityImpactGraphSettingsModel, error) {
			return settings.entityImpactGraphSettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "knowledgeGraphSettings",
		Permission: permissionDashboardsRead,
		Resolve: contract.Bind(func(ctx contract.Context) (KnowledgeGraphSettingsModel, error) {
			return settings.knowledgeGraphSettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsEventSettings",
		Permission: permissionDashboardsRead,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsEventSettingsModel, error) {
			return settings.newsEventSettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsEventSourcePolicy",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsEventSourcePolicySettingsModel, error) {
			if err := policies.s.assertSystemAdmin(ctx.Ctx, ctx.Identity); err != nil {
				return NewsEventSourcePolicySettingsModel{}, err
			}
			return policies.getPolicyDetails(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsEventSourcePolicyPresets",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsEventSourcePolicyPresetSettingsModel, error) {
			if err := policies.s.assertSystemAdmin(ctx.Ctx, ctx.Identity); err != nil {
				return NewsEventSourcePolicyPresetSettingsModel{}, err
			}
			return policies.getPolicyPreset(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsEventSourcePolicyRevisionDiff",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsEventSourcePolicyRevisionDiffModel, error) {
			if err := policies.s.assertSystemAdmin(ctx.Ctx, ctx.Identity); err != nil {
				return NewsEventSourcePolicyRevisionDiffModel{}, err
			}
			base, _ := contract.IntArg(ctx.Args, "baseRevision")
			target, _ := contract.IntArg(ctx.Args, "targetRevision")
			return policies.getRevisionDiff(ctx.Ctx, ctx.Identity.OrgID, base, target)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsClassificationSettings",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsClassificationSettingsModel, error) {
			if err := policies.s.assertSystemAdmin(ctx.Ctx, ctx.Identity); err != nil {
				return NewsClassificationSettingsModel{}, err
			}
			return settings.newsClassificationSettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "classificationQualitySettings",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (ClassificationQualitySettingsModel, error) {
			if err := policies.s.assertSystemAdmin(ctx.Ctx, ctx.Identity); err != nil {
				return ClassificationQualitySettingsModel{}, err
			}
			return settings.classificationQualitySettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsDedupeSettings",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsDedupeSettingsModel, error) {
			if err := policies.s.assertSystemAdmin(ctx.Ctx, ctx.Identity); err != nil {
				return NewsDedupeSettingsModel{}, err
			}
			return settings.newsDedupeSettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsIndicatorSettings",
		Permission: permissionDashboardsRead,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsIndicatorSettingsModel, error) {
			return settings.newsIndicatorSettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "authCacheSettings",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (AuthCacheSettingsModel, error) {
			return settings.authCacheSettings(ctx.Ctx, ctx.Identity)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "crawlClientSettings",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (CrawlClientSettingsModel, error) {
			return settings.crawlClientSettings(ctx.Ctx, ctx.Identity)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "auditLogRetention",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (AuditLogRetentionModel, error) {
			return settings.auditLogRetention(ctx.Ctx, ctx.Identity)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsExtractionSettings",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsExtractionSettingsModel, error) {
			if err := policies.s.assertSystemAdmin(ctx.Ctx, ctx.Identity); err != nil {
				return NewsExtractionSettingsModel{}, err
			}
			return settings.newsExtractionSettings(ctx.Ctx, ctx.Identity.OrgID)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsPromptConfig",
		Permission: permissionSettingsManage,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsPromptConfigModel, error) {
			return settings.newsPromptConfig(ctx.Ctx, ctx.Identity)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "newsEventSourcePolicySyncStatus",
		Permission: permissionItemsRead,
		Resolve: contract.Bind(func(ctx contract.Context) (NewsEventSourcePolicySyncStatusModel, error) {
			return policies.getSyncStatus(ctx.Ctx, ctx.Identity)
		}),
	})
}

// registerReviewRoot registers the knowledge-graph evidence review queue. The
// root accepts either permission, matching the NestJS @Permissions decorator
// with mode "any".
func registerReviewRoot(reg *contract.Registry, review *reviewReader) {
	reg.RegisterRoot(contract.Root{
		Name:           "knowledgeGraphEvidenceReviewQueue",
		AnyPermissions: []string{permissionSettingsManage, permissionKnowledgeGraphApply},
		Resolve: contract.Bind(func(ctx contract.Context) ([]KnowledgeGraphEvidenceReviewItemModel, error) {
			return review.evidenceReviewQueue(
				ctx.Ctx,
				ctx.Identity,
				intArgPtr(ctx, "limit"),
				floatArgPtr(ctx, "maxConfidence"),
				boolArgPtr(ctx, "onlyUnreviewed"),
			)
		}),
	})
}

// registerCrawlRoots registers the crawl task list and detail roots. The
// executor does not apply SDL argument defaults, so the resolver applies the
// documented 20/20 defaults itself.
func registerCrawlRoots(reg *contract.Registry, crawl *crawlReader) {
	reg.RegisterRoot(contract.Root{
		Name:       "crawlTasks",
		Permission: permissionCrawlRead,
		Resolve: contract.Bind(func(ctx contract.Context) (CrawlTaskConnection, error) {
			first := 20
			if value, ok := contract.IntArg(ctx.Args, "first"); ok {
				first = value
			}
			return crawl.crawlTasks(
				ctx.Ctx,
				ctx.Identity,
				first,
				stringArgPtr(ctx, "after"),
				stringArgPtr(ctx, "search"),
				stringArgPtr(ctx, "status"),
			)
		}),
	})
	reg.RegisterRoot(contract.Root{
		Name:       "crawlTask",
		Permission: permissionCrawlRead,
		Resolve: contract.Bind(func(ctx contract.Context) (*CrawlTaskModel, error) {
			id, _ := contract.StringArg(ctx.Args, "id")
			resultLimit := 20
			if value, ok := contract.IntArg(ctx.Args, "resultLimit"); ok {
				resultLimit = value
			}
			return crawl.crawlTask(ctx.Ctx, ctx.Identity, id, resultLimit, stringArgPtr(ctx, "resultSearch"))
		}),
	})
}

// stringArgPtr returns a pointer for a present string argument and nil for an
// absent or explicit null argument. The executor's argument map is the only
// untyped boundary this package touches; every model and stored document stays
// strongly typed.
func stringArgPtr(ctx contract.Context, name string) *string {
	text, ok := contract.StringArg(ctx.Args, name)
	if !ok {
		return nil
	}
	return &text
}

// intArgPtr returns a pointer for a present integer argument.
func intArgPtr(ctx contract.Context, name string) *int {
	number, ok := contract.IntArg(ctx.Args, name)
	if !ok {
		return nil
	}
	return &number
}

// floatArgPtr returns a pointer for a present float argument.
func floatArgPtr(ctx contract.Context, name string) *float64 {
	value, state := contract.Lookup(ctx.Args, name)
	if state != contract.ArgValue {
		return nil
	}
	number, ok := contract.AsFloat(value)
	if !ok {
		return nil
	}
	return &number
}

// boolArgPtr returns a pointer for a present boolean argument.
func boolArgPtr(ctx contract.Context, name string) *bool {
	value, state := contract.Lookup(ctx.Args, name)
	if state != contract.ArgValue {
		return nil
	}
	boolean, ok := value.(bool)
	if !ok {
		return nil
	}
	return &boolean
}
