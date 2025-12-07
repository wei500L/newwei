import { IsInt, Max, Min } from "class-validator";

export class UpdateAuthCacheSettingsDto {
  @IsInt()
  @Min(60)
  @Max(86_400)
  profileTtlSeconds!: number;

  @IsInt()
  @Min(100)
  @Max(60_000)
  lockTtlMs!: number;

  @IsInt()
  @Min(50)
  @Max(120_000)
  maxWaitMs!: number;

  @IsInt()
  @Min(10)
  @Max(1_000)
  retryDelayMs!: number;
}
