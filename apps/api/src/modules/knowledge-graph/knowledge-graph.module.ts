import { Module } from "@nestjs/common";

import { AkshareModule } from "../akshare/akshare.module";
import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { KnowledgeGraphEntityDisambiguationService } from "./knowledge-graph-entity-disambiguation.service";
import { KnowledgeGraphImpactService } from "./knowledge-graph-impact.service";
import { KnowledgeGraphQualityService } from "./knowledge-graph-quality.service";
import { KnowledgeGraphReviewService } from "./knowledge-graph-review.service";
import { KnowledgeGraphSeedIngestionService } from "./knowledge-graph-seed.ingestion.service";
import { KnowledgeGraphSeedService } from "./knowledge-graph-seed.service";
import { KnowledgeGraphSettingsService } from "./knowledge-graph-settings.service";
import { KnowledgeGraphIngestionService } from "./knowledge-graph.ingestion.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";

@Module({
  imports: [DatabaseModule, CacheModule, AkshareModule, NewsPipelineModule],
  providers: [
    KnowledgeGraphService,
    KnowledgeGraphEntityDisambiguationService,
    KnowledgeGraphQualityService,
    KnowledgeGraphSettingsService,
    KnowledgeGraphIngestionService,
    KnowledgeGraphSeedService,
    KnowledgeGraphSeedIngestionService,
    KnowledgeGraphImpactService,
    KnowledgeGraphReviewService
  ],
  exports: [KnowledgeGraphService, KnowledgeGraphSettingsService, KnowledgeGraphImpactService, KnowledgeGraphReviewService]
})
export class KnowledgeGraphModule {}
