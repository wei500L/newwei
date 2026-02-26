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
}
