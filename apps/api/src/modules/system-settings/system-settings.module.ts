import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { GeoModule } from "../geo/geo.module";

import { AuditLogSettingsController } from "./audit-log-settings.controller";
import { AuditLogSettingsService } from "./audit-log-settings.service";
import { AuthCacheSettingsController } from "./auth-cache-settings.controller";
import { EmailSettingsController } from "./email-settings.controller";
import { GeoNominatimSettingsController } from "./geo-nominatim-settings.controller";
import { GeoNominatimSettingsService } from "./geo-nominatim-settings.service";
import { GeoNominatimTestController } from "./geo-nominatim-test.controller";
import { LlmGatewaySettingsController } from "./llm-gateway-settings.controller";
import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";
import { EntityImpactGraphSettingsService } from "./entity-impact-graph-settings.service";
import { ModelServiceSettingsController } from "./model-service-settings.controller";
import { ModelServiceSettingsService } from "./model-service-settings.service";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitPolicyController } from "./rate-limit-policy.controller";
import { RateLimitPolicyService } from "./rate-limit-policy.service";
import { RateLimitSettingsController } from "./rate-limit-settings.controller";
import { VectorServiceSettingsController } from "./vector-service-settings.controller";
import { VectorServiceSettingsService } from "./vector-service-settings.service";

@Global()
@Module({
  imports: [AuthModule, GeoModule],
  controllers: [
    RateLimitSettingsController,
    RateLimitPolicyController,
    AuditLogSettingsController,
    AuthCacheSettingsController,
    EmailSettingsController,
    GeoNominatimSettingsController,
    GeoNominatimTestController,
    LlmGatewaySettingsController,
    ModelServiceSettingsController,
    VectorServiceSettingsController
  ],
  providers: [
    RateLimitConfigService,
    RateLimitPolicyService,
    AuditLogSettingsService,
    GeoNominatimSettingsService,
    LlmGatewaySettingsService,
    EntityImpactGraphSettingsService,
    ModelServiceSettingsService,
    VectorServiceSettingsService
  ],
  exports: [
    RateLimitConfigService,
    RateLimitPolicyService,
    AuditLogSettingsService,
    GeoNominatimSettingsService,
    LlmGatewaySettingsService,
    EntityImpactGraphSettingsService,
    ModelServiceSettingsService,
    VectorServiceSettingsService
  ]
})
export class SystemSettingsModule {}
