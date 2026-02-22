import { Module } from "@nestjs/common";

import { CrawlModule } from "../crawl/crawl.module";

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
  providers: [
    NewsPipelineConfigService,
    NewsPromptConfigService,
    NewsPromptBuilder,
    NewsDedupeSettingsService,
    NewsClassificationSettingsService,
    NewsClassificationQualitySettingsService,
    NewsClassifierService,
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
    LiteLlmService
  ]
})
export class NewsPipelineModule {}
