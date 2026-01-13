import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateStorageSettingsDto } from "./dto/storage-settings.dto";
import { StorageSettingsService } from "./storage-settings.service";
import { StorageService } from "./storage.service";

@ApiTags("storage-settings")
@ApiBearerAuth()
@Controller("admin/settings/storage")
export class StorageSettingsController {
  constructor(
    private readonly storageSettings: StorageSettingsService,
    private readonly storageService: StorageService
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.storageSettings.getAdminSettings();
  }

  @Patch()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateStorageSettingsDto
  ) {
    return this.storageSettings.updateStorageSettings(user.orgId, user.id, body);
  }

  @Post("test")
  @Permissions("settings.manage")
  async testConnection() {
    return this.storageService.testConnection();
  }
}
