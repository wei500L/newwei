import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { VectorClientService } from "../vector/vector-client.service";

import { UpdateVectorServiceSettingsDto } from "./dto/vector-service-settings.dto";
import { VectorServiceSettingsService } from "./vector-service-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/vector-service")
export class VectorServiceSettingsController {
  constructor(
    private readonly settings: VectorServiceSettingsService,
    private readonly vectorClient: VectorClientService,
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Get("diagnostics")
  @Permissions("settings.manage")
  async getDiagnostics() {
    return this.vectorClient.getDiagnostics();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateVectorServiceSettingsDto
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToEnv(user.orgId, user.id);
  }
}
