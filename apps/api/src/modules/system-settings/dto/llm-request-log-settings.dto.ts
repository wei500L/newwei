import {
  ArrayMaxSize,
  IsNumber,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

const MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS = 100;
const MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES = 20;

export class UpdateLlmRequestLogSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3_650)
  retentionDays?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS)
  @IsString({ each: true })
  metadataAllowedTopLevelKeys?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES)
  @IsString({ each: true })
  metadataAllowedTopLevelPrefixes?: string[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  briefErrorRateThreshold?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  briefInvalidJsonRatioThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  briefConsecutiveDaysThreshold?: number;
}
