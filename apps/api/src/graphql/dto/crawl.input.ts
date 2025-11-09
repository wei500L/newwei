import { ArgsType, Field, ID, InputType, Int, Float, registerEnumType } from "@nestjs/graphql";
import { CrawlTaskStatus } from "@prisma/client";

@InputType()
export class CrawlTimeRangeInput {
  @Field({ nullable: true })
  from?: string;

  @Field({ nullable: true })
  to?: string;
}

@InputType()
export class CrawlProxyConfigInput {
  @Field()
  server!: string;

  @Field({ nullable: true })
  username?: string;

  @Field({ nullable: true })
  password?: string;
}

@InputType()
export class CrawlUrlMatcherInput {
  @Field(() => String, { nullable: true })
  matchMode?: string;

  @Field(() => [String], { nullable: true })
  patterns?: string[];
}

@InputType()
export class CrawlStrategyOverridesInput {
  @Field(() => Boolean, { nullable: true })
  scanFullPage?: boolean;

  @Field(() => Int, { nullable: true })
  scrollDelayMs?: number;

  @Field(() => Boolean, { nullable: true })
  onlyMainContent?: boolean;

  @Field(() => Boolean, { nullable: true })
  extractLinks?: boolean;

  @Field(() => Boolean, { nullable: true })
  simulateUser?: boolean;

  @Field(() => Boolean, { nullable: true })
  overrideNavigator?: boolean;

  @Field(() => String, { nullable: true })
  cacheMode?: string;
}

@InputType()
export class CrawlMultiUrlStrategyInput {
  @Field({ nullable: true })
  name?: string;

  @Field(() => [String], { nullable: true })
  urls?: string[];

  @Field(() => CrawlUrlMatcherInput, { nullable: true })
  matcher?: CrawlUrlMatcherInput;

  @Field(() => CrawlStrategyOverridesInput, { nullable: true })
  options?: CrawlStrategyOverridesInput;
}

@InputType()
export class CrawlMarkdownOptionsInput {
  @Field(() => String, { nullable: true })
  contentSource?: string;

  @Field(() => Boolean, { nullable: true })
  ignoreLinks?: boolean;

  @Field(() => Boolean, { nullable: true })
  escapeHtml?: boolean;

  @Field(() => Int, { nullable: true })
  bodyWidth?: number;
}

@InputType()
export class CrawlMarkdownFilterInput {
  @Field(() => String, { nullable: true })
  type?: string;

  @Field(() => Float, { nullable: true })
  threshold?: number;
}

@InputType()
export class CrawlOptionsInput {
  @Field(() => Boolean, { nullable: true })
  includeImages?: boolean;

  @Field(() => Boolean, { nullable: true })
  onlyMainContent?: boolean;

  @Field(() => Boolean, { nullable: true })
  extractLinks?: boolean;

  @Field(() => Boolean, { nullable: true })
  scanFullPage?: boolean;

  @Field(() => Int, { nullable: true })
  scrollDelayMs?: number;

  @Field(() => Boolean, { nullable: true })
  enableUndetectedBrowser?: boolean;

  @Field(() => Boolean, { nullable: true })
  enableStealthMode?: boolean;

  @Field(() => Boolean, { nullable: true })
  simulateUser?: boolean;

  @Field(() => Boolean, { nullable: true })
  overrideNavigator?: boolean;

  @Field({ nullable: true })
  proxyUrl?: string;

  @Field(() => CrawlProxyConfigInput, { nullable: true })
  proxyConfig?: CrawlProxyConfigInput;

  @Field(() => [String], { nullable: true })
  additionalUrls?: string[];

  @Field(() => [CrawlMultiUrlStrategyInput], { nullable: true })
  multiUrlConfigs?: CrawlMultiUrlStrategyInput[];

  @Field(() => CrawlMarkdownOptionsInput, { nullable: true })
  markdownOptions?: CrawlMarkdownOptionsInput;

  @Field(() => CrawlMarkdownFilterInput, { nullable: true })
  markdownFilter?: CrawlMarkdownFilterInput;
}

@InputType()
export class CreateCrawlTaskInput {
  @Field()
  url!: string;

  @Field({ nullable: true })
  displayName?: string;

  @Field(() => CrawlTimeRangeInput, { nullable: true })
  timeRange?: CrawlTimeRangeInput;

  @Field(() => Int, { nullable: true })
  concurrency?: number;

  @Field(() => [String], { nullable: true })
  keywords?: string[];

  @Field(() => CrawlOptionsInput, { nullable: true })
  options?: CrawlOptionsInput;
}

@ArgsType()
export class CrawlTasksQueryArgs {
  @Field(() => Int, { defaultValue: 20 })
  first!: number;

  @Field({ nullable: true })
  after?: string;

  @Field({ nullable: true })
  search?: string;

  @Field(() => CrawlTaskStatus, { nullable: true })
  status?: CrawlTaskStatus;
}

@ArgsType()
export class CrawlTaskDetailArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  resultLimit?: number;

  @Field({ nullable: true })
  resultSearch?: string;
}

registerEnumType(CrawlTaskStatus, {
  name: "CrawlTaskStatus"
});
