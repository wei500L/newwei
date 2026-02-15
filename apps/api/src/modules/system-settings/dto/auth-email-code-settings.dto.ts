import { IsInt, Max, Min } from "class-validator";

export class UpdateAuthEmailCodeSettingsDto {
  @IsInt()
  @Min(60)
  @Max(1_800)
  ttlSeconds!: number;

  @IsInt()
  @Min(10)
  @Max(3_600)
  cooldownSeconds!: number;

  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts!: number;
}
