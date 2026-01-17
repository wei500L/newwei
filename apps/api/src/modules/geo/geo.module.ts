import { Module } from "@nestjs/common";

import { GeoController } from "./geo.controller";
import { GeocodingService } from "./geocoding.service";

@Module({
  controllers: [GeoController],
  providers: [GeocodingService],
  exports: [GeocodingService]
})
export class GeoModule {}
