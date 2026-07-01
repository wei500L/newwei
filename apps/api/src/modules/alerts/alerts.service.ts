import {
  createLogger,
  CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
  ensureTraceId,
  getCountryName,
  getCurrentTraceId,
  NotificationPresentationKind,
  normalizeCountryCode,
} from "@modular/utils";
import { HttpService } from "@nestjs/axios";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  AlertChannelType,
  AlertDeliveryStatus,
  AlertEventStatus,
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
  AlertStatus,
  NotificationType,
  Prisma,
} from "@prisma/client";
import { DelayedError, Job, Queue } from "bullmq";
import { PubSubEngine } from "graphql-subscriptions";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import type { LookupFunction } from "net";
import { firstValueFrom } from "rxjs";

import { hasMembershipPermission } from "../../common/authz/membership-permissions";
import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import {
  toPrismaJsonValue,
  toPrismaJsonValueOrUndefined,
} from "../../common/prisma-json";
import {
  resolveValidatedSsrfUrlAsync,
  type SsrfResolvedAddress,
  validateSsrfUrl,
  validateSsrfUrlAsync,
} from "../../common/validators/ssrf-url.validator";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  normalizeRealtimeSignalMetricSlug,
  REALTIME_SIGNAL_DEFAULT_RULES,
} from "../realtime-signals/realtime-signals.constants";

import { AlertsNotificationThrottleService } from "./alerts-notification-throttle.service";
import {
  AlertRuleTuningSuggestion,
  AlertTuningAction,
  quantile,
  safeMean,
} from "./alerts-tuning";
import { ALERTS_QUEUE, ALERT_METRIC_PROVIDERS } from "./alerts.constants";
import { ALERTS_PUBSUB, AlertEventPayload } from "./alerts.pubsub";
import { MetricProvider } from "./providers/metric-provider";

export interface AlertChannelInput {
  id?: string;
  type: AlertChannelType;
  name: string;
  target: string;
  config?: Record<string, unknown> | null;
  isActive?: boolean;
}

export interface UpdateAlertChannelInput {
  name?: string;
  target?: string;
  config?: Record<string, unknown> | null;
  isActive?: boolean;
}

export interface UpsertAlertRuleInput {
  id?: string;
  name: string;
  description?: string;
  severity?: AlertSeverity;
  status?: AlertStatus;
  metricProvider?: AlertMetricProvider;
  metricSlug: string;
  operator: AlertOperator;
  thresholdValue?: number;
  thresholdLower?: number;
  thresholdUpper?: number;
  changeWindowMin?: number;
  cooldownSeconds?: number;
  checkIntervalSec?: number;
  channelIds?: string[];
  metadata?: Record<string, unknown>;
}

export type AlertJobPayload =
  | { type: "scan"; traceId?: string }
  | {
      type: "evaluate";
      ruleId: string;
      orgId?: string;
      traceId?: string;
    }
  | {
      type: "deliver";
      deliveryId: string;
      orgId?: string;
      traceId?: string;
      scheduledAtMs?: number;
    };

const logger = createLogger({ name: "alerts" });
const NOTIFICATION_BACKOFF_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const FILTERED_RECIPIENT_SAMPLE_LIMIT = 20;
const ALERT_RULE_ORG_MAINTENANCE_CONCURRENCY = 8;
const ALERT_RULE_TASK_CONCURRENCY = 16;
const normalizeMetricSlug = (value: unknown): string =>
  normalizeRealtimeSignalMetricSlug(value);
const ALERTS_READ_PERMISSION = "alerts.read";

interface InAppRecipientResolution {
  candidateUserIds: string[];
  allowedUserIds: string[];
  missingPermissionUserIds: string[];
}

const DEFAULT_CRAWL_QUALITY_RULES: {
  key:
    | "preflight_failure_rate"
    | "http_304_hit_rate"
    | "org_hash_dedupe_hit_rate";
  name: string;
  description: string;
  metricSlug: string;
  operator: AlertOperator;
  thresholdValue: number;
  severity: AlertSeverity;
}[] = [
  {
    key: "preflight_failure_rate",
    name: "Crawl Quality: Preflight Failure Rate High",
    description: "Alert when preflight failure rate remains too high.",
    metricSlug: "crawl_quality.preflight_failure_rate",
    operator: AlertOperator.gte,
    thresholdValue: 0.15,
    severity: AlertSeverity.medium,
  },
  {
    key: "http_304_hit_rate",
    name: "Crawl Quality: HTTP 304 Hit Rate Low",
    description: "Alert when HTTP 304 hit rate drops below expected baseline.",
    metricSlug: "crawl_quality.http_304_hit_rate",
    operator: AlertOperator.lte,
    thresholdValue: 0.05,
    severity: AlertSeverity.medium,
  },
  {
    key: "org_hash_dedupe_hit_rate",
    name: "Crawl Quality: Org Hash Dedupe Hit Rate High",
    description: "Alert when org-level content hash dedupe hit rate spikes.",
    metricSlug: "crawl_quality.org_hash_dedupe_hit_rate",
    operator: AlertOperator.gte,
    thresholdValue: 0.3,
    severity: AlertSeverity.medium,
  },
];

const DEFAULT_REALTIME_SIGNAL_RULES = REALTIME_SIGNAL_DEFAULT_RULES;

const DEFAULT_PIPELINE_RULES: {
  key:
    | "success_rate"
    | "failure_rate"
    | "average_llm_latency_ms"
    | "ingestion_p90_ms"
    | "ingestion_p99_ms";
  name: string;
  description: string;
  metricSlug: string;
  operator: AlertOperator;
  thresholdValue: number;
  severity: AlertSeverity;
}[] = [
  {
    key: "success_rate",
    name: "Pipeline: Success Rate Low",
    description: "Alert when pipeline success rate drops below the expected baseline.",
    metricSlug: "pipeline.success_rate",
    operator: AlertOperator.lte,
    thresholdValue: 0.9,
    severity: AlertSeverity.high,
  },
  {
    key: "failure_rate",
    name: "Pipeline: Failure Rate High",
    description: "Alert when pipeline failure rate remains too high.",
    metricSlug: "pipeline.failure_rate",
    operator: AlertOperator.gte,
    thresholdValue: 0.1,
    severity: AlertSeverity.high,
  },
  {
    key: "average_llm_latency_ms",
    name: "Pipeline: Average LLM Latency High",
    description: "Alert when average LLM latency exceeds the operational threshold.",
    metricSlug: "pipeline.average_llm_latency_ms",
    operator: AlertOperator.gte,
    thresholdValue: 8000,
    severity: AlertSeverity.medium,
  },
  {
    key: "ingestion_p90_ms",
    name: "Pipeline: Ingestion P90 High",
    description: "Alert when p90 ingestion latency exceeds the operational threshold.",
    metricSlug: "pipeline.ingestion_p90_ms",
    operator: AlertOperator.gte,
    thresholdValue: 300000,
    severity: AlertSeverity.medium,
  },
  {
    key: "ingestion_p99_ms",
    name: "Pipeline: Ingestion P99 High",
    description: "Alert when p99 ingestion latency exceeds the operational threshold.",
    metricSlug: "pipeline.ingestion_p99_ms",
    operator: AlertOperator.gte,
    thresholdValue: 900000,
    severity: AlertSeverity.high,
  },
];

@Injectable()
export class AlertsService {
  private readonly prisma: PrismaService;
  private readonly email: EmailService;
  private readonly http: HttpService;
  private readonly metricProviders: MetricProvider[];
  private readonly notificationThrottle: AlertsNotificationThrottleService;
  private readonly notifications: NotificationsService;

  constructor(
    prisma: PrismaService,
    email: EmailService,
    http: HttpService,
    notificationThrottle: AlertsNotificationThrottleService,
    notifications: NotificationsService,
    private readonly env: EnvService,
    @Inject(ALERTS_QUEUE) private readonly queue: Queue<AlertJobPayload>,
    @Inject(ALERTS_PUBSUB) private readonly pubsub: PubSubEngine,
    @Inject(ALERT_METRIC_PROVIDERS) metricProviders: MetricProvider[],
  ) {
    this.prisma = prisma;
    this.email = email;
    this.http = http;
    this.metricProviders = metricProviders;
    this.notificationThrottle = notificationThrottle;
    this.notifications = notifications;
  }

  async listChannels(orgId: string) {
    return this.prisma.alertNotificationChannel.findMany({
      where: { orgId },
      orderBy: { createdAt: "asc" },
    });
  }

  async createChannel(
    orgId: string,
    input: AlertChannelInput,
    createdById?: string,
  ) {
    const target = await this.normalizeChannelTarget(input.type, input.target);
    return this.prisma.alertNotificationChannel.create({
      data: {
        orgId,
        name: input.name,
        type: input.type,
        target,
        config: toPrismaJsonValue(input.config ?? {}),
        isActive: input.isActive ?? true,
        createdById,
      },
    });
  }

