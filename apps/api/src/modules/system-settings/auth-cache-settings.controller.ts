import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { AuthCacheSettingsService } from "../auth/auth-cache-settings.service";
import { UpdateAuthCacheSettingsDto } from "./dto/auth-cache-settings.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/auth-cache")
export class AuthCacheSettingsController {
  constructor(private readonly authCacheSettings: AuthCacheSettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.authCacheSettings.getSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateAuthCacheSettingsDto
  ) {
    return this.authCacheSettings.updateSettings(user.orgId, user.id, body);
  }
}
