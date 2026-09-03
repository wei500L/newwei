import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";
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
    private readonly platformAccess: PlatformAccessService,
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
    // SEC-01: the vector service config is a GLOBAL singleton (no org
    // dimension). It carries the x-internal-token that the API attaches to
    // every vector call, and the baseUrl the client will send that token to —
    // so a plain org admin with settings.manage could exfiltrate the real
    // internal token by pointing baseUrl at their own server. Only platform
    // admins may change it.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    // Same SEC-01 boundary as PUT: reset removes the stored global config,
    // effectively re-pointing every tenant's vector traffic at the env default.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.resetToEnv(user.orgId, user.id);
  }
}
