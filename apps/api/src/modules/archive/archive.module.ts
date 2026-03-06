import { Module } from "@nestjs/common";

import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { ArchiveClassificationService } from "./archive-classification.service";
import { ArchiveClassifier } from "./archive.classifier";
import { ArchiveService } from "./archive.service";

@Module({
  imports: [NewsPipelineModule],
  providers: [ArchiveClassifier, ArchiveClassificationService, ArchiveService],
  exports: [ArchiveService],
})
export class ArchiveModule {}
