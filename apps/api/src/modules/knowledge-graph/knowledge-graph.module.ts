import { Module } from "@nestjs/common";

import { AkshareModule } from "../akshare/akshare.module";
import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";
import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { KnowledgeGraphEntityDisambiguationService } from "./knowledge-graph-entity-disambiguation.service";
import { KnowledgeGraphIntelligenceService } from "./knowledge-graph-intelligence.service";
import { KnowledgeGraphImpactService } from "./knowledge-graph-impact.service";
import { KnowledgeGraphQualityService } from "./knowledge-graph-quality.service";
import { KnowledgeGraphReviewService } from "./knowledge-graph-review.service";
import { KnowledgeGraphSettingsService } from "./knowledge-graph-settings.service";
import { KnowledgeGraphIngestionService } from "./knowledge-graph.ingestion.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";

@Module({
  imports: [DatabaseModule, CacheModule, AkshareModule, NewsPipelineModule],
  providers: [
    KnowledgeGraphService,
    KnowledgeGraphEntityDisambiguationService,
    KnowledgeGraphIntelligenceService,
    KnowledgeGraphQualityService,
    KnowledgeGraphSettingsService,
    KnowledgeGraphIngestionService,
    KnowledgeGraphImpactService,
    KnowledgeGraphReviewService
  ],
  exports: [
    KnowledgeGraphService,
    KnowledgeGraphIntelligenceService,
    KnowledgeGraphSettingsService,
    KnowledgeGraphImpactService,
    KnowledgeGraphReviewService
  ]
})
export class KnowledgeGraphModule {}
