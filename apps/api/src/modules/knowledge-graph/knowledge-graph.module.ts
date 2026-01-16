import { Module } from "@nestjs/common";

import { AkshareModule } from "../akshare/akshare.module";
import { CacheModule } from "../cache/cache.module";
import { DatabaseModule } from "../config/database.module";

import { KnowledgeGraphSettingsService } from "./knowledge-graph-settings.service";
import { KnowledgeGraphIngestionService } from "./knowledge-graph.ingestion.service";
import { KnowledgeGraphSeedIngestionService } from "./knowledge-graph-seed.ingestion.service";
import { KnowledgeGraphSeedService } from "./knowledge-graph-seed.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";
import { KnowledgeGraphImpactService } from "./knowledge-graph-impact.service";

@Module({
  imports: [DatabaseModule, CacheModule, AkshareModule],
  providers: [
    KnowledgeGraphService,
    KnowledgeGraphSettingsService,
    KnowledgeGraphIngestionService,
    KnowledgeGraphSeedService,
    KnowledgeGraphSeedIngestionService,
    KnowledgeGraphImpactService
  ],
  exports: [KnowledgeGraphService, KnowledgeGraphSettingsService, KnowledgeGraphImpactService]
})
export class KnowledgeGraphModule {}
