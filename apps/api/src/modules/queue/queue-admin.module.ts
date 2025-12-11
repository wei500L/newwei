import { Module } from "@nestjs/common";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import { CrawlModule } from "../crawl/crawl.module";
import { CRAWL_QUEUE_NAME } from "../crawl/crawl.constants";
import { AkshareModule } from "../akshare/akshare.module";
import { AKSHARE_QUEUE_NAME } from "../akshare/akshare.constants";
import { AnalysisModule } from "../analysis/analysis.module";
import { ANALYSIS_QUEUE_NAME } from "../analysis/analysis.constants";
import { AlertsModule } from "../alerts/alerts.module";
import { ALERTS_QUEUE_NAME } from "../alerts/alerts.constants";

import { ITEM_PIPELINE_QUEUE_NAME, QueueModule } from "./queue.module";

@Module({
  imports: [
    QueueModule,
    CrawlModule,
    AkshareModule,
    AnalysisModule,
    AlertsModule,
    BullBoardModule.forRoot({
      route: "/admin/queues",
      adapter: ExpressAdapter,
      middleware: []
    }),
    BullBoardModule.forFeature(
      { name: ITEM_PIPELINE_QUEUE_NAME, adapter: BullMQAdapter },
      { name: CRAWL_QUEUE_NAME, adapter: BullMQAdapter },
      { name: AKSHARE_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ANALYSIS_QUEUE_NAME, adapter: BullMQAdapter },
      { name: ALERTS_QUEUE_NAME, adapter: BullMQAdapter }
    )
  ]
})
export class QueueAdminModule {}
