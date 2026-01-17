import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateUserDigestPreferenceDto } from "./dto/update-user-digest-preference.dto";
import { UserDigestService } from "./user-digest.service";

@ApiTags("user-digest")
@ApiBearerAuth()
@Controller("user-digest")
export class UserDigestController {
  constructor(private readonly digest: UserDigestService) {}

  @Get("preference")
  @Permissions("items.read")
  async getPreference(@CurrentUser() user: AuthenticatedUser) {
    return this.digest.getPreference(user.orgId, user.id);
  }

  @Put("preference")
  @Permissions("items.read")
  async updatePreference(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateUserDigestPreferenceDto) {
    return this.digest.updatePreference(user.orgId, user.id, body);
  }

  @Get()
  @Permissions("items.read")
  async getDigest(@CurrentUser() user: AuthenticatedUser) {
    return this.digest.generateDigest(user.orgId, user.id);
  }
}

