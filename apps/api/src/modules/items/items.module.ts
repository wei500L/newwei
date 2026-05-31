import { Module } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { QueueModule } from "../queue/queue.module";
import { SituationMonitorModule } from "../situation-monitor/situation-monitor.module";
import { SystemSettingsModule } from "../system-settings/system-settings.module";
import { UserNewsBehaviorModule } from "../user-news-behavior/user-news-behavior.module";

import { ItemsRssTranslationService } from "./items-rss-translation.service";
import { ItemsElasticsearchService } from "./items-elasticsearch.service";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";
import { SearchAdminController } from "./search-admin.controller";

@Module({
  imports: [
    DatabaseModule,
    QueueModule,
    NewsPipelineModule,
    SituationMonitorModule,
    SystemSettingsModule,
    UserNewsBehaviorModule,
  ],
  providers: [ItemsService, ItemsRssTranslationService, ItemsElasticsearchService],
  controllers: [ItemsController, SearchAdminController],
  exports: [ItemsService, ItemsRssTranslationService, ItemsElasticsearchService]
})
export class ItemsModule {}
