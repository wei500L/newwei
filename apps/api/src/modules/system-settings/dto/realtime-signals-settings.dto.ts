import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export class UpdateRealtimeSignalsSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(120_000)
  requestTimeoutMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  maxRetries?: number;

  @IsOptional()
  @IsBoolean()
  openskyEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  adsbEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  openskyIntervalSec?: number;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  adsbIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  aisEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  aisIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  unrestEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  unrestIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  outagesEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  outagesIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  keywordSpikeEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  keywordSpikeIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  pizzintEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  pizzintIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  gdeltTensionEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  gdeltTensionIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  polymarketLeadsEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86_400)
  polymarketLeadsIntervalSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  keywordSpikeMinCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  keywordSpikeMultiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  predictionShiftThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  predictionNewsActivityThreshold?: number;

  @IsOptional()
  @IsString()
  openskyBaseUrl?: string | null;

  @IsOptional()
  @IsString()
  adsbBaseUrl?: string | null;

  @IsOptional()
  @IsString()
  openskyTokenUrl?: string | null;

  @IsOptional()
  @IsString()
  openskyClientId?: string | null;

  @IsOptional()
  @IsString()
  openskyClientSecret?: string | null;

  @IsOptional()
  @IsString()
  relayBaseUrl?: string | null;

  @IsOptional()
  @IsString()
  relaySharedSecret?: string | null;

  @IsOptional()
  @IsString()
  aisApiKey?: string | null;

  @IsOptional()
  @IsString()
  acledOauthUsername?: string | null;

  @IsOptional()
  @IsString()
  acledOauthPassword?: string | null;

  @IsOptional()
  @IsString()
  acledOauthClientId?: string | null;

  @IsOptional()
  @IsString()
  cloudflareApiToken?: string | null;

  @IsOptional()
  @IsString()
  wingbitsApiKey?: string | null;

  @IsOptional()
  @IsString()
  polymarketProxyUrl?: string | null;
}
