'use client';

import type { ComponentType } from 'react';

import {
  AssistantSafetySettingsPanel,
} from '@/components/settings/assistant-safety-settings-panel';
import {
  ArchivePreparationSettingsPanel,
} from '@/components/settings/archive-preparation-settings-panel';
import { EmailSettingsPanel } from '@/components/settings/email-settings-panel';
import {
  EntityImpactGraphSettingsPanel,
} from '@/components/settings/entity-impact-graph-settings-panel';
import {
  GeoNominatimSettingsPanel,
} from '@/components/settings/geo-nominatim-settings-panel';
import {
  KnowledgeGraphReviewPanel,
} from '@/components/settings/knowledge-graph-review-panel';
import {
  KnowledgeGraphSettingsPanel,
} from '@/components/settings/knowledge-graph-settings-panel';
import {
  LlmGatewaySettingsPanel,
} from '@/components/settings/llm-gateway-settings-panel';
import {
  LlmRequestLogsPanel,
} from '@/components/settings/llm-request-logs-panel';
import {
  ModelServiceSettingsPanel,
} from '@/components/settings/model-service-settings-panel';
import {
  MultiTenantSchedulerSettingsPanel,
} from '@/components/settings/multi-tenant-scheduler-settings-panel';
import {
  NewsClassificationSettingsPanel,
} from '@/components/settings/news-classification-settings-panel';
import { NewsDedupeSettingsPanel } from '@/components/settings/news-dedupe-settings-panel';
import {
  NewsEventsSettingsPanel,
} from '@/components/settings/news-events-settings-panel';
import {
  NewsEventSourcePolicySettingsPanel,
} from '@/components/settings/news-event-source-policy-settings-panel';
import {
  NewsIndicatorSettingsPanel,
} from '@/components/settings/news-indicator-settings-panel';
import {
  NewsSourceRuntimeSecretsPanel,
} from '@/components/settings/news-source-runtime-secrets-panel';
import {
  NewsSourceSchedulerSettingsPanel,
} from '@/components/settings/news-source-scheduler-settings-panel';
import {
  NewsnowPersonalizationSettingsPanel,
} from '@/components/settings/newsnow-personalization-settings-panel';
import {
  RateLimitPoliciesPanel,
} from '@/components/settings/rate-limit-policies-panel';
import {
  RealtimeSignalsSettingsPanel,
} from '@/components/settings/realtime-signals-settings-panel';
import {
  RssDiagnosticsPanel,
} from '@/components/settings/rss-diagnostics-panel';
import {
  RssTranslationMetricsPanel,
} from '@/components/settings/rss-translation-metrics-panel';
import {
  SituationMonitorSettingsPanel,
} from '@/components/settings/situation-monitor-settings-panel';
import {
  SystemSecuritySettingsPanel,
} from '@/components/settings/system-security-settings-panel';
import {
  VectorServiceSettingsPanel,
} from '@/components/settings/vector-service-settings-panel';
import {
  AkshareGatewaySettingsPanel,
  AuditLogRetentionPanel,
  AuthCacheSettingsPanel,
  CrawlClientSettingsPanel,
  NewsPromptSettingsPanel,
  RateLimitSettingsPanel,
  StorageSettingsContent,
  TaskLogSettingsPanel,
} from '@/components/settings/workspace-shared-settings-panels';

import type { AdminSettingsPanelId } from './settings-navigation';

type WorkspacePanelId = Exclude<
  AdminSettingsPanelId,
  'roles' | 'permissions' | 'members'
>;

const PANEL_COMPONENTS: Record<WorkspacePanelId, ComponentType> = {
  security: SystemSecuritySettingsPanel,
  'auth-cache': AuthCacheSettingsPanel,
  'rate-limits': RateLimitSettingsPanel,
  'rate-limit-policies': RateLimitPoliciesPanel,
  'audit-log': AuditLogRetentionPanel,
  'crawl-client': CrawlClientSettingsPanel,
  'archive-preparation': ArchivePreparationSettingsPanel,
  'multi-tenant-schedulers': MultiTenantSchedulerSettingsPanel,
  'news-source-scheduler': NewsSourceSchedulerSettingsPanel,
  'news-source-runtime-secrets': NewsSourceRuntimeSecretsPanel,
  storage: StorageSettingsContent,
  'llm-gateway': LlmGatewaySettingsPanel,
  'llm-request-logs': LlmRequestLogsPanel,
  'assistant-safety': AssistantSafetySettingsPanel,
  'vector-service': VectorServiceSettingsPanel,
  'model-service': ModelServiceSettingsPanel,
  'knowledge-graph': KnowledgeGraphSettingsPanel,
  'knowledge-graph-review': KnowledgeGraphReviewPanel,
  'entity-impact-graph': EntityImpactGraphSettingsPanel,
  'news-events': NewsEventsSettingsPanel,
  'news-event-source-policy': NewsEventSourcePolicySettingsPanel,
  'news-indicator': NewsIndicatorSettingsPanel,
  'news-dedupe': NewsDedupeSettingsPanel,
  'news-classification': NewsClassificationSettingsPanel,
  'news-prompts': NewsPromptSettingsPanel,
  'newsnow-personalization': NewsnowPersonalizationSettingsPanel,
  'situation-monitor': SituationMonitorSettingsPanel,
  'realtime-signals': RealtimeSignalsSettingsPanel,
  'rss-translation-metrics': RssTranslationMetricsPanel,
  'rss-diagnostics': RssDiagnosticsPanel,
  'task-logs': TaskLogSettingsPanel,
  'geo-nominatim': GeoNominatimSettingsPanel,
  email: EmailSettingsPanel,
  akshare: AkshareGatewaySettingsPanel,
};

export function getAdminSettingsPanelComponent(
  panelId: AdminSettingsPanelId,
): ComponentType | null {
  if (panelId === 'roles' || panelId === 'permissions' || panelId === 'members') {
    return null;
  }

  return PANEL_COMPONENTS[panelId];
}
