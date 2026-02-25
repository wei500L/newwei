import { IsBoolean, IsInt, Max, Min } from "class-validator";

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
}
