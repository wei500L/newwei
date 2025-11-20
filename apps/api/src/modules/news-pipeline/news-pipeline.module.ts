import { Module } from "@nestjs/common";
import { CrawlModule } from "../crawl/crawl.module";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { NewsPromptBuilder } from "./news-prompt.builder";
import { LiteLlmService } from "./litellm.service";
import { NewsPipelineService } from "./news-pipeline.service";
import { NewsPromptConfigService } from "./news-prompt-config.service";

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
