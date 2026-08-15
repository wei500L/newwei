import { Module, forwardRef } from "@nestjs/common";

import { DatabaseModule } from "../config/database.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { QueueModule } from "../queue/queue.module";
import { SituationMonitorModule } from "../situation-monitor/situation-monitor.module";
import { SystemSettingsModule } from "../system-settings/system-settings.module";
import { UserNewsBehaviorModule } from "../user-news-behavior/user-news-behavior.module";

import { ItemsElasticsearchService } from "./items-elasticsearch.service";
import { ItemsGroupingService } from "./items-grouping.service";
import { ItemsIngestService } from "./items-ingest.service";
import { ItemsListService } from "./items-list.service";
import { ItemsReadModelService } from "./items-read-model.service";
import { ItemsRssTranslationService } from "./items-rss-translation.service";
import { ItemsSearchQueryService } from "./items-search-query.service";
import { ItemsSearchService } from "./items-search.service";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";
import { RawItemOutboxService } from "./raw-item-outbox.service";
import { SearchAdminController } from "./search-admin.controller";
import { SearchReindexJobStore } from "./search-reindex-job.store";
import { SearchReindexService } from "./search-reindex.service";

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => QueueModule),
    NewsPipelineModule,
    SituationMonitorModule,
    SystemSettingsModule,
    UserNewsBehaviorModule,
  ],
  providers: [
    ItemsService,
    ItemsReadModelService,
    ItemsIngestService,
    ItemsListService,
    ItemsSearchQueryService,
    ItemsSearchService,
    ItemsGroupingService,
    RawItemOutboxService,
    ItemsRssTranslationService,
    ItemsElasticsearchService,
    SearchReindexJobStore,
    SearchReindexService,
  ],
  controllers: [ItemsController, SearchAdminController],
  exports: [
    ItemsService,
    RawItemOutboxService,
    ItemsRssTranslationService,
    ItemsElasticsearchService,
  ],
})
export class ItemsModule {}
