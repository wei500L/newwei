import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { AssistantQuotaSettingsService } from "./assistant-quota-settings.service";
import { UpdateAssistantQuotaSettingsDto } from "./dto/assistant-quota-settings.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/assistant-quota")
export class AssistantQuotaSettingsController {
  constructor(private readonly settings: AssistantQuotaSettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.getPublicSettings(user.orgId);
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateAssistantQuotaSettingsDto
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToEnv(user.orgId, user.id);
  }
}
