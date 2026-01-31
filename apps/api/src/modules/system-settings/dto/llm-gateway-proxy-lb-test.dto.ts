import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 50;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;

export class LlmGatewayProxyLoadBalancingTestDto {
  @ApiPropertyOptional({
    description: "Optional model override for the load balancing smoke test."
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  model?: string;

  @ApiPropertyOptional({
    description: "How many requests to send. Range: 1-50."
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_ATTEMPTS)
  @Max(MAX_ATTEMPTS)
  attempts?: number;

  @ApiPropertyOptional({
    description: "Concurrency for the smoke test. Range: 1-10."
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_CONCURRENCY)
  @Max(MAX_CONCURRENCY)
  concurrency?: number;

  @ApiPropertyOptional({
    description: "Prompt override for the smoke test request."
  })
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  prompt?: string;
}

