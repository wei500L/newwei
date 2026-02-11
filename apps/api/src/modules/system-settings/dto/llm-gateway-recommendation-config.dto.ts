import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsIn, IsString, ValidateNested } from "class-validator";

const PRESET_KEYS = [
  "litellmDocker",
  "litellmLocal",
  "openaiOfficial",
  "openrouter",
  "externalConservative",
  "glm",
  "kimi",
  "deepseek",
  "qwen"
] as const;

export class LlmGatewayRecommendationRuleDto {
  @ApiProperty({
    description: "Normalized hostname extracted from apiBase, e.g. api.openai.com"
  })
  @IsString()
  hostname!: string;

  @ApiProperty({
    enum: PRESET_KEYS,
    description: "Preset key applied when hostname matches"
  })
  @IsString()
  @IsIn(PRESET_KEYS)
  presetKey!: string;
}

export class UpdateLlmGatewayRecommendationConfigDto {
  @ApiProperty({ enum: PRESET_KEYS })
  @IsString()
  @IsIn(PRESET_KEYS)
  defaultPresetKey!: string;

  @ApiProperty({
    type: [String],
    description: "Hostnames treated as local gateway and mapped to litellmLocal"
  })
  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  localGatewayHosts!: string[];

  @ApiProperty({ type: () => [LlmGatewayRecommendationRuleDto] })
  @IsArray()
  @ArrayMaxSize(512)
  @ValidateNested({ each: true })
  @Type(() => LlmGatewayRecommendationRuleDto)
  domainRules!: LlmGatewayRecommendationRuleDto[];
}
