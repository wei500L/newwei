import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { join } from "node:path";
import depthLimit from "graphql-depth-limit";
import {
  type ComplexityEstimator,
  createComplexityDirective,
  directiveEstimator,
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from "graphql-query-complexity";
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
import { EnvService } from "../modules/config/config.service";
import { ConfigModule } from "../modules/config/config.module";
import { createLogger } from "@modular/utils";
import { ItemsModule } from "../modules/items/items.module";
import { AuthModule } from "../modules/auth/auth.module";
import { RbacModule } from "../modules/rbac/rbac.module";
import { DashboardModule } from "../modules/dashboard/dashboard.module";
import { QueueModule } from "../modules/queue/queue.module";
import { CacheModule } from "../modules/cache/cache.module";
import { CrawlModule } from "../modules/crawl/crawl.module";
import { DataLoaderInterceptor } from "nestjs-dataloader";
import { AlertsModule } from "../modules/alerts/alerts.module";
import { AnalysisModule } from "../modules/analysis/analysis.module";
import { AkshareModule } from "../modules/akshare/akshare.module";
import { NewsPipelineModule } from "../modules/news-pipeline/news-pipeline.module";
import { NotificationsModule } from "../modules/notifications/notifications.module";
import { OrgModule } from "../modules/org/org.module";
import { UsersResolver } from "./resolvers/user.resolver";
import { ItemsResolver } from "./resolvers/items.resolver";
import { RbacResolver } from "./resolvers/rbac.resolver";
import { DashboardResolver } from "./resolvers/dashboard.resolver";
import { CrawlResolver } from "./resolvers/crawl.resolver";
import { EconomicDataResolver } from "./resolvers/economic-data.resolver";
import { AlertsResolver } from "./resolvers/alerts.resolver";
import { AnalysisResolver } from "./resolvers/analysis.resolver";
import { SettingsResolver } from "./resolvers/settings.resolver";
import { NotificationResolver } from "./resolvers/notification.resolver";
import { OrgResolver } from "./resolvers/org.resolver";
import { UserLoader } from "./loaders/user.loader";
import { RoleLoader } from "./loaders/role.loader";
import { ItemMetaLoader } from "./loaders/item-meta.loader";
import { RawItemLoader } from "./loaders/raw-item.loader";
import { ProcessedItemLoader } from "./loaders/processed-item.loader";
import { GraphqlRateLimitGuard } from "./guards/graphql-rate-limit.guard";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { GqlAuthGuard } from "../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../common/guards/gql-permissions.guard";

const logger = createLogger({ name: "graphql" });

const BASE_FIELD_COMPLEXITY = 1;
const COMPOSITE_FIELD_COMPLEXITY = 2;

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
    QueueModule,
    CacheModule,
    CrawlModule,
    AlertsModule,
    AnalysisModule,
    AkshareModule,
    NotificationsModule,
    NewsPipelineModule,
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

        const corsOrigin = cfg.corsOrigin ? cfg.corsOrigin.split(",") : true;

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
          context: ({ req, res, extra }) => {
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
          subscriptions: {
            "graphql-ws": {
              onConnect: (context) => {
                const { connectionParams, extra } = context;
                extra.request = {
                  headers: connectionParams ?? {},
                  ip: extra?.socket?.remoteAddress
                } as any;
              }
            }
          },
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
                  didResolveOperation(requestContext) {
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
            }
          ]
        };
      }
    })
  ],
  providers: [
    UsersResolver,
    ItemsResolver,
    RbacResolver,
    DashboardResolver,
    CrawlResolver,
    EconomicDataResolver,
    AlertsResolver,
    AnalysisResolver,
    NotificationResolver,
    SettingsResolver,
    OrgResolver,
    UserLoader,
    RoleLoader,
    ItemMetaLoader,
    RawItemLoader,
    ProcessedItemLoader,
    GqlAuthGuard,
    GqlPermissionsGuard,
    {
      provide: APP_INTERCEPTOR,
      useClass: DataLoaderInterceptor
    },
    {
      provide: APP_GUARD,
      useClass: GqlAuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: GqlPermissionsGuard
    },
    {
      provide: APP_GUARD,
      useClass: GraphqlRateLimitGuard
    }
  ]
})
export class ApiGraphqlModule {}
