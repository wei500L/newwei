import { LlmRequestLogModel } from "@modular/mongo";
import { Module, forwardRef } from "@nestjs/common";

import { CrawlModule } from "../crawl/crawl.module";

import { LiteLlmService } from "./litellm.service";
import { LlmRequestLogController } from "./llm-request-log.controller";
import {
  LLM_REQUEST_LOG_MODEL,
  LlmRequestLogService,
} from "./llm-request-log.service";
import { NewsClassificationQualitySettingsService } from "./news-classification-quality-settings.service";
import { NewsClassificationSettingsService } from "./news-classification-settings.service";
import { NewsClassifierService } from "./news-classifier.service";
import { NewsDedupeSettingsService } from "./news-dedupe-settings.service";
import { NewsExtractionSettingsService } from "./news-extraction-settings.service";
import { NewsExtractionStageService } from "./news-extraction-stage.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { NewsPipelineService } from "./news-pipeline.service";
import { NewsPromptConfigService } from "./news-prompt-config.service";
import { NewsPromptBuilder } from "./news-prompt.builder";

@Module({
  imports: [forwardRef(() => CrawlModule)],
  controllers: [LlmRequestLogController],
  providers: [
    {
      provide: LLM_REQUEST_LOG_MODEL,
      useValue: LlmRequestLogModel,
    },
    NewsPipelineConfigService,
    NewsPromptConfigService,
    NewsPromptBuilder,
    NewsDedupeSettingsService,
    NewsExtractionSettingsService,
    NewsExtractionStageService,
    NewsClassificationSettingsService,
    NewsClassificationQualitySettingsService,
    NewsClassifierService,
    LlmRequestLogService,
    LiteLlmService,
    NewsPipelineService
  ],
  exports: [
    NewsPipelineService,
    NewsPipelineConfigService,
    NewsPromptConfigService,
    NewsDedupeSettingsService,
    NewsExtractionSettingsService,
    NewsClassificationSettingsService,
    NewsClassificationQualitySettingsService,
    NewsClassifierService,
    LlmRequestLogService,
    LiteLlmService,
    NewsExtractionStageService,
  ]
})
export class NewsPipelineModule {}
