import { ArgsType, Field, ID, InputType, Int, Float, registerEnumType } from "@nestjs/graphql";
import { CrawlTaskStatus } from "@prisma/client";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min
} from "class-validator";
import GraphQLJSONScalar from "graphql-type-json";

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
export class CrawlBrowserHeaderInput {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@InputType()
export class CrawlBrowserCookieInput {
  @Field()
  name!: string;

  @Field()
  value!: string;

  @Field()
  domain!: string;

  @Field({ nullable: true })
  path?: string;
}

@InputType()
export class CrawlUserAgentGeneratorInput {
  @Field({ nullable: true })
  platform?: string;

  @Field({ nullable: true })
  browser?: string;

  @Field({ nullable: true })
  deviceType?: string;

  @Field({ nullable: true })
  locale?: string;
}

@InputType()
export class CrawlGeolocationInput {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;

  @Field(() => Float, { nullable: true })
  accuracy?: number;
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

  @Field(() => Boolean, { nullable: true })
  adjustViewportToContent?: boolean;

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

  @Field(() => [String], { nullable: true })
  jsCode?: string[];

  @Field(() => Boolean, { nullable: true })
  jsOnly?: boolean;

  @Field({ nullable: true })
  waitForSelector?: string;

  @Field({ nullable: true })
  waitForScript?: string;

  @Field(() => Int, { nullable: true })
  waitForTimeoutMs?: number;

  @Field(() => String, { nullable: true })
  cacheMode?: string;

  @Field(() => Int, { nullable: true })
  wordCountThreshold?: number;

  @Field(() => Boolean, { nullable: true })
  excludeExternalLinks?: boolean;

  @Field(() => Boolean, { nullable: true })
  excludeExternalImages?: boolean;

  @Field(() => Boolean, { nullable: true })
  removeOverlayElements?: boolean;

  @Field(() => Boolean, { nullable: true })
  processIframes?: boolean;

  @Field(() => Boolean, { nullable: true })
  textMode?: boolean;

  @Field(() => Boolean, { nullable: true })
  captureScreenshot?: boolean;

  @Field({ nullable: true })
  cssSelector?: string;

  @Field(() => [String], { nullable: true })
  excludedTags?: string[];

  @Field(() => Boolean, { nullable: true })
  waitForImages?: boolean;
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

  @Field(() => String, { nullable: true })
  thresholdType?: string;

  @Field(() => Int, { nullable: true })
  minWordThreshold?: number;
}

@InputType()
export class CrawlMarkdownStrategyInput {
  @Field()
  type!: string;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  params?: Record<string, unknown>;
}

@InputType()
export class CrawlTableExtractionInput {
  @Field()
  type!: string;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  params?: Record<string, unknown>;
}

@InputType()
export class CrawlCleanMarkdownInput {
  @Field({ nullable: true })
  cssSelector?: string;

  @Field(() => [String], { nullable: true })
  targetElements?: string[];

  @Field(() => [String], { nullable: true })
  excludedTags?: string[];

  @Field(() => Boolean, { nullable: true })
  removeOverlayElements?: boolean;

  @Field(() => Int, { nullable: true })
  wordCountThreshold?: number;
}

@InputType()
export class CrawlLinkPreviewInput {
  @Field(() => Boolean, { nullable: true })
  includeInternal?: boolean;

  @Field(() => Boolean, { nullable: true })
  includeExternal?: boolean;

  @Field(() => Boolean, { nullable: true })
  includeSocial?: boolean;

  @Field(() => Int, { nullable: true })
  maxLinks?: number;

  @Field(() => Int, { nullable: true })
  concurrency?: number;

  @Field(() => Int, { nullable: true })
  timeoutSeconds?: number;

  @Field(() => String, { nullable: true })
  query?: string;

  @Field(() => Float, { nullable: true })
  scoreThreshold?: number;

  @Field(() => Boolean, { nullable: true })
  verbose?: boolean;

  @Field(() => [String], { nullable: true })
  includePatterns?: string[];

  @Field(() => [String], { nullable: true })
  excludePatterns?: string[];
}

@InputType()
export class CrawlOptionsInput {
  @Field(() => Boolean, { nullable: true })
  includeImages?: boolean;

  @Field(() => Boolean, { nullable: true })
  storeMedia?: boolean;

  @Field(() => Boolean, { nullable: true })
  onlyMainContent?: boolean;

