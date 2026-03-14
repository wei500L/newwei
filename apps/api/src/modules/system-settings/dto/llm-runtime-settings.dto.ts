import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";

const MAX_BUDGET_USD = 1_000_000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 1_024;
const MIN_ALERT_COOLDOWN_SECONDS = 10;
const MAX_ALERT_COOLDOWN_SECONDS = 86_400;
const MIN_REQUEST_LEASE_TTL_SECONDS = 15;
const MAX_REQUEST_LEASE_TTL_SECONDS = 3_600;

export class UpdateLlmRuntimeSettingsDto {
  @ApiPropertyOptional({ enum: ["observe_only"] })
  @IsOptional()
  @IsIn(["observe_only"])
  mode?: "observe_only";

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_BUDGET_USD })
  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_BUDGET_USD)
  dailyBudgetUsd?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_BUDGET_USD })
  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_BUDGET_USD)
  monthlyBudgetUsd?: number;

  @ApiPropertyOptional({ minimum: MIN_CONCURRENCY, maximum: MAX_CONCURRENCY })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(MIN_CONCURRENCY)
  @Max(MAX_CONCURRENCY)
  maxConcurrency?: number;

  @ApiPropertyOptional({
    minimum: MIN_ALERT_COOLDOWN_SECONDS,
    maximum: MAX_ALERT_COOLDOWN_SECONDS,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(MIN_ALERT_COOLDOWN_SECONDS)
  @Max(MAX_ALERT_COOLDOWN_SECONDS)
  alertCooldownSeconds?: number;

  @ApiPropertyOptional({
    minimum: MIN_REQUEST_LEASE_TTL_SECONDS,
    maximum: MAX_REQUEST_LEASE_TTL_SECONDS,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(MIN_REQUEST_LEASE_TTL_SECONDS)
  @Max(MAX_REQUEST_LEASE_TTL_SECONDS)
  requestLeaseTtlSeconds?: number;
}
