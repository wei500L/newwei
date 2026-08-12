import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";

import { IsSafeUrl } from "../../../common/validators/is-safe-url.decorator";

export class CrawlMetadataRequestDto {
  @IsOptional()
  @IsIn(["sitemap", "urls"])
  source?: "sitemap" | "urls";

  @ValidateIf((o) => o.source !== "urls")
  @IsString()
  @MaxLength(255)
  // Hostname-only guard: sitemap discovery builds https://{domain} requests,
  // so bare IPs/localhost must be rejected up front (SSRF).
  @Matches(
    /^(?![\d.:[\]]+$)(?!localhost$)(?!.*\.local$)(?!.*\.internal$)(?!.*\.lan$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
    {
      message: "domain must be a public hostname (no IPs, localhost, or private TLDs)",
    },
  )
  domain?: string;

  @ValidateIf((o) => o.source === "urls")
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @Matches(/^https?:\/\//i, { each: true, message: "each url must include http/https scheme" })
  @IsSafeUrl({ each: true })
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
