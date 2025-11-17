import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { join } from "node:path";
import depthLimit from "graphql-depth-limit";
import { createComplexityLimitRule } from "graphql-query-complexity";
import { GraphQLDirective, DirectiveLocation, GraphQLNonNull, GraphQLString } from "graphql";
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
import { DataloaderModule, DataloaderInterceptor } from "nestjs-dataloader";
import { AlertsModule } from "../modules/alerts/alerts.module";
import { AnalysisModule } from "../modules/analysis/analysis.module";
import { UsersResolver } from "./resolvers/user.resolver";
import { ItemsResolver } from "./resolvers/items.resolver";
import { RbacResolver } from "./resolvers/rbac.resolver";
import { DashboardResolver } from "./resolvers/dashboard.resolver";
import { CrawlResolver } from "./resolvers/crawl.resolver";
import { EconomicDataResolver } from "./resolvers/economic-data.resolver";
import { AlertsResolver } from "./resolvers/alerts.resolver";
import { AnalysisResolver } from "./resolvers/analysis.resolver";
import { UserLoader } from "./loaders/user.loader";
import { RoleLoader } from "./loaders/role.loader";
import { ItemMetaLoader } from "./loaders/item-meta.loader";
import { RawItemLoader } from "./loaders/raw-item.loader";
import { ProcessedItemLoader } from "./loaders/processed-item.loader";
import { QueueEventPublisher } from "./queue-event.publisher";
import { GraphqlRateLimitGuard } from "./guards/graphql-rate-limit.guard";
import { GraphQLJSONScalar } from "./scalars/json.scalar";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { GqlAuthGuard } from "../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../common/guards/gql-permissions.guard";

const logger = createLogger({ name: "graphql" });

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
    DataloaderModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
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

        const corsOrigin = cfg.corsOrigin ? cfg.corsOrigin.split(",") : true;

        return {
          driver: ApolloDriver,
          autoSchemaFile: join(process.cwd(), "apps/api/schema.gql"),
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
            directives: [hasPermissionDirective]
          },
          validationRules: [
            depthLimit(cfg.depthLimit),
            createComplexityLimitRule(cfg.complexityLimit, {
              onComplete: (complexity: number) => {
                logger.debug({ complexity }, "GraphQL query complexity evaluated");
              }
            })
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
    GraphQLJSONScalar,
    UserLoader,
    RoleLoader,
    ItemMetaLoader,
    RawItemLoader,
    ProcessedItemLoader,
    QueueEventPublisher,
    GqlAuthGuard,
    GqlPermissionsGuard,
    {
      provide: APP_INTERCEPTOR,
      useClass: DataloaderInterceptor
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
