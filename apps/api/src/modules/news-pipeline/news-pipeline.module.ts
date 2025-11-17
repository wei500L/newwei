import { Module } from "@nestjs/common";
import { CrawlModule } from "../crawl/crawl.module";
import { NewsPipelineConfigService } from "./news-pipeline.config";
import { NewsPromptBuilder } from "./news-prompt.builder";
import { LiteLlmService } from "./litellm.service";
import { NewsPipelineService } from "./news-pipeline.service";

@Module({
  imports: [CrawlModule],
  providers: [NewsPipelineConfigService, NewsPromptBuilder, LiteLlmService, NewsPipelineService],
  exports: [NewsPipelineService, NewsPipelineConfigService, LiteLlmService]
})
export class NewsPipelineModule {}
