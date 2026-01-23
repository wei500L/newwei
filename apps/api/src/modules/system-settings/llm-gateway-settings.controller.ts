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
import { LlmGatewayTestDto } from "./dto/llm-gateway-test.dto";
import { LlmGatewayModelsConfigDto, LlmGatewayTestConfigDto } from "./dto/llm-gateway-test-config.dto";
import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";
import { LlmGatewayTestService } from "./llm-gateway-test.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/llm-gateways")
export class LlmGatewaySettingsController {
  constructor(
    private readonly settings: LlmGatewaySettingsService,
    private readonly tester: LlmGatewayTestService
  ) {}

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

  @Post(":id/test")
  @Permissions("settings.manage")
  async test(@Param("id") id: string, @Body() body: LlmGatewayTestDto) {
    return this.tester.testProfile(id, body);
  }

  @Post("test-config")
  @Permissions("settings.manage")
  async testConfig(@Body() body: LlmGatewayTestConfigDto) {
    return this.tester.testConfig(body);
  }

  @Get(":id/models")
  @Permissions("settings.manage")
  async listModels(@Param("id") id: string) {
    return this.tester.listModels(id);
  }

  @Post("models-config")
  @Permissions("settings.manage")
  async listModelsConfig(@Body() body: LlmGatewayModelsConfigDto) {
    return this.tester.listModelsConfig(body);
  }
}