  async updateChannel(
    orgId: string,
    channelId: string,
    input: UpdateAlertChannelInput,
  ) {
    const existing = await this.prisma.alertNotificationChannel.findUnique({
      where: { id: channelId },
    });
    if (!existing || existing.orgId !== orgId) {
      throw new Error("Alert channel not found for this org");
    }

    const data: Prisma.AlertNotificationChannelUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.target !== undefined) {
      data.target = await this.normalizeChannelTarget(
        existing.type,
        input.target,
      );
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.config !== undefined) {
      data.config = toPrismaJsonValue(input.config ?? {});
    }

    return this.prisma.alertNotificationChannel.update({
      where: { id: channelId },
      data,
    });
  }

  async deleteChannel(orgId: string, channelId: string) {
    const existing = await this.prisma.alertNotificationChannel.findUnique({
      where: { id: channelId },
    });
    if (!existing || existing.orgId !== orgId) {
      return false;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.alertDelivery.updateMany({
        where: { channelId, status: AlertDeliveryStatus.pending },
        data: {
          status: AlertDeliveryStatus.failed,
          error: "channel deleted",
        },
      });
      await tx.alertDelivery.updateMany({
        where: { channelId },
        data: { channelId: null },
      });
      await tx.alertNotificationChannel.delete({ where: { id: channelId } });
    });

    return true;
  }

  async listChannelMap(orgId: string) {
    const channels = await this.listChannels(orgId);
    return new Map(channels.map((c) => [c.id, c]));
  }

  async listRules(orgId: string) {
    await this.ensureDefaultRules(orgId);
    const rules = await this.prisma.alertRule.findMany({
      where: { orgId },
      include: {
        channels: { include: { channel: true } },
        dataItem: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return rules.map((rule) => ({
      ...rule,
      metricSlug: normalizeMetricSlug(rule.metricSlug),
    }));
  }

  private async ensureDefaultRules(orgId: string) {
    await Promise.all([
      this.ensureDefaultCrawlQualityRules(orgId),
      this.ensureDefaultRealtimeSignalRules(orgId),
      this.ensureDefaultPipelineRules(orgId),
    ]);
  }

  private async ensureDefaultRulesForAllOrgs() {
    const orgs = await this.prisma.org.findMany({
      select: { id: true },
    });
    await this.executeWithConcurrencyLimit(
      orgs,
      async (org) => {
        await this.ensureDefaultRules(org.id);
      },
      ALERT_RULE_ORG_MAINTENANCE_CONCURRENCY,
    );
  }

  private async ensureDefaultCrawlQualityRules(orgId: string) {
    await this.ensureMetricProviderDefaultRules({
      orgId,
      metricProvider: AlertMetricProvider.crawl_task,
      definitions: DEFAULT_CRAWL_QUALITY_RULES,
      buildRuleId: (definition) =>
        this.buildDefaultCrawlQualityRuleId(orgId, definition.key),
      cooldownSeconds: 3600,
      duplicateLogMessage: "Default crawl quality alert rule already exists",
      buildMetadata: (definition) => ({
        systemDefault: true,
        defaultRuleKey: definition.key,
        version: 1,
      }),
    });
  }

  private async ensureDefaultRealtimeSignalRules(orgId: string) {
    await this.ensureMetricProviderDefaultRules({
      orgId,
      metricProvider: AlertMetricProvider.realtime_signal,
      definitions: DEFAULT_REALTIME_SIGNAL_RULES,
      buildRuleId: (definition) =>
        this.buildDefaultRealtimeSignalRuleId(orgId, definition.key),
      cooldownSeconds: 1800,
      duplicateLogMessage:
        "Default realtime signal alert rule already exists",
      buildMetadata: (definition) => ({
        systemDefault: true,
        defaultRuleKey: definition.key,
        version: 1,
      }),
    });
  }

  private async ensureDefaultPipelineRules(orgId: string) {
    await this.ensureMetricProviderDefaultRules({
      orgId,
      metricProvider: AlertMetricProvider.pipeline_job,
      definitions: DEFAULT_PIPELINE_RULES,
      buildRuleId: (definition) =>
        this.buildDefaultPipelineRuleId(orgId, definition.key),
      cooldownSeconds: 1800,
      duplicateLogMessage: "Default pipeline alert rule already exists",
      buildMetadata: (definition) => ({
        systemDefault: true,
        defaultRuleKey: definition.key,
        version: 1,
      }),
    });
  }

  private async ensureMetricProviderDefaultRules<
    TDefinition extends {
      key: string;
      name: string;
      description: string;
      metricSlug: string;
      operator: AlertOperator;
      thresholdValue: number;
      severity: AlertSeverity;
    },
  >(input: {
    orgId: string;
    metricProvider: AlertMetricProvider;
    definitions: TDefinition[];
    buildRuleId: (definition: TDefinition) => string;
    cooldownSeconds: number;
    duplicateLogMessage: string;
    buildMetadata: (definition: TDefinition) => Record<string, unknown>;
  }) {
    const existing = await this.prisma.alertRule.findMany({
      where: {
        orgId: input.orgId,
        metricProvider: input.metricProvider,
      },
      select: {
        metricSlug: true,
      },
    });
    const existingSlugSet = new Set(
      existing
        .map((entry) => normalizeMetricSlug(entry.metricSlug))
        .filter((slug) => slug.length > 0),
    );
    const missingDefinitions = input.definitions.filter(
      (definition) =>
        !existingSlugSet.has(normalizeMetricSlug(definition.metricSlug)),
    );

    await this.executeWithConcurrencyLimit(
      missingDefinitions,
      async (definition) => {
        const metricSlug = normalizeMetricSlug(definition.metricSlug);

        try {
          const created = await this.prisma.alertRule.create({
            data: {
              id: input.buildRuleId(definition),
              orgId: input.orgId,
              name: definition.name,
              description: definition.description,
              severity: definition.severity,
              status: AlertStatus.active,
              metricProvider: input.metricProvider,
              metricSlug,
              operator: definition.operator,
              thresholdValue: new Prisma.Decimal(definition.thresholdValue),
              thresholdLower: null,
              thresholdUpper: null,
              changeWindowMin: 60,
              cooldownSeconds: input.cooldownSeconds,
              checkIntervalSec: 300,
              metadata: toPrismaJsonValue(input.buildMetadata(definition)),
              dataItemId: null,
            },
          });
          await Promise.all([
            this.ensureRuleSchedule(created),
            this.enqueueRuleCheck(created.id, created.orgId),
          ]);
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            logger.debug(
              { orgId: input.orgId, metricSlug },
              input.duplicateLogMessage,
            );
            return;
          }
          throw error;
        }
      },
      ALERT_RULE_TASK_CONCURRENCY,
    );
  }

  private buildDefaultCrawlQualityRuleId(
    orgId: string,
    key:
      | "preflight_failure_rate"
      | "http_304_hit_rate"
      | "org_hash_dedupe_hit_rate",
  ) {
    const normalizedOrgId = orgId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `default-crawl-quality-${key}-${normalizedOrgId}`.slice(0, 191);
  }

  private buildDefaultRealtimeSignalRuleId(
    orgId: string,
    key:
      | "opensky"
      | "opensky_snapshot_health"
      | "ais"
      | "unrest"
      | "outages"
      | "keyword_spike"
      | "pizzint"
      | "gdelt_tension"
      | "polymarket_leads",
  ) {
    const normalizedOrgId = orgId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `default-realtime-signal-${key}-${normalizedOrgId}`.slice(0, 191);
  }

  private buildDefaultPipelineRuleId(
    orgId: string,
    key:
      | "success_rate"
      | "failure_rate"
      | "average_llm_latency_ms"
      | "ingestion_p90_ms"
      | "ingestion_p99_ms",
  ) {
    const normalizedOrgId = orgId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `default-pipeline-${key}-${normalizedOrgId}`.slice(0, 191);
  }

  async listEvents(orgId: string, limit = 50, metricSlug?: string) {
    const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
    const boundedLimit = Math.min(Math.max(normalizedLimit, 1), 500);
    const normalizedMetricSlug = normalizeMetricSlug(metricSlug);
    const include = {
      rule: true,
      deliveries: { include: { channel: true } },
    } as const;
    const orderBy = { triggeredAt: "desc" } as const;
    const toNormalizedEvents = <
      T extends { rule?: { metricSlug: string } | null },
    >(
      events: T[],
    ) =>
      events.map((event) => ({
        ...event,
        rule: event.rule
          ? {
              ...event.rule,
              metricSlug: normalizeMetricSlug(event.rule.metricSlug),
            }
          : event.rule,
      }));

    if (!normalizedMetricSlug) {
      const events = await this.prisma.alertEvent.findMany({
        where: { rule: { orgId } },
        include,
        orderBy,
        take: boundedLimit,
      });
      return toNormalizedEvents(events);
    }

    const exactEvents = await this.prisma.alertEvent.findMany({
      where: { rule: { orgId, metricSlug: normalizedMetricSlug } },
      include,
      orderBy,
      take: boundedLimit,
    });
    if (exactEvents.length >= boundedLimit) {
      return toNormalizedEvents(exactEvents);
    }

    // Backward compatibility: legacy rows may contain leading/trailing spaces in metricSlug.
    const fallbackTake = Math.max(boundedLimit * 10, 200);
    const fallbackEvents = await this.prisma.alertEvent.findMany({
      where: { rule: { orgId } },
      include,
      orderBy,
      take: fallbackTake,
    });
    const mergedById = new Map<string, (typeof exactEvents)[number]>();
    for (const event of exactEvents) {
      mergedById.set(event.id, event);
    }
    for (const event of fallbackEvents) {
      if (
        normalizeMetricSlug(event.rule?.metricSlug) !== normalizedMetricSlug
      ) {
        continue;
      }
      if (!mergedById.has(event.id)) {
        mergedById.set(event.id, event);
      }
    }
    const toEpochMs = (value: unknown): number => {
      if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : 0;
      }
      if (typeof value === "string" || typeof value === "number") {
        const ms = new Date(value).getTime();
        return Number.isFinite(ms) ? ms : 0;
      }
      return 0;
    };
    const mergedEvents = Array.from(mergedById.values())
      .sort((a, b) => toEpochMs(b.triggeredAt) - toEpochMs(a.triggeredAt))
      .slice(0, boundedLimit);
    return toNormalizedEvents(mergedEvents);
  }

  async getEventReplay(orgId: string, eventId: string, windowDays = 30) {
    const normalizedDays = Math.min(Math.max(Math.trunc(windowDays), 1), 365);
    const event = await this.prisma.alertEvent.findUnique({
      where: { id: eventId },
      include: { rule: true },
    });
    if (!event || !event.rule || event.rule.orgId !== orgId) {
      return null;
    }
    if (
      event.rule.metricProvider !== AlertMetricProvider.economic_data &&
      event.rule.metricProvider !== AlertMetricProvider.economic_anomaly
    ) {
      return null;
    }
    const metricSlug = normalizeMetricSlug(event.rule.metricSlug);
    if (!metricSlug) {
      return null;
    }
    const context =
      event.context &&
      typeof event.context === "object" &&
      !Array.isArray(event.context)
        ? (event.context as Record<string, unknown>)
        : null;
    const recordedAtRaw =
      typeof context?.recordedAt === "string" ? context.recordedAt : null;
    const center = recordedAtRaw ? new Date(recordedAtRaw) : event.triggeredAt;
    const windowMs = normalizedDays * 24 * 60 * 60 * 1000;
    const start = new Date(center.getTime() - windowMs);
    const end = new Date(center.getTime() + windowMs);

    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        item: { slug: metricSlug },
        recordedAt: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { recordedAt: "asc" },
      select: {
        recordedAt: true,
        value: true,
        unit: true,
      },
    });

    const unit = points.find((point) => point.unit)?.unit ?? null;
    return {
      eventId: event.id,
      metricProvider: event.rule.metricProvider,
      metricSlug,
      unit,
      points: points.map((point) => ({
        timestamp: point.recordedAt,
        value: Number(point.value),
      })),
    };
  }

  async getRuleTuningSuggestion(
    orgId: string,
    ruleId: string,
    windowDays = 30,
  ): Promise<AlertRuleTuningSuggestion | null> {
    const normalizedDays = Math.min(Math.max(Math.trunc(windowDays), 1), 365);
    const rule = await this.prisma.alertRule.findUnique({
      where: { id: ruleId },
    });
    if (!rule || rule.orgId !== orgId) {
      return null;
    }

    const since = new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000);
    const events = await this.prisma.alertEvent.findMany({
      where: {
        ruleId: rule.id,
        triggeredAt: { gte: since },
      },
      orderBy: { triggeredAt: "desc" },
      take: 500,
      select: {
        status: true,
        metricValue: true,
        changePercent: true,
      },
    });

    const totalEvents = events.length;
    const confirmed: number[] = [];
    const ignored: number[] = [];

    for (const event of events) {
      if (
        !(
          [
            AlertEventStatus.confirmed,
            AlertEventStatus.ignored,
          ] as AlertEventStatus[]
        ).includes(event.status)
      ) {
        continue;
      }
      let value: number | null = null;
      if (
        rule.operator === AlertOperator.change_up_pct ||
        rule.operator === AlertOperator.change_down_pct
      ) {
        if (
          typeof event.changePercent !== "number" ||
          !Number.isFinite(event.changePercent)
        ) {
          continue;
        }
        value =
          rule.operator === AlertOperator.change_down_pct
            ? -event.changePercent
            : event.changePercent;
      } else {
        value = Number(event.metricValue);
      }
      if (value === null || !Number.isFinite(value)) {
        continue;
      }
      if (event.status === AlertEventStatus.confirmed) {
        confirmed.push(value);
      } else {
        ignored.push(value);
      }
    }

    const confirmedEvents = confirmed.length;
    const ignoredEvents = ignored.length;
    const reviewedEvents = confirmedEvents + ignoredEvents;
    const falsePositiveRate = reviewedEvents
      ? ignoredEvents / reviewedEvents
      : null;

    const base: AlertRuleTuningSuggestion = {
      ruleId: rule.id,
      windowDays: normalizedDays,
      totalEvents,
      reviewedEvents,
      confirmedEvents,
      ignoredEvents,
      falsePositiveRate,
      action: AlertTuningAction.none,
      message: null,
      suggestedThresholdValue: null,
      suggestedThresholdLower: null,
      suggestedThresholdUpper: null,
    };

    if (reviewedEvents < 5) {
      return {
        ...base,
        message:
          "Not enough reviewed alerts yet. Confirm/Ignore a few events to generate tuning suggestions.",
      };
    }

    const currentThresholdValue =
      rule.thresholdValue !== null && rule.thresholdValue !== undefined
        ? Number(rule.thresholdValue)
        : null;
    const currentLower =
      rule.thresholdLower !== null && rule.thresholdLower !== undefined
        ? Number(rule.thresholdLower)
        : null;
    const currentUpper =
      rule.thresholdUpper !== null && rule.thresholdUpper !== undefined
        ? Number(rule.thresholdUpper)
        : null;

    const suggestHighThreshold = (current: number | null) => {
      if (!ignored.length) {
        return null;
      }
      const maxIgnored = Math.max(...ignored);
      const minConfirmed = confirmed.length ? Math.min(...confirmed) : null;
      if (minConfirmed !== null && minConfirmed > maxIgnored) {
        return (minConfirmed + maxIgnored) / 2;
      }
      const p90 = quantile(ignored, 0.9);
      if (typeof p90 === "number" && Number.isFinite(p90)) {
        return current !== null ? Math.max(current, p90) : p90;
      }
      return current;
    };

    const suggestLowThreshold = (current: number | null) => {
      if (!ignored.length) {
        return null;
      }
      const minIgnored = Math.min(...ignored);
      const maxConfirmed = confirmed.length ? Math.max(...confirmed) : null;
      if (maxConfirmed !== null && maxConfirmed < minIgnored) {
        return (maxConfirmed + minIgnored) / 2;
      }
      const p10 = quantile(ignored, 0.1);
      if (typeof p10 === "number" && Number.isFinite(p10)) {
        return current !== null ? Math.min(current, p10) : p10;
      }
      return current;
    };

    if (
      (
        [
          AlertOperator.gt,
          AlertOperator.gte,
          AlertOperator.change_up_pct,
          AlertOperator.change_down_pct,
        ] as AlertOperator[]
      ).includes(rule.operator)
    ) {
      const suggested = suggestHighThreshold(currentThresholdValue);
      if (
        suggested !== null &&
        currentThresholdValue !== null &&
        suggested > currentThresholdValue
      ) {
        const ignoredAvg = safeMean(ignored);
        const confirmedAvg = safeMean(confirmed);
        return {
          ...base,
          action: AlertTuningAction.increase_threshold,
          suggestedThresholdValue: suggested,
          message: `High false-positive rate: consider raising threshold from ${currentThresholdValue} to ~${suggested.toFixed(4)} (ignored avg ${ignoredAvg?.toFixed(4) ?? "n/a"}, confirmed avg ${confirmedAvg?.toFixed(4) ?? "n/a"}).`,
        };
      }
      return base;
    }

    if (
      ([AlertOperator.lt, AlertOperator.lte] as AlertOperator[]).includes(
        rule.operator,
      )
    ) {
      const suggested = suggestLowThreshold(currentThresholdValue);
      if (
        suggested !== null &&
        currentThresholdValue !== null &&
        suggested < currentThresholdValue
      ) {
        const ignoredAvg = safeMean(ignored);
        const confirmedAvg = safeMean(confirmed);
        return {
          ...base,
          action: AlertTuningAction.decrease_threshold,
          suggestedThresholdValue: suggested,
          message: `High false-positive rate: consider lowering threshold from ${currentThresholdValue} to ~${suggested.toFixed(4)} (ignored avg ${ignoredAvg?.toFixed(4) ?? "n/a"}, confirmed avg ${confirmedAvg?.toFixed(4) ?? "n/a"}).`,
        };
      }
      return base;
    }

    if (
      rule.operator === AlertOperator.outside_range &&
      currentLower !== null &&
      currentUpper !== null
    ) {
      const lowerIgnored: number[] = [];
      const lowerConfirmed: number[] = [];
      const upperIgnored: number[] = [];
      const upperConfirmed: number[] = [];

      for (const event of events) {
        if (
          !(
            [
              AlertEventStatus.confirmed,
              AlertEventStatus.ignored,
            ] as AlertEventStatus[]
          ).includes(event.status)
        ) {
          continue;
        }
        const value = Number(event.metricValue);
        if (!Number.isFinite(value)) {
          continue;
        }
        const target =
          value < currentLower
            ? "lower"
            : value > currentUpper
              ? "upper"
              : null;
        if (!target) {
          continue;
        }
        if (target === "lower") {
          (event.status === AlertEventStatus.confirmed
            ? lowerConfirmed
            : lowerIgnored
          ).push(value);
        } else {
          (event.status === AlertEventStatus.confirmed
            ? upperConfirmed
            : upperIgnored
          ).push(value);
        }
      }

      const suggestLower = () => {
        if (!lowerIgnored.length) {
          return null;
        }
        const minIgnored = Math.min(...lowerIgnored);
        const maxConfirmed = lowerConfirmed.length
          ? Math.max(...lowerConfirmed)
          : null;
        if (maxConfirmed !== null && maxConfirmed < minIgnored) {
          return (maxConfirmed + minIgnored) / 2;
        }
        const p10 = quantile(lowerIgnored, 0.1);
        return typeof p10 === "number" && Number.isFinite(p10)
          ? Math.min(currentLower, p10)
          : null;
      };

      const suggestUpper = () => {
        if (!upperIgnored.length) {
          return null;
        }
        const maxIgnored = Math.max(...upperIgnored);
        const minConfirmed = upperConfirmed.length
          ? Math.min(...upperConfirmed)
          : null;
        if (minConfirmed !== null && minConfirmed > maxIgnored) {
          return (minConfirmed + maxIgnored) / 2;
        }
        const p90 = quantile(upperIgnored, 0.9);
        return typeof p90 === "number" && Number.isFinite(p90)
          ? Math.max(currentUpper, p90)
          : null;
      };

      const suggestedLower = suggestLower();
      const suggestedUpper = suggestUpper();
      if (suggestedLower === null && suggestedUpper === null) {
        return base;
      }
      return {
        ...base,
        action: AlertTuningAction.adjust_range,
        suggestedThresholdLower: suggestedLower ?? null,
        suggestedThresholdUpper: suggestedUpper ?? null,
        message: `Consider adjusting range from [${currentLower}, ${currentUpper}] to [${suggestedLower?.toFixed(4) ?? currentLower}, ${suggestedUpper?.toFixed(4) ?? currentUpper}] based on ignored/confirmed splits.`,
      };
    }

    return base;
  }

  async updateEventStatus(
    orgId: string,
    eventId: string,
    status: AlertEventStatus,
    note?: string,
    updatedById?: string,
  ) {
    if (
      !(
        [
          AlertEventStatus.confirmed,
          AlertEventStatus.ignored,
        ] as AlertEventStatus[]
      ).includes(status)
    ) {
      throw new Error("Unsupported alert event status update");
    }
    const existing = await this.prisma.alertEvent.findUnique({
      where: { id: eventId },
      include: { rule: true },
    });
    if (!existing || existing.rule?.orgId !== orgId) {
      throw new Error("Alert event not found for this org");
    }
    const trimmedNote = typeof note === "string" ? note.trim() : undefined;
    const existingContext =
      existing.context &&
      typeof existing.context === "object" &&
      !Array.isArray(existing.context)
        ? (existing.context as Record<string, unknown>)
        : null;
    const existingFeedback =
      existingContext?.feedback &&
      typeof existingContext.feedback === "object" &&
      !Array.isArray(existingContext.feedback)
        ? (existingContext.feedback as Record<string, unknown>)
        : null;
    const nextContext =
      trimmedNote !== undefined || note !== undefined || updatedById
        ? {
            ...(existingContext ?? {}),
            feedback: {
              ...(existingFeedback ?? {}),
              ...(note !== undefined
                ? trimmedNote
                  ? { note: trimmedNote }
                  : { note: null }
                : {}),
              ...(updatedById ? { updatedById } : {}),
              status,
              updatedAt: new Date().toISOString(),
            },
          }
        : undefined;

    const updated = await this.prisma.alertEvent.update({
      where: { id: eventId },
      data: { status, ...(nextContext ? { context: nextContext } : {}) },
      include: { rule: true, deliveries: { include: { channel: true } } },
    });
    return {
      ...updated,
      rule: updated.rule
        ? {
            ...updated.rule,
            metricSlug: normalizeMetricSlug(updated.rule.metricSlug),
          }
        : updated.rule,
    };
  }

  async upsertRule(
    orgId: string,
    input: UpsertAlertRuleInput,
    createdById?: string,
  ) {
    const existingRule = input.id
      ? await this.prisma.alertRule.findUnique({ where: { id: input.id } })
      : null;
    if (input.id && (!existingRule || existingRule.orgId !== orgId)) {
      throw new Error("Alert rule not found for this org");
    }

    const metricSlug = normalizeMetricSlug(input.metricSlug);
    if (!metricSlug) {
      throw new Error("metricSlug is required");
    }

    const metricProvider =
      input.metricProvider ??
      existingRule?.metricProvider ??
      AlertMetricProvider.economic_data;
    if (!this.resolveMetricProvider({ metricProvider })) {
      throw new Error(
        `No metric provider registered for type ${metricProvider}`,
      );
    }
    if (
      metricProvider === AlertMetricProvider.system_metric &&
      metricSlug === CUSTOM_MANUAL_SYSTEM_METRIC_SLUG
    ) {
      const currentValue =
        input.metadata && typeof input.metadata.currentValue === "number"
          ? input.metadata.currentValue
          : undefined;
      if (!Number.isFinite(currentValue)) {
        throw new Error("custom.manual metric requires metadata.currentValue");
      }
    }
    const dataItem =
      metricProvider === AlertMetricProvider.economic_data
        ? await this.prisma.economicDataItem.findUnique({
            where: { slug: metricSlug },
          })
        : null;
    const baseData: Prisma.AlertRuleUncheckedCreateInput = {
      orgId,
      name: input.name,
      description: input.description,
      severity: input.severity ?? AlertSeverity.medium,
      status: input.status ?? AlertStatus.active,
      metricProvider,
      metricSlug,
      operator: input.operator,
      thresholdValue:
        input.thresholdValue !== undefined
          ? new Prisma.Decimal(input.thresholdValue)
          : null,
      thresholdLower:
        input.thresholdLower !== undefined
          ? new Prisma.Decimal(input.thresholdLower)
          : null,
      thresholdUpper:
        input.thresholdUpper !== undefined
          ? new Prisma.Decimal(input.thresholdUpper)
          : null,
      changeWindowMin: input.changeWindowMin ?? null,
      cooldownSeconds: input.cooldownSeconds ?? 3600,
      checkIntervalSec: input.checkIntervalSec ?? 300,
      metadata: toPrismaJsonValue(input.metadata ?? {}),
      createdById,
      dataItemId:
        metricProvider === AlertMetricProvider.economic_data
          ? (dataItem?.id ?? null)
          : null,
    };

    const rule = await this.prisma.$transaction(async (tx) => {
      let currentRule = existingRule;
      if (currentRule) {
        currentRule = await tx.alertRule.update({
          where: { id: currentRule.id },
          data: {
            name: baseData.name,
            description: baseData.description,
            severity: baseData.severity,
            status: baseData.status,
            metricProvider: baseData.metricProvider,
            metricSlug: baseData.metricSlug,
            operator: baseData.operator,
            thresholdValue: baseData.thresholdValue,
            thresholdLower: baseData.thresholdLower,
            thresholdUpper: baseData.thresholdUpper,
            changeWindowMin: baseData.changeWindowMin,
            cooldownSeconds: baseData.cooldownSeconds,
            checkIntervalSec: baseData.checkIntervalSec,
            metadata: baseData.metadata,
            dataItemId: baseData.dataItemId,
          },
        });
      } else {
        currentRule = await tx.alertRule.create({ data: baseData });
      }

      if (input.channelIds) {
        await tx.alertRuleChannel.deleteMany({
          where: { ruleId: currentRule.id },
        });
        for (const channelId of input.channelIds) {
          await tx.alertRuleChannel.create({
            data: {
              ruleId: currentRule.id,
              channelId,
            },
          });
        }
      }

      return currentRule;
    });

    await this.ensureRuleSchedule(rule);
    await this.enqueueRuleCheck(rule.id, rule.orgId);
    return rule;
  }

  async deleteRule(orgId: string, ruleId: string) {
    const existing = await this.prisma.alertRule.findUnique({
      where: { id: ruleId },
    });
    if (!existing || existing.orgId !== orgId) {
      return false;
    }
    await this.prisma.alertRule.delete({ where: { id: ruleId } });
    await this.removeJob(ruleId, true);
    return true;
  }

  async enqueueRuleCheck(ruleId: string, orgId?: string) {
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      this.buildRuleJobName(ruleId),
      { type: "evaluate", ruleId, orgId, traceId },
      {
        jobId: `evaluate:${ruleId}:${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
      },
    );
  }

  /**
   * Manual (user-triggered) rule evaluation. Verifies the rule belongs to the
   * caller's org before enqueuing, preventing cross-tenant forced evaluation (IDOR).
   * The enqueued job carries orgId so evaluateRule can re-check ownership.
   */
  async triggerRuleCheck(orgId: string, ruleId: string): Promise<boolean> {
    const existing = await this.prisma.alertRule.findFirst({
      where: { id: ruleId, orgId },
      select: { id: true },
    });
    if (!existing) {
      return false;
    }
    await this.enqueueRuleCheck(ruleId, orgId);
    return true;
  }

  async enqueueActiveRuleChecks() {
    await this.ensureDefaultRulesForAllOrgs();
    const activeRules = await this.prisma.alertRule.findMany({
      where: { status: AlertStatus.active },
      select: { id: true, orgId: true },
    });
    await this.executeWithConcurrencyLimit(
      activeRules,
      async (rule) => {
        await this.enqueueRuleCheck(rule.id, rule.orgId);
      },
      ALERT_RULE_TASK_CONCURRENCY,
    );
  }

  async ensureAllSchedules() {
    await this.ensureDefaultRulesForAllOrgs();
    const activeRules = await this.prisma.alertRule.findMany({
      where: { status: AlertStatus.active },
      select: { id: true, orgId: true, checkIntervalSec: true },
    });
    await this.executeWithConcurrencyLimit(
      activeRules,
      async (rule) => {
        await this.ensureRuleSchedule({
          ...rule,
          status: AlertStatus.active,
        });
      },
      ALERT_RULE_TASK_CONCURRENCY,
    );
  }

  async evaluateRule(ruleId: string, expectedOrgId?: string) {
    const rule = await this.prisma.alertRule.findUnique({
      where: { id: ruleId },
      include: { channels: { include: { channel: true } } },
    });
    if (!rule || rule.status !== AlertStatus.active) {
      return null;
    }

    // Defense in depth: when the job declares a target org, never evaluate a rule
    // that belongs to a different tenant (guards against mismatched/forged job data).
    if (expectedOrgId && rule.orgId !== expectedOrgId) {
      logger.warn(
        { ruleId, expectedOrgId, actualOrgId: rule.orgId },
        "Refusing to evaluate alert rule for mismatched org",
      );
      return null;
    }

    if (rule.lastTriggeredAt) {
      const nextAllowed =
        rule.lastTriggeredAt.getTime() + rule.cooldownSeconds * 1000;
      if (Date.now() < nextAllowed) {
        return null;
      }
    }

    const provider = this.resolveMetricProvider(rule);
    if (!provider) {
      logger.warn(
        { ruleId: rule.id, metricProvider: rule.metricProvider },
        "Alert rule has no metric provider registered",
      );
      return null;
    }

    const {
      latest,
      previous,
      changePercent,
      context: providerContext,
    } = await provider.fetch(rule);
    if (latest === null || latest === undefined) {
      return null;
    }

    const triggered = this.shouldTrigger(rule, latest, previous, changePercent);
    if (!triggered) {
      return null;
    }

    const context = this.normalizeAlertContext({
      latest,
      previous,
      changePercent,
      ...(providerContext ?? {}),
      ...(triggered.context ?? {}),
    });
    const event = await this.prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        triggeredAt: new Date(),
        metricValue: new Prisma.Decimal(latest),
        changePercent: changePercent ?? null,
        severity: rule.severity,
        status: AlertEventStatus.pending,
        message: triggered.message,
        context: toPrismaJsonValueOrUndefined(context),
      },
    });

    await this.prisma.alertRule.update({
      where: { id: rule.id },
      data: { lastTriggeredAt: new Date() },
    });

    const activeChannels = rule.channels
      .map((link) => link.channel)
      .filter(
        (channel): channel is NonNullable<typeof channel> =>
          !!channel && channel.isActive,
      );

    const externalDeliveries = await Promise.all(
      activeChannels.map((channel) =>
        this.prisma.alertDelivery.create({
          data: {
            eventId: event.id,
            channelId: channel.id,
            channelType: channel.type,
            targetSnapshot: channel,
          },
        }),
      ),
    );

    const inAppDeliveries = await this.createInAppDeliveries(rule, event.id);

    if (externalDeliveries.length > 0) {
      await this.enqueueNotificationJobs(externalDeliveries, rule.orgId);
    }

    const hasAnyDeliveries =
      externalDeliveries.length > 0 || inAppDeliveries.length > 0;
    if (!hasAnyDeliveries) {
      await this.prisma.alertEvent.update({
        where: { id: event.id },
        data: { status: AlertEventStatus.delivered },
      });
    }

    if (inAppDeliveries.length > 0) {
      void this.deliverInAppNotifications(
        rule,
        {
          id: event.id,
          metricValue: event.metricValue,
          severity: event.severity,
          changePercent: event.changePercent ?? null,
          message: event.message,
          context: context ?? null,
        },
        inAppDeliveries,
      );
    }

    const streamStatus = hasAnyDeliveries
      ? event.status
      : AlertEventStatus.delivered;
    const normalizedRuleMetricSlug = normalizeMetricSlug(rule.metricSlug);
    await this.pubsub.publish("alertEvents", {
      orgId: rule.orgId,
      event: {
        id: event.id,
        ruleId: rule.id,
        ruleName: rule.name,
        metricProvider: rule.metricProvider,
        metricSlug: normalizedRuleMetricSlug,
        triggeredAt: event.triggeredAt,
        message: triggered.message,
        severity: rule.severity,
        metricValue: Number(event.metricValue),
        changePercent: event.changePercent ?? null,
        status: streamStatus,
        context: (context as Record<string, unknown> | undefined) ?? null,
      },
    } satisfies AlertEventPayload);

    return { event, deliveries: externalDeliveries };
  }

  private async createInAppDeliveries(
    rule: {
      id?: string;
      orgId: string;
      createdById?: string | null;
      metadata?: Prisma.JsonValue | null;
    },
    eventId: string,
  ) {
    const muteUntilMs = this.extractMuteUntilMs(rule.metadata);
    if (this.notificationThrottle.isMutedNow(muteUntilMs)) {
      return [] as { id: string; userId: string }[];
    }
    const recipientResolution = await this.resolveInAppRecipients(rule);
    this.logFilteredInAppRecipients({
      orgId: rule.orgId,
      ruleId: rule.id,
      eventId,
      candidateUserIds: recipientResolution.candidateUserIds,
      allowedUserIds: recipientResolution.allowedUserIds,
      missingPermissionUserIds: recipientResolution.missingPermissionUserIds,
    });
    if (!recipientResolution.allowedUserIds.length) {
      return [] as { id: string; userId: string }[];
    }
    const created = await Promise.all(
      recipientResolution.allowedUserIds.map(async (userId) => {
        const delivery = await this.prisma.alertDelivery.create({
          data: {
            eventId,
            channelType: AlertChannelType.in_app,
            targetSnapshot: { userId },
          },
        });
        return { id: delivery.id, userId };
      }),
    );
    return created;
  }

  private async deliverInAppNotifications(
    rule: {
      id: string;
      orgId: string;
      name: string;
      metricSlug: string;
      severity: AlertSeverity;
      createdById?: string | null;
      metadata?: Prisma.JsonValue | null;
    },
    event: {
      id: string;
      metricValue: Prisma.Decimal;
      severity: AlertSeverity;
      changePercent?: number | null;
      message?: string | null;
      context?: Record<string, unknown> | null;
    },
    deliveries: { id: string; userId: string }[],
  ) {
    const metricValue = Number(event.metricValue);
    const metricSlug = normalizeMetricSlug(rule.metricSlug);
    const title = `Alert triggered: ${rule.name}`;
    const changeText =
      typeof event.changePercent === "number" &&
      Number.isFinite(event.changePercent)
        ? ` (${event.changePercent.toFixed(2)}%)`
        : "";
    const body =
      event.message ??
      `Metric ${metricSlug} triggered at ${Number.isFinite(metricValue) ? metricValue : "N/A"}${changeText}`;
    const context =
      event.context &&
      typeof event.context === "object" &&
      !Array.isArray(event.context)
        ? (event.context as Record<string, unknown>)
        : null;
    const contextSummary = context
      ? {
          countryCode:
            typeof context.countryCode === "string"
              ? context.countryCode
              : undefined,
          countryName:
            typeof context.countryName === "string"
              ? context.countryName
              : undefined,
          itemName:
            typeof context.itemName === "string" ? context.itemName : undefined,
          sourceName:
            typeof context.sourceName === "string"
              ? context.sourceName
              : undefined,
          recordedAt:
            typeof context.recordedAt === "string"
              ? context.recordedAt
              : undefined,
          unit: typeof context.unit === "string" ? context.unit : undefined,
        }
      : null;

    try {
      await Promise.all(
        deliveries.map(async (delivery) => {
          const userId = delivery.userId;
          try {
            const record = await this.notifications.notify({
              orgId: rule.orgId,
              userId,
              type: NotificationType.alert_triggered,
              title,
              body,
              data: {
                alertEventId: event.id,
                ruleId: rule.id,
                ruleName: rule.name,
                severity: event.severity,
                metricSlug,
                metricValue,
                ...(typeof event.changePercent === "number" &&
                Number.isFinite(event.changePercent)
                  ? { changePercent: event.changePercent }
                  : {}),
                ...(contextSummary ? { context: contextSummary } : {}),
                presentation: {
                  kind: NotificationPresentationKind.AlertTriggered,
                  params: {
                    alertEventId: event.id,
                    ruleId: rule.id,
                    ruleName: rule.name,
                    severity: event.severity,
                    metricSlug,
                    metricValue,
                    ...(typeof event.changePercent === "number" &&
                    Number.isFinite(event.changePercent)
                      ? { changePercent: event.changePercent }
                      : {}),
                    ...(contextSummary ? { context: contextSummary } : {}),
                  },
                  ...(event.message ? { technicalDetail: event.message } : {}),
                },
              },
            });
            await this.prisma.alertDelivery.update({
              where: { id: delivery.id },
              data: {
                status: AlertDeliveryStatus.sent,
                sentAt: new Date(),
                error: null,
                targetSnapshot: {
                  userId,
                  notificationId: record.id,
                },
              },
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await this.prisma.alertDelivery.update({
              where: { id: delivery.id },
              data: {
                status: AlertDeliveryStatus.failed,
                error: message,
                targetSnapshot: {
                  userId,
                },
              },
            });
          }
        }),
      );
    } catch (error) {
      logger.warn(
        { ruleId: rule.id, eventId: event.id, error },
        "Failed to send in-app alert notification",
      );
    } finally {
      await this.reconcileEventStatus(event.id);
    }
  }

  private async resolveInAppRecipients(rule: {
    orgId: string;
    createdById?: string | null;
    metadata?: Prisma.JsonValue | null;
  }): Promise<InAppRecipientResolution> {
    const metadata = this.toMetadata(rule.metadata);
    const recipients = new Set<string>();
    const configuredUsers = this.toStringArray(metadata?.notifyUserIds);
    if (configuredUsers.length) {
      configuredUsers.forEach((userId) => recipients.add(userId));
    }
    const notifyAll =
      metadata?.notifyAllMembers === true || metadata?.notifyAllUsers === true;
    if (notifyAll) {
      const members = await this.prisma.membership.findMany({
        where: {
          orgId: rule.orgId,
          user: { isActive: true },
        },
        select: { userId: true },
      });
      members.forEach((member) => recipients.add(member.userId));
    }
    if (!recipients.size && rule.createdById) {
      recipients.add(rule.createdById);
    }
    const candidateUserIds = Array.from(recipients);
    const resolution = await this.filterRecipientsWithAlertReadAccess(
      rule.orgId,
      candidateUserIds,
    );
    return {
      candidateUserIds,
      ...resolution,
    };
  }

  private async filterRecipientsWithAlertReadAccess(
    orgId: string,
    userIds: string[],
  ): Promise<Pick<InAppRecipientResolution, "allowedUserIds" | "missingPermissionUserIds">> {
    if (userIds.length === 0) {
      return {
        allowedUserIds: [],
        missingPermissionUserIds: [],
      };
    }

    const memberships = await this.prisma.membership.findMany({
      where: {
        orgId,
        userId: { in: userIds },
        isActive: true,
        user: { isActive: true },
        org: { isActive: true },
      },
      select: {
        userId: true,
        role: {
          select: {
            permissions: {
              select: {
                permission: {
                  select: { name: true },
                },
              },
            },
          },
        },
        roles: {
          select: {
            role: {
              select: {
                permissions: {
                  select: {
                    permission: {
                      select: { name: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const allowedRecipients = new Set<string>();
    const missingPermissionRecipients = new Set<string>();

    for (const membership of memberships) {
      if (hasMembershipPermission(membership, ALERTS_READ_PERMISSION)) {
        allowedRecipients.add(membership.userId);
      } else {
        missingPermissionRecipients.add(membership.userId);
      }
    }

    return {
      allowedUserIds: userIds.filter((userId) => allowedRecipients.has(userId)),
      missingPermissionUserIds: userIds.filter((userId) =>
        missingPermissionRecipients.has(userId),
      ),
    };
  }

  private logFilteredInAppRecipients(input: {
    orgId: string;
    ruleId?: string;
    eventId: string;
    candidateUserIds: string[];
    allowedUserIds: string[];
    missingPermissionUserIds: string[];
  }) {
    if (input.missingPermissionUserIds.length === 0) {
      return;
    }

    const filteredUserIdSample = input.missingPermissionUserIds.slice(
      0,
      FILTERED_RECIPIENT_SAMPLE_LIMIT,
    );
    logger.warn(
      {
        orgId: input.orgId,
        ruleId: input.ruleId,
        eventId: input.eventId,
        requiredPermission: ALERTS_READ_PERMISSION,
        candidateRecipientCount: input.candidateUserIds.length,
        allowedRecipientCount: input.allowedUserIds.length,
        filteredRecipientCount: input.missingPermissionUserIds.length,
        filteredUserIdSample,
        hasMoreFilteredRecipients:
          input.missingPermissionUserIds.length > filteredUserIdSample.length,
      },
      "Filtered in-app alert recipients without required permission",
    );
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  private toMetadata(
    value: Prisma.JsonValue | null | undefined,
  ): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private resolveMetricProvider(rule: { metricProvider: AlertMetricProvider }) {
    return this.metricProviders.find((provider) => provider.supports(rule));
  }

  private normalizeAlertContext(
    context?: Record<string, unknown> | null,
  ): Record<string, unknown> | undefined {
    if (!context) {
      return context ?? undefined;
    }

    const normalizedContext = { ...context };
    const rawCountry =
      typeof normalizedContext.country === "string"
        ? normalizedContext.country
        : null;
    const rawCountryCode =
      typeof normalizedContext.countryCode === "string"
        ? normalizedContext.countryCode
        : null;
    const countryValue = rawCountryCode ?? rawCountry;
    const normalizedCountry = normalizeCountryCode(countryValue);

    if (normalizedCountry) {
      normalizedContext.countryCode = normalizedCountry;
      if (!normalizedContext.countryName) {
        const rawCountryLooksLikeCode = rawCountry
          ? /^[A-Za-z]{2,3}$/.test(rawCountry.trim())
          : false;
        if (
          rawCountry &&
          rawCountry !== normalizedCountry &&
          !rawCountryLooksLikeCode
        ) {
          normalizedContext.countryName = rawCountry;
        } else {
          const resolvedName = getCountryName(normalizedCountry);
          if (resolvedName) {
            normalizedContext.countryName = resolvedName;
          }
        }
      }
    }

    return normalizedContext;
  }

  private shouldTrigger(
    rule: {
      operator: AlertOperator;
      thresholdValue: Prisma.Decimal | null;
      thresholdLower: Prisma.Decimal | null;
      thresholdUpper: Prisma.Decimal | null;
    },
    latest: number,
    previous?: number | null,
    changePercent?: number | null,
  ): false | { message?: string; context?: Record<string, unknown> } {
    const thresholdValue =
      rule.thresholdValue !== null ? Number(rule.thresholdValue) : undefined;
    const lower =
      rule.thresholdLower !== null ? Number(rule.thresholdLower) : undefined;
    const upper =
      rule.thresholdUpper !== null ? Number(rule.thresholdUpper) : undefined;
    switch (rule.operator) {
      case "gt":
        return thresholdValue !== undefined && latest > thresholdValue
          ? {
              message: `Value ${latest} is greater than ${thresholdValue}`,
              context: { latest, threshold: thresholdValue },
            }
          : false;
      case "gte":
        return thresholdValue !== undefined && latest >= thresholdValue
          ? {
              message: `Value ${latest} is >= ${thresholdValue}`,
              context: { latest, threshold: thresholdValue },
            }
          : false;
      case "lt":
        return thresholdValue !== undefined && latest < thresholdValue
          ? {
              message: `Value ${latest} is below ${thresholdValue}`,
              context: { latest, threshold: thresholdValue },
            }
          : false;
      case "lte":
        return thresholdValue !== undefined && latest <= thresholdValue
          ? {
              message: `Value ${latest} is <= ${thresholdValue}`,
              context: { latest, threshold: thresholdValue },
            }
          : false;
      case "eq":
        return thresholdValue !== undefined && latest === thresholdValue
          ? {
              message: `Value ${latest} equals ${thresholdValue}`,
              context: { latest, threshold: thresholdValue },
            }
          : false;
      case "outside_range":
        if (lower === undefined || upper === undefined) {
          return false;
        }
        return latest < lower || latest > upper
          ? {
              message: `Value ${latest} is outside ${lower}-${upper}`,
              context: { latest, lower, upper },
            }
          : false;
      case "within_range":
        if (lower === undefined || upper === undefined) {
          return false;
        }
        return latest >= lower && latest <= upper
          ? {
              message: `Value ${latest} is within ${lower}-${upper}`,
              context: { latest, lower, upper },
            }
          : false;
      case "change_up_pct":
        return typeof changePercent === "number" &&
          thresholdValue !== undefined &&
          changePercent >= thresholdValue
          ? {
              message: `Change ${changePercent.toFixed(2)}% >= ${thresholdValue}%`,
              context: { changePercent },
            }
          : false;
      case "change_down_pct":
        return typeof changePercent === "number" &&
          thresholdValue !== undefined &&
          changePercent <= -1 * thresholdValue
          ? {
              message: `Change ${changePercent.toFixed(2)}% <= -${thresholdValue}%`,
              context: { changePercent },
            }
          : false;
      default:
        return false;
    }
  }

  private async enqueueNotificationJobs(
    deliveries: { id: string }[],
    orgId?: string,
  ) {
    if (deliveries.length === 0) {
      return;
    }
    const attempts = NOTIFICATION_BACKOFF_DELAYS_MS.length + 1;
    const traceId = ensureTraceId(getCurrentTraceId());
    await Promise.all(
      deliveries.map((delivery) =>
        this.queue.add(
          this.buildDeliveryJobName(delivery.id),
          { type: "deliver", deliveryId: delivery.id, orgId, traceId },
          {
            jobId: `deliver-${delivery.id}`,
            attempts,
            backoff: { type: "alertNotifications" },
            removeOnComplete: true,
            removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
          },
        ),
      ),
    );
  }

  async handleDeliveryJob(job: Job<AlertJobPayload>, token?: string) {
    if (job.data.type !== "deliver" || !job.data.deliveryId) {
      return;
    }
    const delivery = await this.prisma.alertDelivery.findUnique({
      where: { id: job.data.deliveryId },
      include: { event: { include: { rule: true } } },
    });
    if (!delivery || !delivery.event || !delivery.event.rule) {
      return;
    }
    const channel = delivery.targetSnapshot as {
      id?: string;
      type?: AlertChannelType;
      target?: string;
      name?: string;
      config?: unknown;
    } | null;
    if (!channel?.type || !channel?.target) {
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: {
          status: AlertDeliveryStatus.failed,
          error: "Invalid channel snapshot",
        },
      });
      await this.reconcileEventStatus(delivery.eventId);
      return;
    }
    if (delivery.status !== AlertDeliveryStatus.pending) {
      await this.reconcileEventStatus(delivery.eventId);
      return;
    }

    const ruleMuteUntilMs = this.extractMuteUntilMs(
      delivery.event.rule.metadata,
    );
    const channelMuteUntilMs = this.extractMuteUntilMs(channel.config);
    const muteUntilMs =
      Math.max(ruleMuteUntilMs ?? 0, channelMuteUntilMs ?? 0) || null;
    if (this.notificationThrottle.isMutedNow(muteUntilMs)) {
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: {
          status: AlertDeliveryStatus.sent,
          sentAt: new Date(),
          error: `suppressed: muted until ${new Date(muteUntilMs!).toISOString()}`,
        },
      });
      await this.reconcileEventStatus(delivery.eventId);
      return;
    }

    const minIntervalSeconds = this.extractNotifyIntervalSeconds(
      channel.config,
    );
    if (
      channel.type !== AlertChannelType.email &&
      channel.type !== AlertChannelType.webhook
    ) {
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: {
          status: AlertDeliveryStatus.failed,
          error: `Unsupported channel type ${channel.type}`,
        },
      });
      await this.reconcileEventStatus(delivery.eventId);
      return;
    }

    try {
      const hadScheduledAtMs = !!job.data.scheduledAtMs;
      if (job.data.scheduledAtMs && Date.now() < job.data.scheduledAtMs) {
        await job.moveToDelayed(job.data.scheduledAtMs, token);
        throw new DelayedError();
      }

      if (!job.data.scheduledAtMs) {
        const channelType = channel.type;
        const scheduledAtMs =
          await this.notificationThrottle.reserveNotificationScheduleMs({
            channelType,
            channelId: delivery.channelId ?? channel.id ?? null,
            minIntervalSeconds,
          });
        if (scheduledAtMs > Date.now()) {
          await job.updateData({ ...job.data, scheduledAtMs });
          await job.moveToDelayed(scheduledAtMs, token);
          throw new DelayedError();
        }
      }

      if (hadScheduledAtMs) {
        const updated = { ...job.data };
        if ("scheduledAtMs" in updated) {
          delete updated.scheduledAtMs;
        }
        await job.updateData(updated);
      }

      if (channel.type === "email") {
        await this.sendEmail(
          channel.target,
          delivery.event,
          delivery.event.rule,
        );
      } else if (channel.type === "webhook") {
        await this.sendWebhook(
          channel.target,
          delivery.event,
          delivery.event.rule,
        );
      } else {
        throw new Error(`Unsupported channel type ${channel.type}`);
      }
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: { status: AlertDeliveryStatus.sent, sentAt: new Date() },
      });
    } catch (error) {
      if (error instanceof DelayedError) {
        throw error;
      }
      const message = (error as Error)?.message ?? "unknown error";
      const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: {
          status: isLastAttempt
            ? AlertDeliveryStatus.failed
            : AlertDeliveryStatus.pending,
          error: message,
        },
      });
      logger.error(
        {
          delivery: delivery.id,
          channel: channel.name ?? channel.target,
          attempt: job.attemptsMade,
          error,
        },
        "Alert delivery attempt failed",
      );
      throw error;
    } finally {
      await this.reconcileEventStatus(delivery.eventId);
    }
  }

  private extractMuteUntilMs(input: unknown): number | null {
    if (!input || typeof input !== "object") {
      return null;
    }
    const config = input as Record<string, unknown>;
    const value =
      config["muteUntil"] ??
      config["mutedUntil"] ??
      config["silenceUntil"] ??
      config["silencedUntil"] ??
      config["mute_until"] ??
      config["muted_until"];
    const parsed =
      typeof value === "string" || typeof value === "number" || value == null
        ? value
        : null;
    return this.notificationThrottle.parseMuteUntilMs(parsed);
  }

  private extractNotifyIntervalSeconds(input: unknown): number | null {
    if (!input || typeof input !== "object") {
      return null;
    }
    const config = input as Record<string, unknown>;
    const secondsValue =
      config["notifyIntervalSeconds"] ??
      config["notifyIntervalSec"] ??
      config["notify_interval_seconds"] ??
      config["notify_interval_sec"] ??
      config["frequencySeconds"] ??
      config["frequencySec"] ??
      config["frequency_seconds"] ??
      config["frequency_sec"] ??
      config["minIntervalSeconds"] ??
      config["minIntervalSec"] ??
      config["min_interval_seconds"] ??
      config["min_interval_sec"];
    const minutesValue =
      config["notifyIntervalMinutes"] ??
      config["notifyIntervalMin"] ??
      config["notify_interval_minutes"] ??
      config["notify_interval_min"] ??
      config["frequencyMinutes"] ??
      config["frequencyMin"] ??
      config["frequency_minutes"] ??
      config["frequency_min"];

    const seconds = this.toPositiveFiniteNumber(secondsValue);
    if (seconds !== null) {
      return this.clampSeconds(seconds);
    }

    const minutes = this.toPositiveFiniteNumber(minutesValue);
    if (minutes !== null) {
      return this.clampSeconds(minutes * 60);
    }

    return null;
  }

  private toPositiveFiniteNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 0 ? value : null;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  }

  private clampSeconds(value: number): number {
    const normalized = Math.trunc(value);
    const maxSeconds = 365 * 24 * 3600;
    return Math.min(Math.max(normalized, 1), maxSeconds);
  }

  getNotificationBackoffDelay(attemptsMade: number): number {
    const index = Math.min(
      Math.max(attemptsMade - 1, 0),
      NOTIFICATION_BACKOFF_DELAYS_MS.length - 1,
    );
    return NOTIFICATION_BACKOFF_DELAYS_MS[index] ?? 60_000;
  }

  private async reconcileEventStatus(eventId: string) {
    const current = await this.prisma.alertEvent.findUnique({
      where: { id: eventId },
      select: { status: true },
    });
    if (
      !current ||
      current.status === AlertEventStatus.confirmed ||
      current.status === AlertEventStatus.ignored
    ) {
      return;
    }
    const deliveries = await this.prisma.alertDelivery.findMany({
      where: { eventId },
    });
    if (!deliveries.length) {
      return;
    }
    const hasPending = deliveries.some(
      (delivery) => delivery.status === AlertDeliveryStatus.pending,
    );
    if (hasPending) {
      return;
    }
    const anySent = deliveries.some(
      (delivery) => delivery.status === AlertDeliveryStatus.sent,
    );
    await this.prisma.alertEvent.update({
      where: { id: eventId },
      data: {
        status: anySent ? AlertEventStatus.delivered : AlertEventStatus.failed,
      },
    });
  }

  private async sendEmail(
    target: string,
    event: {
      metricValue: Prisma.Decimal;
      triggeredAt: Date;
      ruleId: string;
      message?: string | null;
      changePercent?: number | null;
    },
    rule: {
      name: string;
      metricSlug: string;
      operator?: AlertOperator;
      thresholdValue?: Prisma.Decimal | null;
      thresholdLower?: Prisma.Decimal | null;
      thresholdUpper?: Prisma.Decimal | null;
    },
  ) {
    const metricSlug = normalizeMetricSlug(rule.metricSlug);
    const threshold =
      rule.thresholdValue !== null && rule.thresholdValue !== undefined
        ? Number(rule.thresholdValue)
        : rule.thresholdUpper !== null && rule.thresholdUpper !== undefined
          ? Number(rule.thresholdUpper)
          : rule.thresholdLower !== null && rule.thresholdLower !== undefined
            ? Number(rule.thresholdLower)
            : null;
    const html = this.email.buildAlertTemplate({
      ruleName: rule.name,
      metric: metricSlug,
      value: Number(event.metricValue),
      threshold,
      triggeredAt: event.triggeredAt.toISOString(),
      message: event.message ?? undefined,
      changePercent: event.changePercent ?? null,
    });
    const text = this.email.buildAlertTextTemplate({
      ruleName: rule.name,
      metric: metricSlug,
      value: Number(event.metricValue),
      threshold,
      triggeredAt: event.triggeredAt.toISOString(),
      message: event.message ?? undefined,
      changePercent: event.changePercent ?? null,
    });
    await this.email.send({
      to: target,
      subject: `[Alert] ${rule.name} triggered`,
      html,
      text,
    });
  }

  private async sendWebhook(
    target: string,
    event: {
      id: string;
      triggeredAt: Date;
      metricValue: Prisma.Decimal;
      severity: AlertSeverity;
      ruleId: string;
      message?: string | null;
    },
    rule: {
      name: string;
      metricSlug: string;
      operator?: AlertOperator;
      thresholdValue?: Prisma.Decimal | null;
      thresholdLower?: Prisma.Decimal | null;
      thresholdUpper?: Prisma.Decimal | null;
    },
  ) {
    const resolvedTarget = await this.resolveSafeWebhookTarget(target);
    const metricSlug = normalizeMetricSlug(rule.metricSlug);
    const payload = {
      alertId: event.id,
      ruleName: rule.name,
      metric: metricSlug,
      currentValue: Number(event.metricValue),
      threshold:
        rule.thresholdValue !== null && rule.thresholdValue !== undefined
          ? Number(rule.thresholdValue)
          : rule.thresholdUpper !== null && rule.thresholdUpper !== undefined
            ? Number(rule.thresholdUpper)
            : rule.thresholdLower !== null && rule.thresholdLower !== undefined
              ? Number(rule.thresholdLower)
              : null,
      triggeredAt: event.triggeredAt.toISOString(),
      severity: event.severity,
      operator: rule.operator,
      message: event.message,
    };
    const pinnedLookup = this.createPinnedLookup(
      resolvedTarget.hostname,
      resolvedTarget.addresses,
    );
    await firstValueFrom(
      this.http.post(target, payload, {
        timeout: this.env.alertingConfig.webhookTimeoutMs,
        maxRedirects: 0,
        httpAgent: new HttpAgent({ keepAlive: false, lookup: pinnedLookup }),
        httpsAgent: new HttpsAgent({ keepAlive: false, lookup: pinnedLookup }),
      }),
    );
  }

  private async normalizeChannelTarget(
    type: AlertChannelType,
    target: string,
  ): Promise<string> {
    const normalizedTarget = target.trim();
    if (type === AlertChannelType.email) {
      return this.email.normalizeEmailTarget(normalizedTarget);
    }
    if (type === AlertChannelType.webhook) {
      await this.assertSafeWebhookTarget(normalizedTarget);
    }
    return normalizedTarget;
  }

  private async assertSafeWebhookTarget(
    target: string,
    options?: { runtime?: boolean },
  ): Promise<void> {
    const syncResult = validateSsrfUrl(target);
    if (!syncResult.valid) {
      throw this.createWebhookTargetError(syncResult.reason, options);
    }

    const asyncResult = await validateSsrfUrlAsync(target);
    if (!asyncResult.valid) {
      throw this.createWebhookTargetError(asyncResult.reason, options);
    }
  }

  private async resolveSafeWebhookTarget(target: string): Promise<{
    hostname: string;
    addresses: SsrfResolvedAddress[];
  }> {
    const result = await resolveValidatedSsrfUrlAsync(target, {
      allowUnresolved: false,
    });
    if (!result.valid || !result.hostname || !result.addresses?.length) {
      throw this.createWebhookTargetError(
        result.reason ?? "Hostname could not be resolved",
        { runtime: true },
      );
    }
    return {
      hostname: result.hostname,
      addresses: result.addresses,
    };
  }

  private createPinnedLookup(
    expectedHostname: string,
    addresses: SsrfResolvedAddress[],
  ): LookupFunction {
    const normalizedExpectedHostname = expectedHostname.toLowerCase();
    return ((
      hostname: string,
      options: Parameters<LookupFunction>[1],
      callback: Parameters<LookupFunction>[2],
    ) => {
      const invokeCallback = callback as (...args: unknown[]) => void;
      if (hostname.toLowerCase() !== normalizedExpectedHostname) {
        invokeCallback(
          new Error(`Pinned lookup rejected unexpected hostname: ${hostname}`),
        );
        return;
      }

      const requestedFamily =
        typeof options === "number"
          ? options
          : typeof options?.family === "number"
            ? Number(options.family)
            : 0;
      const filtered =
        requestedFamily === 4 || requestedFamily === 6
          ? addresses.filter((entry) => entry.family === requestedFamily)
          : addresses;

      if (typeof options === "object" && options?.all === true) {
        if (filtered.length === 0) {
          invokeCallback(
            new Error(
              `Pinned lookup has no ${requestedFamily || "usable"} addresses for ${hostname}`,
            ),
          );
          return;
        }
        invokeCallback(
          null,
          filtered.map((entry) => ({
            address: entry.address,
            family: entry.family,
          })),
        );
        return;
      }

      const selected = filtered[0] ?? addresses[0];
      if (!selected) {
        invokeCallback(
          new Error(`Pinned lookup has no usable addresses for ${hostname}`),
        );
        return;
      }
      invokeCallback(null, selected.address, selected.family);
    }) as LookupFunction;
  }

  private createWebhookTargetError(
    reason?: string,
    options?: { runtime?: boolean },
  ): Error {
    const message = `Unsafe webhook target${reason ? `: ${reason}` : ""}`;
    if (options?.runtime) {
      return new Error(message);
    }
    return new BadRequestException(message);
  }

  async scheduleScanJob() {
    await this.queue.add(
      "scan-active-rules",
      { type: "scan" },
      {
        jobId: "scan-active-rules",
        repeat: { every: this.env.alertingConfig.scanIntervalMs },
        removeOnComplete: true,
      },
    );
  }

  private async ensureRuleSchedule(rule: {
    id: string;
    orgId?: string;
    checkIntervalSec: number;
    status: AlertStatus;
  }) {
    await this.removeJob(rule.id, false);
    if (rule.status !== AlertStatus.active) {
      return;
    }
    const every = Math.max(60, rule.checkIntervalSec) * 1000;
    await this.queue.add(
      this.buildRuleJobName(rule.id),
      { type: "evaluate", ruleId: rule.id, orgId: rule.orgId },
      {
        jobId: `evaluate-${rule.id}`,
        repeat: { every },
        removeOnComplete: true,
        removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
      },
    );
  }

  private buildRuleJobName(ruleId: string) {
    return `evaluate-rule:${ruleId}`;
  }

  private buildDeliveryJobName(deliveryId: string) {
    return `deliver-notification:${deliveryId}`;
  }

  private async executeWithConcurrencyLimit<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    concurrency: number,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const results: R[] = new Array(items.length);
    let index = 0;

    const worker = async () => {
      while (index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await fn(items[currentIndex]!, currentIndex);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () =>
        worker(),
      ),
    );

    return results;
  }

  private async removeJob(ruleId: string, includeRepeats = true) {
    if (includeRepeats) {
      const repeatables = await this.queue.getRepeatableJobs();
      for (const job of repeatables) {
        if (job.name === this.buildRuleJobName(ruleId)) {
          await this.queue.removeRepeatableByKey(job.key);
        }
      }
    }
    await this.queue.remove(`evaluate-${ruleId}`);
    await this.queue.remove(`evaluate:${ruleId}`);
    await this.queue.remove(this.buildRuleJobName(ruleId));
  }
}
