import { Module } from "@nestjs/common";

import { NewsEventsModule } from "../news-events/news-events.module";

import { PublicPortalController } from "./public-portal.controller";
import { PublicPortalService } from "./public-portal.service";

@Module({
  imports: [NewsEventsModule],
  controllers: [PublicPortalController],
  providers: [PublicPortalService],
  exports: [PublicPortalService],
})
export class PublicPortalModule {}
