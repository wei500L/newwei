import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { AuditLogSettingsController } from "./audit-log-settings.controller";
import { AuditLogSettingsService } from "./audit-log-settings.service";
import { AuthCacheSettingsController } from "./auth-cache-settings.controller";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitPolicyController } from "./rate-limit-policy.controller";
import { RateLimitPolicyService } from "./rate-limit-policy.service";
import { RateLimitSettingsController } from "./rate-limit-settings.controller";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [
    RateLimitSettingsController,
    RateLimitPolicyController,
    AuditLogSettingsController,
    AuthCacheSettingsController
  ],
  providers: [RateLimitConfigService, RateLimitPolicyService, AuditLogSettingsService],
  exports: [RateLimitConfigService, RateLimitPolicyService, AuditLogSettingsService]
})
export class SystemSettingsModule {}
