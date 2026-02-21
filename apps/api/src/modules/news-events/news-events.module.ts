import { Module } from "@nestjs/common";

import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { NewsEventBriefService } from "./news-event-brief.service";
import { NewsEventSourcePolicyService } from "./news-event-source-policy.service";
import { NewsEventsIngestionService } from "./news-events-ingestion.service";
import { NewsEventsSettingsService } from "./news-events-settings.service";
import { NewsEventsTimelineService } from "./news-events-timeline.service";
import { NewsEventsService } from "./news-events.service";

@Module({
  imports: [NewsPipelineModule],
  providers: [
    NewsEventsSettingsService,
    NewsEventSourcePolicyService,
    NewsEventsService,
    NewsEventBriefService,
    NewsEventsIngestionService,
    NewsEventsTimelineService,
  ],
  exports: [
    NewsEventsSettingsService,
    NewsEventSourcePolicyService,
    NewsEventsService,
    NewsEventBriefService,
  ],
})
export class NewsEventsModule {}
