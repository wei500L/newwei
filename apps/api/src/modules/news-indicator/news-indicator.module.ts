import { Module } from "@nestjs/common";

import { NewsIndicatorController } from "./news-indicator.controller";
import { NewsIndicatorAssociationIngestionService } from "./news-indicator-association.ingestion.service";
import { NewsIndicatorAssociationService } from "./news-indicator-association.service";
import { NewsIndicatorSettingsService } from "./news-indicator-settings.service";

@Module({
  controllers: [NewsIndicatorController],
  providers: [
    NewsIndicatorSettingsService,
    NewsIndicatorAssociationService,
    NewsIndicatorAssociationIngestionService
  ],
  exports: [NewsIndicatorSettingsService, NewsIndicatorAssociationService]
})
export class NewsIndicatorModule {}
