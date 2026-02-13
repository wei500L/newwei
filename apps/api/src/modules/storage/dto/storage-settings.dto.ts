import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min
} from "class-validator";

import { CRAWL_IMAGE_STORAGE_PROVIDERS } from "../storage.constants";

export class UpdateStorageSettingsDto {
  @ApiPropertyOptional({ enum: CRAWL_IMAGE_STORAGE_PROVIDERS })
  @IsOptional()
  @IsIn(CRAWL_IMAGE_STORAGE_PROVIDERS)
  crawlImageStorage?: "mysql" | "s3";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accessKeyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  secretAccessKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bucket?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  endpoint?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  publicBaseUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  forcePathStyle?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  presignedUrlTtlSeconds?: number;
}
