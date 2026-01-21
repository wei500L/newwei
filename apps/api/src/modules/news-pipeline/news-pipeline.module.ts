import { Module } from "@nestjs/common";

import { CrawlModule } from "../crawl/crawl.module";

import { LiteLlmService } from "./litellm.service";
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
    LiteLlmService,
    NewsPipelineService
  ],
  exports: [
    NewsPipelineService,
    NewsPipelineConfigService,
    NewsPromptConfigService,
    NewsDedupeSettingsService,
    LiteLlmService
  ]
})
export class NewsPipelineModule {}
