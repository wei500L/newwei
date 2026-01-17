import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { Permissions } from "../../common/decorators/permissions.decorator";

import { GeoGeocodeDto } from "./dto/geo-geocode.dto";
import { GeocodingService } from "./geocoding.service";

@ApiTags("geo")
@ApiBearerAuth()
@Controller("geo")
export class GeoController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Permissions("items.read")
  @Post("geocode")
  async geocode(@Body() body: GeoGeocodeDto) {
    const query = body.query.trim();
    const countryCodeAlpha2 = body.countryCodeAlpha2?.trim().toUpperCase();
    const result = await this.geocoding.geocode(query, {
      ...(countryCodeAlpha2 ? { countryCodeAlpha2 } : {})
    });
    return { result };
  }
}

