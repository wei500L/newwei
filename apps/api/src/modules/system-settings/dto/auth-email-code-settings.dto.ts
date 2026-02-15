import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Max, Min } from "class-validator";

export class UpdateAuthEmailCodeSettingsDto {
  @ApiProperty({
    description: "Verification code time-to-live in seconds.",
    example: 300,
    minimum: 60,
    maximum: 1800
  })
  @IsInt()
  @Min(60)
  @Max(1_800)
  ttlSeconds!: number;

  @ApiProperty({
    description: "Cooldown in seconds between two code send requests.",
    example: 90,
    minimum: 10,
    maximum: 3600
  })
  @IsInt()
  @Min(10)
  @Max(3_600)
  cooldownSeconds!: number;

  @ApiProperty({
    description: "Maximum number of failed verification attempts before code invalidation.",
    example: 3,
    minimum: 1,
    maximum: 10
  })
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts!: number;
}
