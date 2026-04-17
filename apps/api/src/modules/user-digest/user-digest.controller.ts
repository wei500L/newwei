import { Body, Controller, Get, Header, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateUserDigestDeliveryDto } from "./dto/update-user-digest-delivery.dto";
import { UpdateUserDigestPreferenceDto } from "./dto/update-user-digest-preference.dto";
import { UserDigestDeliveryService } from "./user-digest-delivery.service";
import { UserDigestService } from "./user-digest.service";

@ApiTags("user-digest")
@ApiBearerAuth()
@Controller("user-digest")
export class UserDigestController {
  constructor(
    private readonly digest: UserDigestService,
    private readonly delivery: UserDigestDeliveryService,
  ) {}

  @Get("preference")
  @Header("Cache-Control", "no-store")
  @Permissions("items.read")
  async getPreference(@CurrentUser() user: AuthenticatedUser) {
    return this.digest.getPreference(user.orgId, user.id);
  }

  @Put("preference")
  @Permissions("items.read")
  async updatePreference(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateUserDigestPreferenceDto) {
    return this.digest.updatePreference(user.orgId, user.id, body);
  }

  @Get("delivery")
  @Header("Cache-Control", "no-store")
  @Permissions("items.read")
  async getDelivery(@CurrentUser() user: AuthenticatedUser) {
    return this.delivery.getDelivery(user.orgId, user.id);
  }

  @Put("delivery")
  @Permissions("items.read")
  async updateDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateUserDigestDeliveryDto,
  ) {
    return this.delivery.updateDelivery(user.orgId, user.id, body);
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @Permissions("items.read")
  async getDigest(@CurrentUser() user: AuthenticatedUser) {
    return this.digest.generateDigest(user.orgId, user.id);
  }
}
