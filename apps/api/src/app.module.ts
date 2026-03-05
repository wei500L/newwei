import {
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
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
import { ArchiveModule } from "./modules/archive/archive.module";
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
import { NewsEventsModule } from "./modules/news-events/news-events.module";
import { NewsAggregatorModule } from "./modules/news-aggregator/news-aggregator.module";
import { NewsIndicatorModule } from "./modules/news-indicator/news-indicator.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { ObservabilityModule } from "./modules/observability/observability.module";
import { QueueAdminModule } from "./modules/queue/queue-admin.module";
import { QueueModule } from "./modules/queue/queue.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { RealtimeSignalsModule } from "./modules/realtime-signals/realtime-signals.module";
import { SearchTelemetryModule } from "./modules/search-telemetry/search-telemetry.module";
import { SentimentModule } from "./modules/sentiment/sentiment.module";
import { SituationMonitorModule } from "./modules/situation-monitor/situation-monitor.module";
import { SystemSettingsModule } from "./modules/system-settings/system-settings.module";
import { UserDigestModule } from "./modules/user-digest/user-digest.module";
import { UserNewsBehaviorModule } from "./modules/user-news-behavior/user-news-behavior.module";
import { UserSettingsModule } from "./modules/user-settings/user-settings.module";
import { VectorModule } from "./modules/vector/vector.module";
import { WebSocketModule } from "./modules/websocket/websocket.module";

const scheduleEnabled = process.env.SCHEDULE_ENABLED !== "false";
const bullBoardEnabled = process.env.BULL_BOARD_ENABLED !== "false";

@Module({
  imports: [
    WinstonModule.forRoot({
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            nestWinstonModuleUtilities.format.nestLike("api", {
              colors: process.env.NODE_ENV !== "production",
            }),
          ),
        }),
      ],
    }),
    ...(scheduleEnabled ? [ScheduleModule.forRoot()] : []),
    ConfigModule,
    DatabaseModule,
    CacheModule,
    VectorModule,
    QueueModule,
    ...(bullBoardEnabled ? [QueueAdminModule] : []),
    AuthModule,
    AuditModule,
    RbacModule,
    ItemsModule,
    EmailModule,
    DashboardModule,
    CrawlModule,
    ArchiveModule,
    AkshareModule,
    AlertsModule,
    AnalysisModule,
    AssistantModule,
    RealtimeSignalsModule,
    SearchTelemetryModule,
    SituationMonitorModule,
    SentimentModule,
    SystemSettingsModule,
    UserSettingsModule,
    UserNewsBehaviorModule,
    UserDigestModule,
    NotificationsModule,
    ObservabilityModule,
    KnowledgeGraphModule,
    NewsEventsModule,
    NewsAggregatorModule,
    NewsIndicatorModule,
    WebSocketModule,
    ApiGraphqlModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TraceIdMiddleware)
      .forRoutes({ path: "*path", method: RequestMethod.ALL });
  }
}
