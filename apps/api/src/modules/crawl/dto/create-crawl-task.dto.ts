import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";

import { IsSafeUrl } from "../../../common/validators/is-safe-url.decorator";
import { CrawlAntiBotMode, CrawlUrlMatchMode, CrawlWaitUntil } from "../crawl.types";
import { IsAllowedJsCode } from "../validators/is-allowed-js-code.decorator";

export class CrawlDetailExpansionOptionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  maxDetailUrls?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "minRelevanceScore must be a number" })
  @Min(0)
  @Max(1)
  minRelevanceScore?: number;

  @IsOptional()
  @IsBoolean()
  requireSameDomain?: boolean;

  @IsOptional()
  @IsBoolean()
  allowExternalLinks?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  excludeUrlPatterns?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  includeUrlPatterns?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "minPublishTimeConfidence must be a number" })
  @Min(0)
  @Max(1)
  minPublishTimeConfidence?: number;

  @IsOptional()
  @IsBoolean()
  preferFitMarkdownForQuality?: boolean;
}

export class CrawlBrowserHeaderDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsString()
  @MaxLength(512)
  value!: string;
}

export class CrawlBrowserCookieDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsString()
  @MaxLength(4000)
  value!: string;

  @IsString()
  @MaxLength(255)
  domain!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  path?: string;
}

export class CrawlUserAgentGeneratorDto {
  @IsOptional()
  @IsIn(["windows", "macos", "linux", "android", "ios"])
  platform?: "windows" | "macos" | "linux" | "android" | "ios";

  @IsOptional()
  @IsIn(["chrome", "firefox", "safari", "edge"])
  browser?: "chrome" | "firefox" | "safari" | "edge";

  @IsOptional()
  @IsIn(["desktop", "mobile", "tablet"])
  deviceType?: "desktop" | "mobile" | "tablet";

  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}

export class CrawlGeolocationDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(5000)
  accuracy?: number;
}

export class CrawlMarkdownOptionsDto {
  @IsOptional()
  @IsIn(["raw_html", "cleaned_html", "fit_html"])
  contentSource?: "raw_html" | "cleaned_html" | "fit_html";

  @IsOptional()
  @IsBoolean()
  ignoreLinks?: boolean;

  @IsOptional()
  @IsBoolean()
  escapeHtml?: boolean;

  @IsOptional()
  @IsBoolean()
  citations?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(40)
  @Max(200)
  bodyWidth?: number;
}

export class CrawlMarkdownFilterDto {
  @IsOptional()
  @IsIn(["pruning", "bm25"])
  type?: "pruning" | "bm25";

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "threshold must be a number" })
  @Min(0)
  @Max(1)
  threshold?: number;

  @IsOptional()
  @IsIn(["fixed", "dynamic"])
  thresholdType?: "fixed" | "dynamic";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  minWordThreshold?: number;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  userQuery?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "bm25Threshold must be a number" })
  @Min(0)
  @Max(20)
  bm25Threshold?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  language?: string;
}

export class CrawlMarkdownStrategyDto {
  @IsString()
  @MaxLength(128)
  type!: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

export class CrawlTableExtractionStrategyDto {
  @IsString()
  @MaxLength(128)
  type!: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

const CRAWL_VIRTUAL_SCROLL_MODES = [
  "container_height",
  "page_height",
  "viewport",
  "pixels",
] as const;

@ValidatorConstraint({ name: "isCrawlVirtualScrollBy", async: false })
export class CrawlVirtualScrollByValidator
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    if (typeof value === "string") {
      return (CRAWL_VIRTUAL_SCROLL_MODES as readonly string[]).includes(
        value,
      );
    }
    if (typeof value === "number") {
      return Number.isFinite(value) && value >= 1 && value <= 20000;
    }
    return false;
  }

  defaultMessage(): string {
    return "scrollBy must be a scroll mode or a pixel count between 1 and 20000";
  }
}

export class CrawlVirtualScrollConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  containerSelector?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  scrollCount?: number;

  // Accepts a scroll mode ("container_height" | "page_height" | "viewport" |
  // "pixels") or a numeric pixel count, matching the stored config form
  // produced by packages/utils sanitizeVirtualScrollConfig.
  @IsOptional()
  @ValidateBy({
    name: "isCrawlVirtualScrollBy",
    constraints: [],
    validator: CrawlVirtualScrollByValidator,
  })
  scrollBy?: string | number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20000)
  scrollByPixels?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60000)
  waitAfterScrollMs?: number;
}

export class CrawlCleanMarkdownOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cssSelector?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  targetElements?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  excludedTags?: string[];

  @IsOptional()
  @IsBoolean()
  removeOverlayElements?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2000)
  wordCountThreshold?: number;
}

export class CrawlLinkPreviewOptionsDto {
  @IsOptional()
  @IsBoolean()
  includeInternal?: boolean;

  @IsOptional()
  @IsBoolean()
  includeExternal?: boolean;

  @IsOptional()
  @IsBoolean()
  includeSocial?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxLinks?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  concurrency?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  timeoutSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "scoreThreshold must be a number" })
  @Min(0)
  @Max(1)
  scoreThreshold?: number;

  @IsOptional()
  @IsBoolean()
  verbose?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(25)
  includePatterns?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(25)
  excludePatterns?: string[];
}

export class CrawlOptionsDto {
  @IsOptional()
  @IsBoolean()
  includeImages?: boolean;

  @IsOptional()
  @IsBoolean()
  storeMedia?: boolean;

  @IsOptional()
  @IsBoolean()
  onlyMainContent?: boolean;

  @IsOptional()
  @IsBoolean()
  extractLinks?: boolean;

  @IsOptional()
  @IsBoolean()
  scanFullPage?: boolean;

  @IsOptional()
  @IsBoolean()
  adjustViewportToContent?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  scrollDelayMs?: number;

  @IsOptional()
  @IsBoolean()
  headless?: boolean;

  @IsOptional()
  @IsBoolean()
  enableUndetectedBrowser?: boolean;

  @IsOptional()
  @IsBoolean()
  enableStealthMode?: boolean;

  @IsOptional()
  @IsIn(["auto", "enabled", "disabled"])
  antiBotMode?: CrawlAntiBotMode;

  @IsOptional()
  @IsBoolean()
  useManagedBrowser?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  userDataDir?: string;

  @IsOptional()
  @IsBoolean()
  simulateUser?: boolean;

  @IsOptional()
  @IsBoolean()
  overrideNavigator?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  @IsAllowedJsCode({ each: true })
  jsCode?: string[];

  @IsOptional()
  @IsBoolean()
  jsOnly?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  waitForSelector?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  waitForScript?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(60000)
  waitForTimeoutMs?: number;

  @IsOptional()
  @IsIn(["domcontentloaded", "load", "networkidle", "commit"])
  waitUntil?: CrawlWaitUntil;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(180000)
  pageTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30000)
  delayBeforeReturnHtmlMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  meanDelayMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  maxDelayRangeMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  semaphoreCount?: number;

  @IsOptional()
  @IsBoolean()
  removeForms?: boolean;

  @IsOptional()
  @IsArray()
  @IsUrl(undefined, { each: true })
  @IsSafeUrl({ each: true })
  @ArrayMaxSize(25)
  additionalUrls?: string[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CrawlMultiUrlConfigDto)
  multiUrlConfigs?: CrawlMultiUrlConfigDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlMarkdownOptionsDto)
  markdownOptions?: CrawlMarkdownOptionsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlMarkdownFilterDto)
  markdownFilter?: CrawlMarkdownFilterDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlMarkdownStrategyDto)
  markdownStrategy?: CrawlMarkdownStrategyDto;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "tableScoreThreshold must be a number" })
  @Min(0)
  @Max(10)
  tableScoreThreshold?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlTableExtractionStrategyDto)
  tableExtraction?: CrawlTableExtractionStrategyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlCleanMarkdownOptionsDto)
  cleanMarkdown?: CrawlCleanMarkdownOptionsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlVirtualScrollConfigDto)
  virtualScroll?: CrawlVirtualScrollConfigDto;

  @IsOptional()
  @IsBoolean()
  scoreLinks?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlLinkPreviewOptionsDto)
  linkPreview?: CrawlLinkPreviewOptionsDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CrawlBrowserHeaderDto)
  browserHeaders?: CrawlBrowserHeaderDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CrawlBrowserCookieDto)
  browserCookies?: CrawlBrowserCookieDto[];

  @IsOptional()
  @IsString()
  @MaxLength(768)
  userAgent?: string;

  @IsOptional()
  @IsIn(["random"])
  userAgentMode?: "random";

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlUserAgentGeneratorDto)
  userAgentGenerator?: CrawlUserAgentGeneratorDto;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezoneId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlGeolocationDto)
  geolocation?: CrawlGeolocationDto;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12000)
  storageState?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  wordCountThreshold?: number;

  @IsOptional()
  @IsBoolean()
  excludeExternalLinks?: boolean;

  @IsOptional()
  @IsBoolean()
  excludeExternalImages?: boolean;

  @IsOptional()
  @IsBoolean()
  waitForImages?: boolean;

  @IsOptional()
  @IsIn(["auto", "list", "detail"])
  pageTypeHint?: "auto" | "list" | "detail";

  @IsOptional()
  @IsBoolean()
  autoExpandDetails?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlDetailExpansionOptionsDto)
  detailExpansion?: CrawlDetailExpansionOptionsDto;

  @IsOptional()
  @IsIn(["balanced", "quality_first", "speed_first"])
  qualityProfile?: "balanced" | "quality_first" | "speed_first";

  @IsOptional()
  @IsBoolean()
  removeOverlayElements?: boolean;

  @IsOptional()
  @IsBoolean()
  processIframes?: boolean;

  @IsOptional()
  @IsBoolean()
  textMode?: boolean;

  @IsOptional()
  @IsBoolean()
  captureScreenshot?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cssSelector?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  excludedTags?: string[];
}

