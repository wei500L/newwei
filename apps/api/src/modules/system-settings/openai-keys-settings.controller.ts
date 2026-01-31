import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateOpenAiKeysSettingsDto } from "./dto/openai-keys-settings.dto";
import { OpenAiKeysSettingsService } from "./openai-keys-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/openai-keys")
export class OpenAiKeysSettingsController {
  constructor(private readonly settings: OpenAiKeysSettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateOpenAiKeysSettingsDto
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Post()
  @Permissions("settings.manage")
  async appendKeys(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateOpenAiKeysSettingsDto) {
    return this.settings.appendKeys(user.orgId, user.id, body);
  }

  @Delete("key/:fingerprint")
  @Permissions("settings.manage")
  async removeKey(@CurrentUser() user: AuthenticatedUser, @Param("fingerprint") fingerprint: string) {
    return this.settings.removeKeyByFingerprint(user.orgId, user.id, fingerprint);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.reset(user.orgId, user.id);
  }
}
