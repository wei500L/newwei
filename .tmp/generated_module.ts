import { Module } from "@nestjs/common"

import { NewsAggregatorController } from "./news-aggregator.controller"
import { NewsAggregatorRegistryService } from "./news-aggregator-registry.service"
import { NewsAggregatorService } from "./news-aggregator.service"

@Module({
  controllers: [NewsAggregatorController],
  providers: [NewsAggregatorRegistryService, NewsAggregatorService],
  exports: [NewsAggregatorRegistryService, NewsAggregatorService],
})
export class NewsAggregatorModule {}
