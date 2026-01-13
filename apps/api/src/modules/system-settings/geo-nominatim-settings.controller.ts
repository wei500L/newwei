import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateGeoNominatimSettingsDto } from "./dto/geo-nominatim-settings.dto";
import { GeoNominatimSettingsService } from "./geo-nominatim-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/geo/nominatim")
export class GeoNominatimSettingsController {
  constructor(private readonly settings: GeoNominatimSettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateGeoNominatimSettingsDto
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }
}

