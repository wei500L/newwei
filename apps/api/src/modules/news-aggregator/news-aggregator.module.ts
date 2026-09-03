import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module";
import { ItemsModule } from "../items/items.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { UserNewsBehaviorModule } from "../user-news-behavior/user-news-behavior.module";
import { UserSettingsModule } from "../user-settings/user-settings.module";

import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import { NewsAggregatorController } from "./news-aggregator.controller"
import { NewsAggregatorService } from "./news-aggregator.service"
import { NewsnowActiveSourceRegistryService } from "./newsnow-active-source-registry.service";
import { NewsnowDomesticOpinionIndexService } from "./newsnow-domestic-opinion-index.service";
import { NewsnowHottestAnalysisSchedulerService } from "./newsnow-hottest-analysis.scheduler.service";
import { NewsnowHottestAnalysisService } from "./newsnow-hottest-analysis.service";
import { NewsnowRealtimeDispatcher } from "./newsnow-realtime.dispatcher";
import { NewsnowRecommendedService } from "./newsnow-recommended.service";
import { NewsnowSourceWarmSchedulerService } from "./newsnow-source-warm.scheduler.service";
import { NewsnowGateway } from "./newsnow.gateway";

@Module({
  imports: [
    AuthModule,
    UserSettingsModule,
    NewsPipelineModule,
    ItemsModule,
    UserNewsBehaviorModule,
  ],
  controllers: [NewsAggregatorController],
  providers: [
    NewsAggregatorRegistryService,
    NewsAggregatorService,
    NewsnowDomesticOpinionIndexService,
    NewsnowActiveSourceRegistryService,
    NewsnowHottestAnalysisSchedulerService,
    NewsnowHottestAnalysisService,
    NewsnowRecommendedService,
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
    NewsnowRecommendedService,
    NewsnowRealtimeDispatcher,
  ],
})
export class NewsAggregatorModule {}
