import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

const MAX_BUDGET_USD = 1_000_000;
const MIN_PARALLEL_REQUESTS = 1;
const MAX_PARALLEL_REQUESTS = 1_024;

export class UpdateLlmGatewayProxyGovernanceDto {
  @ApiPropertyOptional({
    description:
      "Enabled LiteLLM gateway profile that this managed governance policy should target.",
  })
  @IsOptional()
  @IsString()
  targetProfileId?: string | null;

  @ApiPropertyOptional({
    description:
      "When enabled, API runtime uses a LiteLLM-managed runtime key and LiteLLM enforces budget/concurrency limits.",
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      "Rolling 24h budget enforced on the managed LiteLLM runtime key.",
    minimum: 0,
    maximum: MAX_BUDGET_USD,
  })
  @Type(() => Number)
  @IsOptional()
  @Min(0)
  @Max(MAX_BUDGET_USD)
  dailyBudgetUsd?: number;

  @ApiPropertyOptional({
    description: "Rolling 30d budget enforced on the managed LiteLLM team.",
    minimum: 0,
    maximum: MAX_BUDGET_USD,
  })
  @Type(() => Number)
  @IsOptional()
  @Min(0)
  @Max(MAX_BUDGET_USD)
  monthlyBudgetUsd?: number;

  @ApiPropertyOptional({
    description:
      "Maximum in-flight requests enforced on the managed LiteLLM runtime key.",
    minimum: MIN_PARALLEL_REQUESTS,
    maximum: MAX_PARALLEL_REQUESTS,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(MIN_PARALLEL_REQUESTS)
  @Max(MAX_PARALLEL_REQUESTS)
  maxParallelRequests?: number;
}

export class LiteLlmProxyGovernancePreflightDto {
  @ApiPropertyOptional({
    description:
      "Optional target profile id to validate before enabling LiteLLM governance.",
  })
  @IsOptional()
  @IsString()
  targetProfileId?: string | null;
}
