import { Global, Module } from "@nestjs/common";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitSettingsController } from "./rate-limit-settings.controller";
import { AuditLogSettingsService } from "./audit-log-settings.service";
import { AuditLogSettingsController } from "./audit-log-settings.controller";

@Global()
@Module({
  imports: [],
  controllers: [RateLimitSettingsController, AuditLogSettingsController],
  providers: [RateLimitConfigService, AuditLogSettingsService],
  exports: [RateLimitConfigService, AuditLogSettingsService]
})
export class SystemSettingsModule {}
