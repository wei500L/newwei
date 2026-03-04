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

  @IsOptional()
  @IsBoolean()
  telegramEnabled?: boolean;

  @IsOptional()
  @IsString()
  telegramApiId?: string | null;

  @IsOptional()
  @IsString()
  telegramApiHash?: string | null;

  @IsOptional()
  @IsString()
  telegramSession?: string | null;

  @IsOptional()
  @IsString()
  telegramChannelSet?: string | null;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(500)
  telegramMaxFeedItems?: number;

  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(10_000)
  telegramMaxTextChars?: number;

  @IsOptional()
  @IsInt()
  @Min(3_000)
  @Max(120_000)
  telegramChannelTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(30_000)
  @Max(600_000)
  telegramPollCycleTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600_000)
  telegramStartupDelayMs?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60_000)
  telegramRateLimitMs?: number;

  @IsOptional()
  @IsInt()
  @Min(15_000)
  @Max(3_600_000)
  telegramPollIntervalMs?: number;
}