  @Field(() => Boolean, { nullable: true })
  extractLinks?: boolean;

  @Field(() => Boolean, { nullable: true })
  excludeExternalImages?: boolean;

  @Field(() => Boolean, { nullable: true })
  scanFullPage?: boolean;

  @Field(() => Boolean, { nullable: true })
  adjustViewportToContent?: boolean;

  @Field(() => Int, { nullable: true })
  scrollDelayMs?: number;

  @Field(() => Boolean, { nullable: true })
  enableUndetectedBrowser?: boolean;

  @Field(() => Boolean, { nullable: true })
  enableStealthMode?: boolean;

  @Field(() => Boolean, { nullable: true })
  useManagedBrowser?: boolean;

  @Field({ nullable: true })
  userDataDir?: string;

  @Field(() => Boolean, { nullable: true })
  simulateUser?: boolean;

  @Field(() => Boolean, { nullable: true })
  overrideNavigator?: boolean;

  @Field(() => [String], { nullable: true })
  jsCode?: string[];

  @Field(() => Boolean, { nullable: true })
  jsOnly?: boolean;

  @Field({ nullable: true })
  waitForSelector?: string;

  @Field({ nullable: true })
  waitForScript?: string;

  @Field(() => Int, { nullable: true })
  waitForTimeoutMs?: number;

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

  @Field(() => CrawlMarkdownStrategyInput, { nullable: true })
  markdownStrategy?: CrawlMarkdownStrategyInput;

  @Field(() => Number, { nullable: true })
  tableScoreThreshold?: number;

  @Field(() => CrawlTableExtractionInput, { nullable: true })
  tableExtraction?: CrawlTableExtractionInput;

  @Field(() => CrawlCleanMarkdownInput, { nullable: true })
  cleanMarkdown?: CrawlCleanMarkdownInput;

  @Field(() => Boolean, { nullable: true })
  scoreLinks?: boolean;

  @Field(() => CrawlLinkPreviewInput, { nullable: true })
  linkPreview?: CrawlLinkPreviewInput;

  @Field(() => [CrawlBrowserHeaderInput], { nullable: true })
  browserHeaders?: CrawlBrowserHeaderInput[];

  @Field(() => [CrawlBrowserCookieInput], { nullable: true })
  browserCookies?: CrawlBrowserCookieInput[];

  @Field({ nullable: true })
  userAgent?: string;

  @Field({ nullable: true })
  userAgentMode?: string;

  @Field(() => CrawlUserAgentGeneratorInput, { nullable: true })
  userAgentGenerator?: CrawlUserAgentGeneratorInput;

  @Field({ nullable: true })
  locale?: string;

  @Field({ nullable: true })
  timezoneId?: string;

  @Field(() => CrawlGeolocationInput, { nullable: true })
  geolocation?: CrawlGeolocationInput;

  @Field({ nullable: true })
  sessionId?: string;

  @Field({ nullable: true })
  storageState?: string;

  @Field(() => Boolean, { nullable: true })
  waitForImages?: boolean;
}

@InputType()
export class CrawlMetadataInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  source?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  domain?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  urls?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  pattern?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxUrls?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  query?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  scoreThreshold?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  extractJsonLd?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  extractOpenGraph?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  extractStandardMeta?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  concurrency?: number;
}

@InputType()
export class CreateCrawlTaskInput {
  @Field()
  @IsString()
  url!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  displayName?: string;

  @Field(() => CrawlTimeRangeInput, { nullable: true })
  @IsOptional()
  @IsObject()
  timeRange?: CrawlTimeRangeInput;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  concurrency?: number;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @Field(() => CrawlOptionsInput, { nullable: true })
  @IsOptional()
  @IsObject()
  options?: CrawlOptionsInput;
}

@ArgsType()
export class CrawlTasksQueryArgs {
  @Field(() => Int, { defaultValue: 20 })
  @IsInt()
  @Min(1)
  first!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  after?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => CrawlTaskStatus, { nullable: true })
  @IsOptional()
  @IsEnum(CrawlTaskStatus)
  status?: CrawlTaskStatus;
}

@ArgsType()
export class CrawlTaskDetailArgs {
  @Field(() => ID)
  @IsString()
  id!: string;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  resultLimit?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  resultSearch?: string;
}

registerEnumType(CrawlTaskStatus, {
  name: "CrawlTaskStatus"
});