export class CrawlUrlMatcherDto {
  @IsOptional()
  @IsIn(["glob", "regex", "substring", "prefix"])
  matchMode?: CrawlUrlMatchMode;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  patterns?: string[];
}

export class CrawlStrategyOverridesDto {
  @IsOptional()
  @IsBoolean()
  scanFullPage?: boolean;

  @IsOptional()
  @IsBoolean()
  adjustViewportToContent?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  scrollDelayMs?: number;

  @IsOptional()
  @IsBoolean()
  onlyMainContent?: boolean;

  @IsOptional()
  @IsBoolean()
  extractLinks?: boolean;

  @IsOptional()
  @IsBoolean()
  simulateUser?: boolean;

  @IsOptional()
  @IsBoolean()
  overrideNavigator?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  @IsAllowedJsCode({ each: true })
  jsCode?: string[];

  @IsOptional()
  @IsBoolean()
  jsOnly?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  waitForSelector?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  waitForScript?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(60000)
  waitForTimeoutMs?: number;

  @IsOptional()
  @IsIn(["domcontentloaded", "load", "networkidle", "commit"])
  waitUntil?: CrawlWaitUntil;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(180000)
  pageTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30000)
  delayBeforeReturnHtmlMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  meanDelayMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  maxDelayRangeMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  semaphoreCount?: number;


  @IsOptional()
  @IsBoolean()
  removeForms?: boolean;

  @IsOptional()
  @IsIn(["bypass", "prefer_cache", "force_cache"])
  cacheMode?: "bypass" | "prefer_cache" | "force_cache";

  @IsOptional()
  @IsString()
  @MaxLength(160)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12000)
  storageState?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  wordCountThreshold?: number;

  @IsOptional()
  @IsBoolean()
  excludeExternalLinks?: boolean;

  @IsOptional()
  @IsBoolean()
  removeOverlayElements?: boolean;

  @IsOptional()
  @IsBoolean()
  processIframes?: boolean;

  @IsOptional()
  @IsBoolean()
  textMode?: boolean;

  @IsOptional()
  @IsBoolean()
  captureScreenshot?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cssSelector?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  excludedTags?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlVirtualScrollConfigDto)
  virtualScroll?: CrawlVirtualScrollConfigDto;

  @IsOptional()
  @IsBoolean()
  waitForImages?: boolean;

  @IsOptional()
  @IsIn(["auto", "list", "detail"])
  pageTypeHint?: "auto" | "list" | "detail";

  @IsOptional()
  @IsBoolean()
  autoExpandDetails?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlDetailExpansionOptionsDto)
  detailExpansion?: CrawlDetailExpansionOptionsDto;

  @IsOptional()
  @IsIn(["balanced", "quality_first", "speed_first"])
  qualityProfile?: "balanced" | "quality_first" | "speed_first";
}

export class CrawlMultiUrlConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsArray()
  @IsUrl(undefined, { each: true })
  @IsSafeUrl({ each: true })
  @ArrayMaxSize(25)
  urls?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlUrlMatcherDto)
  matcher?: CrawlUrlMatcherDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlStrategyOverridesDto)
  options?: CrawlStrategyOverridesDto;
}

export class CreateCrawlTaskDto {
  @IsUrl()
  @IsSafeUrl()
  url!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  ingestToItems?: boolean;

  @IsOptional()
  @IsISO8601()
  timeRangeFrom?: string;

  @IsOptional()
  @IsISO8601()
  timeRangeTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  concurrency?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(25)
  keywords?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlOptionsDto)
  options?: CrawlOptionsDto;
}
