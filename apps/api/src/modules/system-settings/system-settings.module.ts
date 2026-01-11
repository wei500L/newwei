import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { AuditLogSettingsController } from "./audit-log-settings.controller";
import { AuditLogSettingsService } from "./audit-log-settings.service";
import { AuthCacheSettingsController } from "./auth-cache-settings.controller";
import { LlmGatewaySettingsController } from "./llm-gateway-settings.controller";
import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";
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
    AuthCacheSettingsController,
    LlmGatewaySettingsController
  ],
  providers: [
    RateLimitConfigService,
    RateLimitPolicyService,
    AuditLogSettingsService,
    LlmGatewaySettingsService
  ],
  exports: [
    RateLimitConfigService,
    RateLimitPolicyService,
    AuditLogSettingsService,
    LlmGatewaySettingsService
  ]
})
export class SystemSettingsModule {}
