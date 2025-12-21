import { Module } from "@nestjs/common";

import { CrawlModule } from "../crawl/crawl.module";

import { LiteLlmService } from "./litellm.service";
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
    LiteLlmService,
    NewsPipelineService
  ],
  exports: [
    NewsPipelineService,
    NewsPipelineConfigService,
    NewsPromptConfigService,
    LiteLlmService
  ]
})
export class NewsPipelineModule {}
