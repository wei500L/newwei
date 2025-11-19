import { Global, Module } from "@nestjs/common";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitSettingsController } from "./rate-limit-settings.controller";

@Global()
@Module({
  imports: [],
  controllers: [RateLimitSettingsController],
  providers: [RateLimitConfigService],
  exports: [RateLimitConfigService]
})
export class SystemSettingsModule {}
