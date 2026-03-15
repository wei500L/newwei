import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import {
  LlmGatewayModelsConfigDto,
  LlmGatewayTestConfigDto,
} from "./dto/llm-gateway-test-config.dto";
import { UpdateLlmGatewayProxyGovernanceDto } from "./dto/llm-gateway-proxy-governance.dto";
import { UpdateLlmGatewayProxyLoadBalancingSettingsDto } from "./dto/llm-gateway-proxy-lb-settings.dto";
import { LlmGatewayTestDto } from "./dto/llm-gateway-test.dto";
import { LlmGatewayProxyLoadBalancingTestDto } from "./dto/llm-gateway-proxy-lb-test.dto";
import { LiteLlmProxyGovernanceService } from "./litellm-proxy-governance.service";
import { LiteLlmProxyLoadBalancingSettingsService } from "./litellm-proxy-lb-settings.service";
import {
  CreateLlmGatewayDto,
  SetEmbeddingActiveLlmGatewayDto,
  SetRerankActiveLlmGatewayDto,
  SetActiveLlmGatewayDto,
  UpdateLlmGatewayDto,
} from "./dto/llm-gateway.dto";
import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";
import { LlmGatewayTestService } from "./llm-gateway-test.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/llm-gateways")
export class LlmGatewaySettingsController {
  constructor(
    private readonly settings: LlmGatewaySettingsService,
    private readonly tester: LlmGatewayTestService,
    private readonly proxyGovernance: LiteLlmProxyGovernanceService,
    private readonly proxyLoadBalancing: LiteLlmProxyLoadBalancingSettingsService,
  ) {}

  @Get()
  @Permissions("settings.manage")
  async list() {
    return this.settings.list();
  }

  @Post()
  @Permissions("settings.manage")
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateLlmGatewayDto,
  ) {
    return this.settings.createProfile(user.orgId, user.id, body);
  }

  @Put("active")
  @Permissions("settings.manage")
  async setActive(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetActiveLlmGatewayDto,
  ) {
    return this.settings.setActiveProfile(
      user.orgId,
      user.id,
      body.activeId ?? null,
    );
  }

  @Put("embedding-active")
  @Permissions("settings.manage")
  async setEmbeddingActive(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetEmbeddingActiveLlmGatewayDto,
  ) {
    return this.settings.setEmbeddingActiveProfile(
      user.orgId,
      user.id,
      body.activeId ?? null,
      body.mode,
    );
  }

  @Put("rerank-active")
  @Permissions("settings.manage")
  async setRerankActive(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetRerankActiveLlmGatewayDto,
  ) {
    return this.settings.setRerankActiveProfile(
      user.orgId,
      user.id,
      body.activeId ?? null,
      body.mode,
    );
  }

  @Get("proxy-governance")
  @Permissions("settings.manage")
  async getProxyGovernanceSettings() {
    return this.proxyGovernance.getPublicSettings();
  }

  @Put("proxy-governance")
  @Permissions("settings.manage")
  async updateProxyGovernanceSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateLlmGatewayProxyGovernanceDto,
  ) {
    return this.proxyGovernance.updateSettings(user.orgId, user.id, body);
  }

  @Delete("proxy-governance")
  @Permissions("settings.manage")
  async resetProxyGovernanceSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.proxyGovernance.resetToDefaults(user.orgId, user.id);
  }

  @Post("proxy-governance/rotate-key")
  @Permissions("settings.manage")
  async rotateProxyGovernanceKey(@CurrentUser() user: AuthenticatedUser) {
    return this.proxyGovernance.rotateManagedRuntimeKey(user.orgId, user.id);
  }

  @Get("proxy-load-balancing")
  @Permissions("settings.manage")
  async getProxyLoadBalancingSettings() {
    return this.proxyLoadBalancing.getPublicSettings();
  }

  @Put("proxy-load-balancing")
  @Permissions("settings.manage")
  async updateProxyLoadBalancingSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateLlmGatewayProxyLoadBalancingSettingsDto,
  ) {
    return this.proxyLoadBalancing.updateSettings(user.orgId, user.id, body);
  }

  @Delete("proxy-load-balancing")
  @Permissions("settings.manage")
  async resetProxyLoadBalancingSettings(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.proxyLoadBalancing.resetToDisabled(user.orgId, user.id);
  }

  @Put(":id")
  @Permissions("settings.manage")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: UpdateLlmGatewayDto,
  ) {
    return this.settings.updateProfile(user.orgId, user.id, id, body);
  }

  @Delete(":id")
  @Permissions("settings.manage")
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
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

  @Get(":id/proxy-health")
  @Permissions("settings.manage")
  async proxyHealth(@Param("id") id: string) {
    return this.tester.checkProxyHealth(id);
  }

  @Get(":id/proxy-model-info")
  @Permissions("settings.manage")
  async proxyModelInfo(
    @Param("id") id: string,
    @Query("force") force?: string,
  ) {
    return this.tester.getProxyModelInfo(id, {
      force: force === "1" || force === "true",
    });
  }

  @Post(":id/proxy-lb-test")
  @Permissions("settings.manage")
  async proxyLoadBalancingTest(
    @Param("id") id: string,
    @Body() body: LlmGatewayProxyLoadBalancingTestDto,
  ) {
    return this.tester.testProxyLoadBalancing(id, body);
  }

  @Post("models-config")
  @Permissions("settings.manage")
  async listModelsConfig(@Body() body: LlmGatewayModelsConfigDto) {
    return this.tester.listModelsConfig(body);
  }
}
