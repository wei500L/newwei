import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateSituationMonitorUiSettingsDto } from "./dto/situation-monitor-ui-settings.dto";
import { UpdateWarMapUiSettingsDto } from "./dto/war-map-ui-settings.dto";
import { UserSettingsService } from "./user-settings.service";

@ApiTags("user-settings")
@ApiBearerAuth()
@Controller("user-settings/ui")
export class UserUiSettingsController {
  constructor(private readonly settings: UserSettingsService) {}

  @Get("situation-monitor")
  @Permissions("items.read")
  async getSituationMonitorUiSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.getSituationMonitorUiSettings(user.orgId, user.id);
  }

  @Put("situation-monitor")
  @Permissions("items.read")
  async updateSituationMonitorUiSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSituationMonitorUiSettingsDto
  ) {
    return this.settings.updateSituationMonitorUiSettings(user.orgId, user.id, body);
  }

  @Get("war-map")
  @Permissions("items.read")
  async getWarMapUiSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.getWarMapUiSettings(user.orgId, user.id);
  }

  @Put("war-map")
  @Permissions("items.read")
  async updateWarMapUiSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateWarMapUiSettingsDto) {
    return this.settings.updateWarMapUiSettings(user.orgId, user.id, body);
  }
}
