import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";

export class CrawlMetadataRequestDto {
  @IsOptional()
  @IsIn(["sitemap", "urls"])
  source?: "sitemap" | "urls";

  @ValidateIf((o) => o.source !== "urls")
  @IsString()
  @MaxLength(255)
  domain?: string;

  @ValidateIf((o) => o.source === "urls")
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @Matches(/^https?:\/\//i, { each: true, message: "each url must include http/https scheme" })
  urls?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  pattern?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  maxUrls?: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  query?: string;

  @IsOptional()
  @IsNumber({}, { message: "scoreThreshold must be a number" })
  @Min(0)
  @Max(1)
  scoreThreshold?: number;

  @IsOptional()
  @IsBoolean()
  extractJsonLd?: boolean;

  @IsOptional()
  @IsBoolean()
  extractOpenGraph?: boolean;

  @IsOptional()
  @IsBoolean()
  extractStandardMeta?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  concurrency?: number;
}
