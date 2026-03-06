import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module";
import { ItemsModule } from "../items/items.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";
import { UserSettingsModule } from "../user-settings/user-settings.module";

import { NewsAggregatorController } from "./news-aggregator.controller"
import { NewsnowGateway } from "./newsnow.gateway";
import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import { NewsAggregatorService } from "./news-aggregator.service"
import { NewsnowHottestAnalysisService } from "./newsnow-hottest-analysis.service";
import { NewsnowRealtimeDispatcher } from "./newsnow-realtime.dispatcher";

@Module({
  imports: [AuthModule, UserSettingsModule, NewsPipelineModule, ItemsModule],
  controllers: [NewsAggregatorController],
  providers: [
    NewsAggregatorRegistryService,
    NewsAggregatorService,
    NewsnowHottestAnalysisService,
    NewsnowRealtimeDispatcher,
    NewsnowGateway,
  ],
  exports: [
    NewsAggregatorRegistryService,
    NewsAggregatorService,
    NewsnowHottestAnalysisService,
    NewsnowRealtimeDispatcher,
  ],
})
export class NewsAggregatorModule {}
