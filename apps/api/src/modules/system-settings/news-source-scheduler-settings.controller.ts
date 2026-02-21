import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateNewsSourceSchedulerSettingsDto } from "./dto/news-source-scheduler-settings.dto";
import { NewsSourceSchedulerSettingsService } from "./news-source-scheduler-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/news-source-scheduler")
export class NewsSourceSchedulerSettingsController {
  constructor(
    private readonly settings: NewsSourceSchedulerSettingsService,
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateNewsSourceSchedulerSettingsDto,
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }
}

