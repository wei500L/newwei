import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CreateRateLimitPolicyDto, UpdateRateLimitPolicyDto } from "./dto/rate-limit-policy.dto";
import { RateLimitPolicyService } from "./rate-limit-policy.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/rate-limit-policies")
export class RateLimitPolicyController {
  constructor(private readonly policies: RateLimitPolicyService) {}

  @Get()
  @Permissions("settings.manage")
  async list() {
    return this.policies.listPolicies();
  }

  @Get(":feature")
  @Permissions("settings.manage")
  async get(@Param("feature") feature: string) {
    const policy = await this.policies.getPolicy(feature);
    if (!policy) {
      throw new NotFoundException("Rate limit policy not found");
    }
    return policy;
  }

  @Post()
  @Permissions("settings.manage")
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRateLimitPolicyDto
  ) {
    const { feature, ...input } = body;
    return this.policies.createPolicy(user.orgId, user.id, feature, input);
  }

  @Put(":feature")
  @Permissions("settings.manage")
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("feature") feature: string,
    @Body() body: UpdateRateLimitPolicyDto
  ) {
    return this.policies.updatePolicy(user.orgId, user.id, feature, body);
  }

  @Delete(":feature")
  @Permissions("settings.manage")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("feature") feature: string) {
    await this.policies.deletePolicy(user.orgId, user.id, feature);
    return { ok: true };
  }
}
