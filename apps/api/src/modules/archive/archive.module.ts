import { Module } from "@nestjs/common";

import { NewsPipelineModule } from "../news-pipeline/news-pipeline.module";

import { ArchiveClassifier } from "./archive.classifier";
import { ArchiveService } from "./archive.service";

@Module({
  imports: [NewsPipelineModule],
  providers: [ArchiveClassifier, ArchiveService],
  exports: [ArchiveService],
})
export class ArchiveModule {}
