import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min
} from "class-validator";

export class UpdateStorageSettingsDto {
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
