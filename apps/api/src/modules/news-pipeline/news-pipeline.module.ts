import { Module } from "@nestjs/common";
import { LlmRequestLogModel } from "@modular/mongo";

import { CrawlModule } from "../crawl/crawl.module";

import { LlmRequestLogController } from "./llm-request-log.controller";
import {
  LLM_REQUEST_LOG_MODEL,
  LlmRequestLogService,
} from "./llm-request-log.service";
import { LiteLlmService } from "./litellm.service";
import { NewsClassifierService } from "./news-classifier.service";
import { NewsClassificationQualitySettingsService } from "./news-classification-quality-settings.service";
import { NewsClassificationSettingsService } from "./news-classification-settings.service";
import { NewsDedupeSettingsService } from "./news-dedupe-settings.service";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { NewsPipelineService } from "./news-pipeline.service";
import { NewsPromptConfigService } from "./news-prompt-config.service";
import { NewsPromptBuilder } from "./news-prompt.builder";

@Module({
  imports: [CrawlModule],
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
    NewsClassificationSettingsService,
    NewsClassificationQualitySettingsService,
    NewsClassifierService,
    LlmRequestLogService,
    LiteLlmService
  ]
})
export class NewsPipelineModule {}
