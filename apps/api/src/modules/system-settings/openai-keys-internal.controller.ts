import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { EnvService } from "../config/config.service";

import { LiteLlmProxyLoadBalancingSettingsService } from "./litellm-proxy-lb-settings.service";
import { ReportLiteLlmOpenAiKeysAppliedDto } from "./dto/litellm-openai-keys-applied.dto";
import { OpenAiKeysSettingsService } from "./openai-keys-settings.service";

@ApiTags("internal")
@Public()
@Controller("internal/litellm")
export class OpenAiKeysInternalController {
  constructor(
    private readonly env: EnvService,
    private readonly openaiKeys: OpenAiKeysSettingsService,
    private readonly proxyLoadBalancing: LiteLlmProxyLoadBalancingSettingsService,
  ) {}

  @Get("openai-keys")
  async getOpenAiKeys(
    @Headers("authorization") authorization: string | undefined,
  ) {
    const expected = this.env.liteLlmConfigInternalToken;
    if (!expected) {
      throw new ForbiddenException(
        "LITELLM_CONFIG_INTERNAL_TOKEN is not configured",
      );
    }

    const token = this.extractBearerToken(authorization);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    if (token !== expected) {
      throw new UnauthorizedException("Invalid bearer token");
    }

    const keys = await this.openaiKeys.getPlaintextKeys();
    return { openaiApiKeys: keys };
  }

  @Post("openai-keys/applied")
  async reportAppliedOpenAiKeys(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: ReportLiteLlmOpenAiKeysAppliedDto,
  ) {
    const expected = this.env.liteLlmConfigInternalToken;
    if (!expected) {
      throw new ForbiddenException(
        "LITELLM_CONFIG_INTERNAL_TOKEN is not configured",
      );
    }

    const token = this.extractBearerToken(authorization);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    if (token !== expected) {
      throw new UnauthorizedException("Invalid bearer token");
    }

    await this.openaiKeys.reportAppliedKeyFingerprints({
      source: body.source,
      keyFingerprints: body.keyFingerprints,
    });
    return { ok: true };
  }

  @Get("proxy-load-balancing")
  async getProxyLoadBalancingSnapshot(
    @Headers("authorization") authorization: string | undefined,
  ) {
    const expected = this.env.liteLlmConfigInternalToken;
    if (!expected) {
      throw new ForbiddenException(
        "LITELLM_CONFIG_INTERNAL_TOKEN is not configured",
      );
    }

    const token = this.extractBearerToken(authorization);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    if (token !== expected) {
      throw new UnauthorizedException("Invalid bearer token");
    }

    return this.proxyLoadBalancing.getInternalSnapshot();
  }

  private extractBearerToken(header: string | undefined): string | null {
    if (!header) {
      return null;
    }
    const trimmed = header.trim();
    if (!trimmed) {
      return null;
    }
    const match = trimmed.match(/^bearer\s+(.+)$/i);
    if (!match?.[1]) {
      return null;
    }
    const token = match[1].trim();
    return token ? token : null;
  }
}
