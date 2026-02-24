import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateNewsSourceRuntimeSecretsDto } from "./dto/news-source-runtime-secrets.dto";
import { NewsSourceRuntimeSecretsService } from "./news-source-runtime-secrets.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/news-source-runtime-secrets")
export class NewsSourceRuntimeSecretsController {
  constructor(private readonly settings: NewsSourceRuntimeSecretsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateNewsSourceRuntimeSecretsDto
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }
}
