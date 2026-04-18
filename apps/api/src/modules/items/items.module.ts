import { Module } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { QueueModule } from "../queue/queue.module";
import { SituationMonitorModule } from "../situation-monitor/situation-monitor.module";
import { SystemSettingsModule } from "../system-settings/system-settings.module";
import { UserNewsBehaviorModule } from "../user-news-behavior/user-news-behavior.module";

import { ItemsRssTranslationService } from "./items-rss-translation.service";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";

@Module({
  imports: [
    DatabaseModule,
    QueueModule,
    NewsPipelineModule,
    SituationMonitorModule,
    SystemSettingsModule,
    UserNewsBehaviorModule,
  ],
  providers: [ItemsService, ItemsRssTranslationService],
  controllers: [ItemsController],
  exports: [ItemsService, ItemsRssTranslationService]
})
export class ItemsModule {}
