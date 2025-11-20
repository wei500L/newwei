import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { UpdateRateLimitSettingsDto } from "./dto/rate-limit-settings.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/rate-limits")
export class RateLimitSettingsController {
  constructor(private readonly rateLimitConfig: RateLimitConfigService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.rateLimitConfig.getRateLimitSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateRateLimitSettingsDto
  ) {
    return this.rateLimitConfig.updateRateLimitSettings(user.orgId, user.id, body);
  }
}
