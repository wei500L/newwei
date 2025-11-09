import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  ValidateNested,
  MaxLength,
  IsIn,
  IsNumber
} from "class-validator";
import { CrawlUrlMatchMode } from "../crawl.types";

export class CrawlProxyConfigDto {
  @IsString()
  @MaxLength(512)
  server!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  password?: string;
}

export class CrawlOptionsDto {
  @IsOptional()
  @IsBoolean()
  includeImages?: boolean;

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
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5000)
  scrollDelayMs?: number;

  @IsOptional()
  @IsBoolean()
  enableUndetectedBrowser?: boolean;

  @IsOptional()
  @IsBoolean()
  enableStealthMode?: boolean;

  @IsOptional()
  @IsBoolean()
  simulateUser?: boolean;

  @IsOptional()
  @IsBoolean()
  overrideNavigator?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  proxyUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlProxyConfigDto)
  proxyConfig?: CrawlProxyConfigDto;

  @IsOptional()
  @IsArray()
  @IsUrl(undefined, { each: true })
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
  @IsIn(["bypass", "prefer_cache", "force_cache"])
  cacheMode?: "bypass" | "prefer_cache" | "force_cache";
}

export class CrawlMultiUrlConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsArray()
  @IsUrl(undefined, { each: true })
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
  @Type(() => Number)
  @IsInt()
  @Min(40)
  @Max(200)
  bodyWidth?: number;
}

export class CrawlMarkdownFilterDto {
  @IsOptional()
  @IsIn(["pruning"])
  type?: "pruning";

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "threshold must be a number" })
  @Min(0)
  @Max(1)
  threshold?: number;
}

export class CreateCrawlTaskDto {
  @IsUrl()
  url!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

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
