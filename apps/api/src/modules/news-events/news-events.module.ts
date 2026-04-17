import { Module } from "@nestjs/common";

import { ModelServiceModule } from "../model-service/model-service.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { NewsEventClusteringAdminController } from "./news-event-clustering-admin.controller";
import { NewsEventClusteringFailureService } from "./news-event-clustering-failure.service";
import { NewsEventBriefService } from "./news-event-brief.service";
import { NewsEventSourcePolicyService } from "./news-event-source-policy.service";
import { NewsEventsBertopicService } from "./news-events-bertopic.service";
import { NewsEventsIngestionService } from "./news-events-ingestion.service";
import { NewsEventsSettingsService } from "./news-events-settings.service";
import { NewsEventsTimelineService } from "./news-events-timeline.service";
import { NewsEventsService } from "./news-events.service";

@Module({
  imports: [NewsPipelineModule, ModelServiceModule],
  controllers: [NewsEventClusteringAdminController],
  providers: [
    NewsEventsSettingsService,
    NewsEventSourcePolicyService,
    NewsEventsService,
    NewsEventClusteringFailureService,
    NewsEventsBertopicService,
    NewsEventBriefService,
    NewsEventsIngestionService,
    NewsEventsTimelineService,
  ],
  exports: [
    NewsEventsSettingsService,
    NewsEventSourcePolicyService,
    NewsEventsService,
    NewsEventClusteringFailureService,
    NewsEventBriefService,
  ],
})
export class NewsEventsModule {}
