import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsString, Matches, Max, MaxLength, Min } from "class-validator";

export class UpdateNewsSourceSchedulerSettingsDto {
  @IsInt()
  @Min(1)
  @Max(3_650)
  seedFreshnessWindowDays!: number;

  @IsInt()
  @Min(10)
  @Max(3_600)
  seedCacheTtlSecondsSitemapRss!: number;

  @IsInt()
  @Min(10)
  @Max(3_600)
  seedCacheTtlSecondsListDeep!: number;

  @IsBoolean()
  seedCacheTtlForceGlobal!: boolean;

  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Matches(/^[a-z0-9_.-]{1,64}$/i, { each: true })
  seedUrlQueryParamAllowlist!: string[];

  @IsInt()
  @Min(0)
  @Max(100)
  rssAdaptiveHotHitRatePercent!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  rssAdaptiveWarmHitRatePercent!: number;

  @IsInt()
  @Min(1)
  @Max(24)
  rssAdaptiveColdConsecutiveNoHitRuns!: number;

  @IsInt()
  @Min(10)
  @Max(21_600)
  rssAdaptiveHotIntervalSeconds!: number;

  @IsInt()
  @Min(1)
  @Max(8)
  rssAdaptiveWarmIntervalDivisor!: number;

  @IsInt()
  @Min(10)
  @Max(21_600)
  rssAdaptiveWarmMinIntervalSeconds!: number;

  @IsInt()
  @Min(1)
  @Max(8)
  rssAdaptiveColdIntervalMultiplier!: number;

  @IsInt()
  @Min(10)
  @Max(21_600)
  rssAdaptiveColdMaxIntervalSeconds!: number;

  @IsInt()
  @Min(10)
  @Max(3_600)
  rssAdaptiveHotDiscoveryCacheTtlCapSeconds!: number;

  @IsInt()
  @Min(10)
  @Max(3_600)
  rssAdaptiveWarmDiscoveryCacheTtlCapSeconds!: number;
}
