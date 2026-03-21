import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module";
import { ItemsModule } from "../items/items.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { UserSettingsModule } from "../user-settings/user-settings.module";

import { NewsAggregatorController } from "./news-aggregator.controller"
import { NewsnowGateway } from "./newsnow.gateway";
import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import { NewsAggregatorService } from "./news-aggregator.service"
import { NewsnowDomesticOpinionIndexService } from "./newsnow-domestic-opinion-index.service";
import { NewsnowActiveSourceRegistryService } from "./newsnow-active-source-registry.service";
import { NewsnowHottestAnalysisSchedulerService } from "./newsnow-hottest-analysis.scheduler.service";
import { NewsnowHottestAnalysisService } from "./newsnow-hottest-analysis.service";
import { NewsnowRealtimeDispatcher } from "./newsnow-realtime.dispatcher";
import { NewsnowSourceWarmSchedulerService } from "./newsnow-source-warm.scheduler.service";

@Module({
  imports: [AuthModule, UserSettingsModule, NewsPipelineModule, ItemsModule],
  controllers: [NewsAggregatorController],
  providers: [
    NewsAggregatorRegistryService,
    NewsAggregatorService,
    NewsnowDomesticOpinionIndexService,
    NewsnowActiveSourceRegistryService,
    NewsnowHottestAnalysisSchedulerService,
    NewsnowHottestAnalysisService,
    NewsnowRealtimeDispatcher,
    NewsnowSourceWarmSchedulerService,
    NewsnowGateway,
  ],
  exports: [
    NewsAggregatorRegistryService,
    NewsAggregatorService,
    NewsnowDomesticOpinionIndexService,
    NewsnowActiveSourceRegistryService,
    NewsnowHottestAnalysisService,
    NewsnowRealtimeDispatcher,
  ],
})
export class NewsAggregatorModule {}
