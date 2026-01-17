import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { WinstonModule } from "nest-winston";
import { utilities as nestWinstonModuleUtilities } from "nest-winston/dist/winston.utilities";
import * as winston from "winston";

import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { PermissionsGuard } from "./common/guards/permissions.guard";
import { TraceIdMiddleware } from "./common/middleware/trace-id.middleware";
import { ApiGraphqlModule } from "./graphql/graphql.module";
import { AkshareModule } from "./modules/akshare/akshare.module";
import { AlertsModule } from "./modules/alerts/alerts.module";
import { AnalysisModule } from "./modules/analysis/analysis.module";
import { AssistantModule } from "./modules/assistant/assistant.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CacheModule } from "./modules/cache/cache.module";
import { ConfigModule } from "./modules/config/config.module";
import { DatabaseModule } from "./modules/config/database.module";
import { CrawlModule } from "./modules/crawl/crawl.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { EmailModule } from "./modules/email/email.module";
import { HealthModule } from "./modules/health/health.module";
import { ItemsModule } from "./modules/items/items.module";
import { KnowledgeGraphModule } from "./modules/knowledge-graph/knowledge-graph.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { ObservabilityModule } from "./modules/observability/observability.module";
import { QueueAdminModule } from "./modules/queue/queue-admin.module";
import { QueueModule } from "./modules/queue/queue.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { SystemSettingsModule } from "./modules/system-settings/system-settings.module";
import { VectorModule } from "./modules/vector/vector.module";
import { WebSocketModule } from "./modules/websocket/websocket.module";

@Module({
  imports: [
    WinstonModule.forRoot({
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            nestWinstonModuleUtilities.format.nestLike("api", {
              colors: process.env.NODE_ENV !== "production"
            })
          )
        })
      ]
    }),
    ScheduleModule.forRoot(),
    ConfigModule,
    DatabaseModule,
    CacheModule,
    VectorModule,
    QueueModule,
    QueueAdminModule,
    AuthModule,
    AuditModule,
    RbacModule,
    ItemsModule,
    EmailModule,
    DashboardModule,
    CrawlModule,
    AkshareModule,
    AlertsModule,
    AnalysisModule,
    AssistantModule,
    SystemSettingsModule,
    NotificationsModule,
    ObservabilityModule,
    KnowledgeGraphModule,
    WebSocketModule,
    ApiGraphqlModule,
    HealthModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter
    }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceIdMiddleware).forRoutes("*");
  }
}
