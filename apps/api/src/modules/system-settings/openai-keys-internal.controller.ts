import { createLogger } from "@modular/utils";
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { LitellmInternalTokenGuard } from "../../common/guards/litellm-internal-token.guard";
import { resolveRequestIp } from "../../common/request-ip";

import { ReportLiteLlmOpenAiKeysAppliedDto } from "./dto/litellm-openai-keys-applied.dto";
import { LiteLlmProxyLoadBalancingSettingsService } from "./litellm-proxy-lb-settings.service";
import { OpenAiKeysSettingsService } from "./openai-keys-settings.service";

const logger = createLogger({ name: "openai-keys-internal" });

@ApiTags("internal")
@Public()
@UseGuards(LitellmInternalTokenGuard)
@Controller("internal/litellm")
export class OpenAiKeysInternalController {
  constructor(
    private readonly openaiKeys: OpenAiKeysSettingsService,
    private readonly proxyLoadBalancing: LiteLlmProxyLoadBalancingSettingsService,
  ) {}

  @Get("openai-keys")
  async getOpenAiKeys(@Req() request: Request) {
    const keys = await this.openaiKeys.getPlaintextKeys();
    logger.info(
      { sourceIp: resolveRequestIp(request) ?? null, keyCount: keys.length },
      "Fetched plaintext OpenAI keys via internal endpoint",
    );
    return { openaiApiKeys: keys };
  }

  @Post("openai-keys/applied")
  async reportAppliedOpenAiKeys(
    @Body() body: ReportLiteLlmOpenAiKeysAppliedDto,
  ) {
    await this.openaiKeys.reportAppliedKeyFingerprints({
      source: body.source,
      keyFingerprints: body.keyFingerprints,
    });
    return { ok: true };
  }

  @Get("proxy-load-balancing")
  async getProxyLoadBalancingSnapshot() {
    return this.proxyLoadBalancing.getInternalSnapshot();
  }
}
