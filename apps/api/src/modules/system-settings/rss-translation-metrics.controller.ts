import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { RssTranslationMetricsService } from "./rss-translation-metrics.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/rss-translation")
export class RssTranslationMetricsController {
  constructor(private readonly metrics: RssTranslationMetricsService) {}

  @Get("metrics")
  @Permissions("settings.manage")
  async getMetrics(
    @CurrentUser() user: AuthenticatedUser,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("provider") providerRaw: string | undefined,
    @Query("targetLanguage") targetLanguage: string | undefined
  ) {
    const provider = providerRaw?.trim().toLowerCase();
    if (provider && provider !== "deeplx" && provider !== "llm") {
      throw new BadRequestException("provider must be one of: deeplx, llm");
    }

    return this.metrics.getDailyMetrics(user.orgId, {
      from,
      to,
      provider,
      targetLanguage
    });
  }
}
