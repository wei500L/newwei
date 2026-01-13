import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { Permissions } from "../../common/decorators/permissions.decorator";
import { GeocodingService } from "../geo/geocoding.service";

import { GeoNominatimTestDto } from "./dto/geo-nominatim-test.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/geo/nominatim")
export class GeoNominatimTestController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Post("test")
  @Permissions("settings.manage")
  async test(@Body() body: GeoNominatimTestDto) {
    const query = body.query.trim();
    const countryCodeAlpha2 = body.countryCodeAlpha2?.trim().toUpperCase();
    const result = await this.geocoding.geocode(query, {
      ...(countryCodeAlpha2 ? { countryCodeAlpha2 } : {})
    });
    return { result };
  }
}
