import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import {
  CreateLlmGatewayDto,
  SetActiveLlmGatewayDto,
  UpdateLlmGatewayDto
} from "./dto/llm-gateway.dto";
import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/llm-gateways")
export class LlmGatewaySettingsController {
  constructor(private readonly settings: LlmGatewaySettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async list() {
    return this.settings.list();
  }

  @Post()
  @Permissions("settings.manage")
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateLlmGatewayDto) {
    return this.settings.createProfile(user.orgId, user.id, body);
  }

  @Put("active")
  @Permissions("settings.manage")
  async setActive(@CurrentUser() user: AuthenticatedUser, @Body() body: SetActiveLlmGatewayDto) {
    return this.settings.setActiveProfile(user.orgId, user.id, body.activeId ?? null);
  }

  @Put(":id")
  @Permissions("settings.manage")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: UpdateLlmGatewayDto
  ) {
    return this.settings.updateProfile(user.orgId, user.id, id, body);
  }

  @Delete(":id")
  @Permissions("settings.manage")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.settings.deleteProfile(user.orgId, user.id, id);
    return { ok: true };
  }
}
