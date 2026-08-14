import { Type } from "class-transformer";
import { IsBoolean, IsInt, Max, Min } from "class-validator";

export class UpdateAssistantQuotaSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  submitLimitPerHour!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  maxInFlightPerOrg!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000_000)
  monthlyTokenBudget!: number;
}
