import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateTaskLogSettingsDto } from "./dto/task-log-settings.dto";
import { TaskLogSettingsService } from "./task-log-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/task-logs")
export class TaskLogSettingsController {
  constructor(private readonly settings: TaskLogSettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateTaskLogSettingsDto,
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body.retentionDays);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToDefault(user.orgId, user.id);
  }
}
