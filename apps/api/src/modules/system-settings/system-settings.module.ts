import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { AuditLogSettingsController } from "./audit-log-settings.controller";
import { AuditLogSettingsService } from "./audit-log-settings.service";
import { AuthCacheSettingsController } from "./auth-cache-settings.controller";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitSettingsController } from "./rate-limit-settings.controller";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [RateLimitSettingsController, AuditLogSettingsController, AuthCacheSettingsController],
  providers: [RateLimitConfigService, AuditLogSettingsService],
  exports: [RateLimitConfigService, AuditLogSettingsService]
})
export class SystemSettingsModule {}
