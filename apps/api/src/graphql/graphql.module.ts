import type { ApolloServerPlugin } from "@apollo/server";
import { createLogger } from "@modular/utils";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { GraphQLModule } from "@nestjs/graphql";
import {
  DirectiveLocation,
  GraphQLError,
  GraphQLDirective,
  GraphQLNonNull,
  GraphQLString,
  getNamedType,
  isCompositeType,
  isEnumType,
  isScalarType,
} from "graphql";
import depthLimit from "graphql-depth-limit";
import {
  type ComplexityEstimator,
  createComplexityDirective,
  directiveEstimator,
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from "graphql-query-complexity";
import { DataLoaderInterceptor } from "nestjs-dataloader";
import { join } from "node:path";

import { GqlAuthGuard } from "../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../common/guards/gql-permissions.guard";
import { AkshareModule } from "../modules/akshare/akshare.module";
import { AlertsModule } from "../modules/alerts/alerts.module";
import { AnalysisModule } from "../modules/analysis/analysis.module";
import { AssistantModule } from "../modules/assistant/assistant.module";
import { AuthModule } from "../modules/auth/auth.module";
import { CacheModule } from "../modules/cache/cache.module";
import { ConfigModule } from "../modules/config/config.module";
import { EnvService } from "../modules/config/config.service";
import { CrawlModule } from "../modules/crawl/crawl.module";
import { DashboardModule } from "../modules/dashboard/dashboard.module";
import { ItemsModule } from "../modules/items/items.module";
import { KnowledgeGraphModule } from "../modules/knowledge-graph/knowledge-graph.module";
import { NewsEventsModule } from "../modules/news-events/news-events.module";
import { NewsIndicatorModule } from "../modules/news-indicator/news-indicator.module";
import { NewsPipelineModule } from "../modules/news-pipeline/news-pipeline.module";
import { NotificationsModule } from "../modules/notifications/notifications.module";
import { OrgModule } from "../modules/org/org.module";
import { QueueModule } from "../modules/queue/queue.module";
import { RbacModule } from "../modules/rbac/rbac.module";
import { SentimentModule } from "../modules/sentiment/sentiment.module";

import { GraphqlRateLimitGuard } from "./guards/graphql-rate-limit.guard";
import { ItemMetaLoader } from "./loaders/item-meta.loader";
import { ProcessedItemPreviewLoader } from "./loaders/processed-item-preview.loader";
import { ProcessedItemLoader } from "./loaders/processed-item.loader";
import { RawItemPreviewLoader } from "./loaders/raw-item-preview.loader";
import { RawItemLoader } from "./loaders/raw-item.loader";
import { RoleLoader } from "./loaders/role.loader";
import { UserLoader } from "./loaders/user.loader";
import { AlertsResolver } from "./resolvers/alerts.resolver";
import { AnalysisResolver } from "./resolvers/analysis.resolver";
import { AssistantResolver } from "./resolvers/assistant.resolver";
import { CrawlResolver } from "./resolvers/crawl.resolver";
import { DashboardResolver } from "./resolvers/dashboard.resolver";
import { EconomicDataResolver } from "./resolvers/economic-data.resolver";
import { EntityImpactGraphResolver } from "./resolvers/entity-impact-graph.resolver";
import { ItemsResolver } from "./resolvers/items.resolver";
import { KnowledgeGraphImpactResolver } from "./resolvers/knowledge-graph-impact.resolver";
import { KnowledgeGraphReviewResolver } from "./resolvers/knowledge-graph-review.resolver";
import { KnowledgeGraphResolver } from "./resolvers/knowledge-graph.resolver";
import { NewsEventsResolver } from "./resolvers/news-events.resolver";
import { NewsIndicatorResolver } from "./resolvers/news-indicator.resolver";
import { NotificationResolver } from "./resolvers/notification.resolver";
import { OrgResolver } from "./resolvers/org.resolver";
import { RbacResolver } from "./resolvers/rbac.resolver";
import { SentimentResolver } from "./resolvers/sentiment.resolver";
import { SettingsResolver } from "./resolvers/settings.resolver";
import { TopicsResolver } from "./resolvers/topics.resolver";
import { UsersResolver } from "./resolvers/user.resolver";

const logger = createLogger({ name: "graphql" });

const BASE_FIELD_COMPLEXITY = 1;
const COMPOSITE_FIELD_COMPLEXITY = 2;

interface GraphqlContextFactoryArgs {
  req?: any;
  res?: any;
  extra?: any;
}

const paginationComplexityEstimator: ComplexityEstimator = ({ args, childComplexity }) => {
  const pageSize =
    typeof args.first === "number"
      ? args.first
      : typeof args.last === "number"
        ? args.last
        : typeof args.take === "number"
          ? args.take
          : typeof args.limit === "number"
            ? args.limit
            : typeof args.pageSize === "number"
              ? args.pageSize
              : typeof args.perPage === "number"
                ? args.perPage
                : undefined;

  if (typeof pageSize !== "number" || childComplexity <= 0) {
    return;
  }

  return BASE_FIELD_COMPLEXITY + childComplexity * Math.max(0, pageSize);
};

const compositeFieldComplexityEstimator: ComplexityEstimator = ({ field, childComplexity }) => {
  const namedType = getNamedType(field.type);
  if (isScalarType(namedType) || isEnumType(namedType)) {
    return;
  }
  if (!isCompositeType(namedType)) {
    return;
  }
  return COMPOSITE_FIELD_COMPLEXITY + childComplexity;
};

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    ItemsModule,
    RbacModule,
    DashboardModule,
	    KnowledgeGraphModule,
      NewsEventsModule,
      NewsIndicatorModule,
	    QueueModule,
	    CacheModule,
	    CrawlModule,
    AlertsModule,
    AnalysisModule,
    AssistantModule,
    AkshareModule,
    NotificationsModule,
    NewsPipelineModule,
    SentimentModule,
    OrgModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [EnvService],
      useFactory: async (env: EnvService) => {
        const cfg = env.graphqlConfig;
        const hasPermissionDirective = new GraphQLDirective({
          name: "hasPermission",
          locations: [DirectiveLocation.FIELD_DEFINITION, DirectiveLocation.OBJECT],
          args: {
            name: { type: new GraphQLNonNull(GraphQLString) }
          }
        });
        const complexityDirective = createComplexityDirective();

        const corsOrigin = cfg.corsOrigin
          ? cfg.corsOrigin.split(",").map((entry) => entry.trim()).filter(Boolean)
          : true;

        const estimators: ComplexityEstimator[] = [
          fieldExtensionsEstimator(),
          directiveEstimator(),
          paginationComplexityEstimator,
          compositeFieldComplexityEstimator,
          simpleEstimator({ defaultComplexity: BASE_FIELD_COMPLEXITY })
        ];

        return {
          autoSchemaFile: join(__dirname, "..", "..", "schema.gql"),
          sortSchema: true,
          csrfPrevention: true,
          playground: cfg.playground,
          introspection: cfg.introspection,
          context: ({ req, res, extra }: GraphqlContextFactoryArgs) => {
            const request =
              req ??
              extra?.request ?? {
                headers: extra?.connectionParams ?? {},
                ip: extra?.socket?.remoteAddress
              };
            return {
              req: request,
              res,
              user: request.user,
              connectionParams: extra?.connectionParams
            };
          },
          cors: {
            credentials: true,
            origin: corsOrigin
          },
          ...(cfg.subscriptionsEnabled
            ? {
                subscriptions: {
                  "graphql-ws": {
                    onConnect: (context: { connectionParams?: unknown; extra: any }) => {
                      const { connectionParams, extra } = context;
                      extra.request = {
                        headers: connectionParams ?? {},
                        ip: extra?.socket?.remoteAddress
                      } as { headers: Record<string, unknown>; ip?: string };
                    }
                  }
                }
              }
            : {}),
          buildSchemaOptions: {
            directives: [hasPermissionDirective, complexityDirective]
          },
          validationRules: [
            depthLimit(cfg.depthLimit)
          ],
          plugins: [
            {
              async requestDidStart() {
                return {
                  async didResolveOperation(requestContext) {
                    const complexity = getComplexity({
                      schema: requestContext.schema,
                      query: requestContext.document,
                      variables: requestContext.request.variables,
                      operationName: requestContext.request.operationName,
                      estimators
                    });

                    logger.debug({ complexity }, "GraphQL query complexity evaluated");

                    if (complexity > cfg.complexityLimit) {
                      throw new GraphQLError(
                        `Query is too complex: ${complexity}. Maximum allowed complexity: ${cfg.complexityLimit}`,
                        { extensions: { code: "QUERY_TOO_COMPLEX", complexity } }
                      );
                    }
                  }
                };
              }
            } satisfies ApolloServerPlugin
          ]
        };
      }
    })
  ],
  providers: [
    UsersResolver,
    ItemsResolver,
    TopicsResolver,
    NewsEventsResolver,
    NewsIndicatorResolver,
    RbacResolver,
    DashboardResolver,
    CrawlResolver,
    EconomicDataResolver,
    EntityImpactGraphResolver,
    KnowledgeGraphResolver,
    KnowledgeGraphImpactResolver,
    KnowledgeGraphReviewResolver,
    AlertsResolver,
    AnalysisResolver,
    AssistantResolver,
    NotificationResolver,
    SettingsResolver,
    SentimentResolver,
    OrgResolver,
    UserLoader,
    RoleLoader,
    ItemMetaLoader,
    RawItemLoader,
    RawItemPreviewLoader,
    ProcessedItemLoader,
    ProcessedItemPreviewLoader,
    GqlAuthGuard,
    GqlPermissionsGuard,
    GraphqlRateLimitGuard,
    {
      provide: APP_INTERCEPTOR,
      useClass: DataLoaderInterceptor
    },
    {
      provide: APP_GUARD,
      useExisting: GqlAuthGuard
    },
    {
      provide: APP_GUARD,
      useExisting: GqlPermissionsGuard
    },
    {
      provide: APP_GUARD,
      useExisting: GraphqlRateLimitGuard
    }
  ]
})
export class ApiGraphqlModule {}
