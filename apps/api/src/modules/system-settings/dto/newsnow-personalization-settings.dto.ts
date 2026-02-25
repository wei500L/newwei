import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpdateNewsnowPersonalizationSettingsDto {
  @IsInt()
  @Min(0)
  @Max(300_000)
  cacheTtlMs!: number;

  @IsInt()
  @Min(100)
  @Max(20_000)
  maxCacheEntries!: number;

  @IsInt()
  @Min(1_000)
  @Max(600_000)
  throttleWindowMs!: number;

  @IsInt()
  @Min(1)
  @Max(500)
  maxRequestsPerWindowPerUser!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(5)
  affinitySourceWeight!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(5)
  behaviorSourceWeight!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(20)
  focusSourceBonus!: number;

  @IsIn(['multiplier', 'fixed'])
  staleTtlStrategy!: 'multiplier' | 'fixed';

  @IsInt()
  @Min(1)
  @Max(20)
  staleTtlMultiplier!: number;

  @IsInt()
  @Min(1_000)
  @Max(3_600_000)
  staleTtlFixedMs!: number;
}
