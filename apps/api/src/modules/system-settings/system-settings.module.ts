import { Global, Module } from "@nestjs/common";
import { LlmRequestLogModel } from "@modular/mongo";

import { AkshareModule } from "../akshare/akshare.module";
import { AuthModule } from "../auth/auth.module";
import { GeoModule } from "../geo/geo.module";
import { RealtimeSignalsModule } from "../realtime-signals/realtime-signals.module";
import { SituationMonitorSignalsModule } from "../situation-monitor/signals/situation-monitor-signals.module";

import { AssistantSafetyDiagnosticsService } from "./assistant-safety-diagnostics.service";
import { AssistantSafetyMetricsService } from "./assistant-safety-metrics.service";
import { ArchivePreparationSettingsController } from "./archive-preparation-settings.controller";
import { ArchivePreparationSettingsService } from "./archive-preparation-settings.service";
import { AssistantSafetySettingsController } from "./assistant-safety-settings.controller";
import { AssistantSafetySettingsService } from "./assistant-safety-settings.service";
import { AuditLogSettingsController } from "./audit-log-settings.controller";
import { AuditLogSettingsService } from "./audit-log-settings.service";
import { AuthCacheSettingsController } from "./auth-cache-settings.controller";
import { EmailSettingsController } from "./email-settings.controller";
import { EntityImpactGraphSettingsService } from "./entity-impact-graph-settings.service";
import { FinancialDataProviderSettingsService } from "./financial-data-provider-settings.service";
import { GeoNominatimSettingsController } from "./geo-nominatim-settings.controller";
import { GeoNominatimSettingsService } from "./geo-nominatim-settings.service";
import { GeoNominatimTestController } from "./geo-nominatim-test.controller";
import { LlmGatewaySettingsController } from "./llm-gateway-settings.controller";
import { LlmGatewaySettingsService } from "./llm-gateway-settings.service";
import { LlmRequestLogSettingsController } from "./llm-request-log-settings.controller";
import { LlmRequestLogSettingsService } from "./llm-request-log-settings.service";
import { LlmGatewayTestService } from "./llm-gateway-test.service";
import { LiteLlmProxyGovernanceService } from "./litellm-proxy-governance.service";
import { LiteLlmProxyLoadBalancingSettingsService } from "./litellm-proxy-lb-settings.service";
import { ModelServiceSettingsController } from "./model-service-settings.controller";
import { ModelServiceSettingsService } from "./model-service-settings.service";
import { NewsSourceRuntimeSecretsController } from "./news-source-runtime-secrets.controller";
import { NewsSourceRuntimeSecretsService } from "./news-source-runtime-secrets.service";
import { NewsSourceSchedulerSettingsController } from "./news-source-scheduler-settings.controller";
import { NewsSourceSchedulerSettingsService } from "./news-source-scheduler-settings.service";
import { NewsnowPersonalizationSettingsController } from "./newsnow-personalization-settings.controller";
import { NewsnowPersonalizationSettingsService } from "./newsnow-personalization-settings.service";
import { OpenAiKeysInternalController } from "./openai-keys-internal.controller";
import { OpenAiKeysSettingsController } from "./openai-keys-settings.controller";
import { OpenAiKeysSettingsService } from "./openai-keys-settings.service";
import { RateLimitConfigService } from "./rate-limit-config.service";
import { RateLimitPolicyController } from "./rate-limit-policy.controller";
import { RateLimitPolicyService } from "./rate-limit-policy.service";
import { RateLimitSettingsController } from "./rate-limit-settings.controller";
import { RealtimeSignalsSettingsController } from "./realtime-signals-settings.controller";
import { RealtimeSignalsSettingsService } from "./realtime-signals-settings.service";
import { RssDiagnosticsController } from "./rss-diagnostics.controller";
import { RssDiagnosticsService } from "./rss-diagnostics.service";
import { RssTranslationMetricsController } from "./rss-translation-metrics.controller";
import { RssTranslationMetricsService } from "./rss-translation-metrics.service";
import { SituationMonitorSettingsController } from "./situation-monitor-settings.controller";
import { SituationMonitorSettingsService } from "./situation-monitor-settings.service";
import { SituationMonitorTelegramAuthService } from "./situation-monitor-telegram-auth.service";
import { SystemSecuritySettingsController } from "./system-security-settings.controller";
import { SystemSecuritySettingsService } from "./system-security-settings.service";
import { TaskLogSettingsController } from "./task-log-settings.controller";
import { TaskLogSettingsService } from "./task-log-settings.service";
import { VectorServiceSettingsController } from "./vector-service-settings.controller";
import { VectorServiceSettingsService } from "./vector-service-settings.service";
import { LLM_REQUEST_LOG_MODEL } from "../news-pipeline/llm-request-log.service";
import { ObservabilitySnapshotService } from "../observability/observability-snapshot.service";

