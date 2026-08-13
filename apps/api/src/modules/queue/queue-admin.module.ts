import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { BullBoardModule } from "@bull-board/nestjs";
import { Module } from "@nestjs/common";

import { AKSHARE_QUEUE_NAME } from "../akshare/akshare.constants";
import { AkshareModule } from "../akshare/akshare.module";
import { ALERTS_QUEUE_NAME } from "../alerts/alerts.constants";
import { AlertsModule } from "../alerts/alerts.module";
import { ANALYSIS_QUEUE_NAME } from "../analysis/analysis.constants";
import { AnalysisModule } from "../analysis/analysis.module";
import { ASSISTANT_QUEUE_NAME } from "../assistant/assistant.constants";
import { AssistantModule } from "../assistant/assistant.module";
import { AccessTokenBlacklistService } from "../auth/access-token-blacklist.service";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { CRAWL_QUEUE_HOT_NAME, CRAWL_QUEUE_NAME, CRAWL_QUEUE_NORMAL_NAME } from "../crawl/crawl.constants";
import { CrawlModule } from "../crawl/crawl.module";
import { NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME } from "../news-events/news-event-clustering-recovery.constants";
import { NewsEventsModule } from "../news-events/news-events.module";
import { SITUATION_MONITOR_SIGNALS_QUEUE_NAME } from "../situation-monitor/signals/situation-monitor-signals.constants";
import { SituationMonitorSignalsModule } from "../situation-monitor/signals/situation-monitor-signals.module";

import { createBullBoardAuthMiddleware } from "./bull-board-auth.middleware";
import { ITEM_PIPELINE_DLQ_QUEUE_NAME, ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";
import { QueueModule } from "./queue.module";

@Module({
  imports: [
    QueueModule,
    CrawlModule,
    AkshareModule,
    AnalysisModule,
    AssistantModule,
    AlertsModule,
    NewsEventsModule,
    SituationMonitorSignalsModule,
    AuthModule,
    BullBoardModule.forRootAsync({
      inject: [EnvService, AuthService, AccessTokenBlacklistService],
      useFactory: (
        env: EnvService,
        authService: AuthService,
        accessTokenBlacklist: AccessTokenBlacklistService,
      ) => ({
        route: "/admin/queues",
        adapter: ExpressAdapter,
        middleware: [
          createBullBoardAuthMiddleware(env, authService, accessTokenBlacklist),
        ],
      }),
    }),
    BullBoardModule.forFeature(
      { name: ITEM_PIPELINE_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ITEM_PIPELINE_DLQ_QUEUE_NAME, adapter: BullMQAdapter },
      { name: CRAWL_QUEUE_NAME, adapter: BullMQAdapter },
      { name: CRAWL_QUEUE_HOT_NAME, adapter: BullMQAdapter },
      { name: CRAWL_QUEUE_NORMAL_NAME, adapter: BullMQAdapter },
      { name: AKSHARE_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ANALYSIS_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ASSISTANT_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ALERTS_QUEUE_NAME, adapter: BullMQAdapter },
      { name: NEWS_EVENT_CLUSTERING_RECOVERY_QUEUE_NAME, adapter: BullMQAdapter },
      { name: SITUATION_MONITOR_SIGNALS_QUEUE_NAME, adapter: BullMQAdapter },
    )
  ]
})
export class QueueAdminModule {}
