import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module";
import { UserSettingsModule } from "../user-settings/user-settings.module";

import { NewsAggregatorController } from "./news-aggregator.controller"
import { NewsnowGateway } from "./newsnow.gateway";
import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import { NewsAggregatorService } from "./news-aggregator.service"
import { NewsnowRealtimeDispatcher } from "./newsnow-realtime.dispatcher";

@Module({
  imports: [AuthModule, UserSettingsModule],
  controllers: [NewsAggregatorController],
  providers: [
    NewsAggregatorRegistryService,
    NewsAggregatorService,
    NewsnowRealtimeDispatcher,
    NewsnowGateway,
  ],
  exports: [NewsAggregatorRegistryService, NewsAggregatorService, NewsnowRealtimeDispatcher],
})
export class NewsAggregatorModule {}
