import { Module } from "@nestjs/common";

import { NewsEventsIngestionService } from "./news-events-ingestion.service";
import { NewsEventsSettingsService } from "./news-events-settings.service";
import { NewsEventsService } from "./news-events.service";
import { NewsEventsTimelineService } from "./news-events-timeline.service";

@Module({
  providers: [
    NewsEventsSettingsService,
    NewsEventsService,
    NewsEventsIngestionService,
    NewsEventsTimelineService
  ],
  exports: [NewsEventsSettingsService, NewsEventsService]
})
export class NewsEventsModule {}
