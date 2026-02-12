import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export const LITELLM_ROUTING_STRATEGIES = [
  "simple-shuffle",
  "least-busy",
  "usage-based-routing",
  "latency-based-routing",
] as const;

export type LiteLlmRoutingStrategy =
  (typeof LITELLM_ROUTING_STRATEGIES)[number];

const MAX_KEYS = 100;

export class UpdateLlmGatewayProxyLoadBalancingSettingsDto {
  @ApiProperty({
    description:
      "Enable DB-managed LiteLLM Proxy load balancing for model deployments.",
  })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    description:
      "Replace Anthropic upstream keys with this list. Omit to keep existing DB keys.",
    type: [String],
    maxItems: MAX_KEYS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_KEYS)
  @IsString({ each: true })
  anthropicApiKeys?: string[];

  @ApiPropertyOptional({
    description:
      "When true, clears stored Anthropic keys. Ignored when anthropicApiKeys is provided.",
  })
  @IsOptional()
  @IsBoolean()
  clearAnthropicApiKeys?: boolean;

  @ApiProperty({
    enum: LITELLM_ROUTING_STRATEGIES,
    description: "LiteLLM router_settings.routing_strategy",
  })
  @IsIn(LITELLM_ROUTING_STRATEGIES)
  routingStrategy!: LiteLlmRoutingStrategy;

  @ApiProperty({
    description: "LiteLLM router_settings.redis_host",
  })
  @IsString()
  redisHost!: string;

  @ApiProperty({
    description: "LiteLLM router_settings.redis_port",
  })
  @IsInt()
  @Min(1)
  @Max(65535)
  redisPort!: number;

  @ApiPropertyOptional({
    description:
      "LiteLLM router_settings.redis_password. Empty string clears the stored password.",
  })
  @IsOptional()
  @IsString()
  redisPassword?: string;

  @ApiPropertyOptional({
    description:
      "Default per-deployment RPM injected into generated LiteLLM config when missing.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  deploymentRpm?: number | null;

  @ApiPropertyOptional({
    description:
      "Default per-deployment TPM injected into generated LiteLLM config when missing.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  deploymentTpm?: number | null;
}
