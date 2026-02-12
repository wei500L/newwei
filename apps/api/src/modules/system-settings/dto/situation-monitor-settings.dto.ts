import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class UpdateSituationMonitorSettingsDto {
  @IsInt()
  @Min(1)
  @Max(5_000)
  translationMaxConcurrency!: number;

  @IsOptional()
  @IsBoolean()
  translationApiEnabled?: boolean;

  @IsOptional()
  @IsString()
  translationApiBaseUrl?: string | null;

  @IsOptional()
  @IsString()
  translationApiKey?: string | null;

  @IsOptional()
  @IsBoolean()
  translationFallbackApiEnabled?: boolean;

  @IsOptional()
  @IsString()
  translationFallbackApiBaseUrl?: string | null;

  @IsOptional()
  @IsString()
  finnhubApiKey?: string | null;

  @IsOptional()
  @IsString()
  fredApiKey?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(120_000)
  translationApiTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  translationApiMaxRetries?: number;
}
