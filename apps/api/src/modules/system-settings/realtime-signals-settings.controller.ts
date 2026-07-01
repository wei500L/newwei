import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateRealtimeSignalsSettingsDto } from "./dto/realtime-signals-settings.dto";
import { RealtimeSignalsSettingsService } from "./realtime-signals-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/realtime-signals")
export class RealtimeSignalsSettingsController {
  constructor(private readonly settings: RealtimeSignalsSettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateRealtimeSignalsSettingsDto,
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToEnv(user.orgId, user.id);
  }
}
