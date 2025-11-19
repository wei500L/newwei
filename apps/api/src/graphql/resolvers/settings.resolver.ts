import { Args, Context, Mutation, Query, Resolver, UseGuards } from "@nestjs/graphql";
import { ForbiddenException } from "@nestjs/common";
import { RateLimitSettingsModel } from "../models/settings.model";
import { RateLimitConfigService } from "../../modules/system-settings/rate-limit-config.service";
import { UpdateRateLimitSettingsInput } from "../dto/settings.input";
import { HasPermission } from "../decorators/has-permission.decorator";
import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";

@Resolver(() => RateLimitSettingsModel)
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class SettingsResolver {
  constructor(private readonly rateLimitConfig: RateLimitConfigService) {}

  @HasPermission("settings.manage")
  @Query(() => RateLimitSettingsModel)
  async rateLimitSettings(): Promise<RateLimitSettingsModel> {
    return this.rateLimitConfig.getRateLimitSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => RateLimitSettingsModel)
  async updateRateLimitSettings(
    @Context("req") req: any,
    @Args("input") input: UpdateRateLimitSettingsInput
  ): Promise<RateLimitSettingsModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return this.rateLimitConfig.updateRateLimitSettings(user.id, input);
  }
}