@Global()
@Module({
  imports: [
    AkshareModule,
    AuthModule,
    GeoModule,
    RealtimeSignalsModule,
    SituationMonitorSignalsModule,
  ],
  controllers: [
    RateLimitSettingsController,
    RateLimitPolicyController,
    ArchivePreparationSettingsController,
    AuditLogSettingsController,
    TaskLogSettingsController,
    AuthCacheSettingsController,
    EmailSettingsController,
    GeoNominatimSettingsController,
    GeoNominatimTestController,
    LlmGatewaySettingsController,
    AssistantSafetySettingsController,
    OpenAiKeysSettingsController,
    OpenAiKeysInternalController,
    SystemSecuritySettingsController,
    ModelServiceSettingsController,
    LlmRequestLogSettingsController,
    NewsSourceRuntimeSecretsController,
    NewsSourceSchedulerSettingsController,
    NewsnowPersonalizationSettingsController,
    SituationMonitorSettingsController,
    RealtimeSignalsSettingsController,
    VectorServiceSettingsController,
    RssTranslationMetricsController,
    RssDiagnosticsController,
  ],
  providers: [
    RateLimitConfigService,
    RateLimitPolicyService,
    ArchivePreparationSettingsService,
    AuditLogSettingsService,
    TaskLogSettingsService,
    GeoNominatimSettingsService,
    FinancialDataProviderSettingsService,
    {
      provide: LLM_REQUEST_LOG_MODEL,
      useValue: LlmRequestLogModel,
    },
    LlmGatewaySettingsService,
    LlmGatewayTestService,
    LiteLlmProxyGovernanceService,
    LiteLlmProxyLoadBalancingSettingsService,
    SystemSecuritySettingsService,
    EntityImpactGraphSettingsService,
    ModelServiceSettingsService,
    LlmRequestLogSettingsService,
    NewsSourceRuntimeSecretsService,
    NewsSourceSchedulerSettingsService,
    NewsnowPersonalizationSettingsService,
    SituationMonitorSettingsService,
    SituationMonitorTelegramAuthService,
    RealtimeSignalsSettingsService,
    VectorServiceSettingsService,
    AssistantSafetySettingsService,
    AssistantSafetyDiagnosticsService,
    AssistantSafetyMetricsService,
    OpenAiKeysSettingsService,
    ObservabilitySnapshotService,
    RssTranslationMetricsService,
    RssDiagnosticsService,
  ],
  exports: [
    RateLimitConfigService,
    RateLimitPolicyService,
    ArchivePreparationSettingsService,
    AuditLogSettingsService,
    TaskLogSettingsService,
    GeoNominatimSettingsService,
    FinancialDataProviderSettingsService,
    LlmGatewaySettingsService,
    LiteLlmProxyGovernanceService,
    LiteLlmProxyLoadBalancingSettingsService,
    AssistantSafetySettingsService,
    OpenAiKeysSettingsService,
    SystemSecuritySettingsService,
    EntityImpactGraphSettingsService,
    ModelServiceSettingsService,
    LlmRequestLogSettingsService,
    NewsSourceRuntimeSecretsService,
    NewsSourceSchedulerSettingsService,
    NewsnowPersonalizationSettingsService,
    SituationMonitorSettingsService,
    RealtimeSignalsSettingsService,
    VectorServiceSettingsService,
    RssTranslationMetricsService,
    RssDiagnosticsService,
  ],
})
export class SystemSettingsModule {}
