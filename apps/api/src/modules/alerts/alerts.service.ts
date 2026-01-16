import { createLogger, ensureTraceId, getCountryName, getCurrentTraceId, normalizeCountryCode } from "@modular/utils";
import { HttpService } from "@nestjs/axios";
import { Inject, Injectable } from "@nestjs/common";
import {
  AlertChannelType,
  AlertDeliveryStatus,
  AlertEventStatus,
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
  AlertStatus,
  NotificationType,
  Prisma
} from "@prisma/client";
import { DelayedError, Job, Queue } from "bullmq";
import { PubSubEngine } from "graphql-subscriptions";
import { firstValueFrom } from "rxjs";

import { toPrismaJsonValue, toPrismaJsonValueOrUndefined } from "../../common/prisma-json";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";
import { NotificationsService } from "../notifications/notifications.service";

import { AlertsNotificationThrottleService } from "./alerts-notification-throttle.service";
import { AlertRuleTuningSuggestion, AlertTuningAction, quantile, safeMean } from "./alerts-tuning";
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
      traceId?: string;
    }
  | {
      type: "deliver";
      deliveryId: string;
      traceId?: string;
      scheduledAtMs?: number;
    };

const logger = createLogger({ name: "alerts" });
const NOTIFICATION_BACKOFF_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

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
    @Inject(ALERT_METRIC_PROVIDERS) metricProviders: MetricProvider[]
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
      orderBy: { createdAt: "asc" }
    });
  }

  async createChannel(orgId: string, input: AlertChannelInput, createdById?: string) {
    const target =
      input.type === AlertChannelType.email ? this.email.normalizeEmailTarget(input.target) : input.target;
    return this.prisma.alertNotificationChannel.create({
      data: {
        orgId,
        name: input.name,
        type: input.type,
        target,
        config: toPrismaJsonValue(input.config ?? {}),
        isActive: input.isActive ?? true,
        createdById
      }
    });
  }

  async updateChannel(orgId: string, channelId: string, input: UpdateAlertChannelInput) {
    const existing = await this.prisma.alertNotificationChannel.findUnique({ where: { id: channelId } });
    if (!existing || existing.orgId !== orgId) {
      throw new Error("Alert channel not found for this org");
    }

    const data: Prisma.AlertNotificationChannelUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.target !== undefined) {
      data.target =
        existing.type === AlertChannelType.email ? this.email.normalizeEmailTarget(input.target) : input.target;
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.config !== undefined) {
      data.config = toPrismaJsonValue(input.config ?? {});
    }

    return this.prisma.alertNotificationChannel.update({
      where: { id: channelId },
      data
    });
  }

  async deleteChannel(orgId: string, channelId: string) {
    const existing = await this.prisma.alertNotificationChannel.findUnique({ where: { id: channelId } });
    if (!existing || existing.orgId !== orgId) {
      return false;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.alertDelivery.updateMany({
        where: { channelId, status: AlertDeliveryStatus.pending },
        data: {
          status: AlertDeliveryStatus.failed,
          error: "channel deleted"
        }
      });
      await tx.alertDelivery.updateMany({
        where: { channelId },
        data: { channelId: null }
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
    return this.prisma.alertRule.findMany({
      where: { orgId },
      include: {
        channels: { include: { channel: true } },
        dataItem: true
      },
      orderBy: { createdAt: "asc" }
    });
  }

  async listEvents(orgId: string, limit = 50, metricSlug?: string) {
    const normalizedMetricSlug = metricSlug?.trim();
    return this.prisma.alertEvent.findMany({
      where: {
        rule: {
          orgId,
          ...(normalizedMetricSlug ? { metricSlug: normalizedMetricSlug } : {})
        }
      },
      include: { rule: true, deliveries: { include: { channel: true } } },
      orderBy: { triggeredAt: "desc" },
      take: limit
    });
  }

  async getEventReplay(orgId: string, eventId: string, windowDays = 30) {
    const normalizedDays = Math.min(Math.max(Math.trunc(windowDays), 1), 365);
    const event = await this.prisma.alertEvent.findUnique({
      where: { id: eventId },
      include: { rule: true }
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
    const metricSlug = event.rule.metricSlug;
    const context =
      event.context && typeof event.context === "object" && !Array.isArray(event.context)
        ? (event.context as Record<string, unknown>)
        : null;
    const recordedAtRaw = typeof context?.recordedAt === "string" ? context.recordedAt : null;
    const center = recordedAtRaw ? new Date(recordedAtRaw) : event.triggeredAt;
    const windowMs = normalizedDays * 24 * 60 * 60 * 1000;
    const start = new Date(center.getTime() - windowMs);
    const end = new Date(center.getTime() + windowMs);

    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        item: { slug: metricSlug },
        recordedAt: {
          gte: start,
          lte: end
        }
      },
      orderBy: { recordedAt: "asc" },
      select: {
        recordedAt: true,
        value: true,
        unit: true
      }
    });

    const unit = points.find((point) => point.unit)?.unit ?? null;
    return {
      eventId: event.id,
      metricProvider: event.rule.metricProvider,
      metricSlug,
      unit,
      points: points.map((point) => ({
        timestamp: point.recordedAt,
        value: Number(point.value)
      }))
    };
  }

  async getRuleTuningSuggestion(orgId: string, ruleId: string, windowDays = 30): Promise<AlertRuleTuningSuggestion | null> {
    const normalizedDays = Math.min(Math.max(Math.trunc(windowDays), 1), 365);
    const rule = await this.prisma.alertRule.findUnique({ where: { id: ruleId } });
    if (!rule || rule.orgId !== orgId) {
      return null;
    }

    const since = new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000);
    const events = await this.prisma.alertEvent.findMany({
      where: {
        ruleId: rule.id,
        triggeredAt: { gte: since }
      },
      orderBy: { triggeredAt: "desc" },
      take: 500,
      select: {
        status: true,
        metricValue: true,
        changePercent: true
      }
    });

    const totalEvents = events.length;
    const confirmed: number[] = [];
    const ignored: number[] = [];

    for (const event of events) {
      if (!([AlertEventStatus.confirmed, AlertEventStatus.ignored] as AlertEventStatus[]).includes(event.status)) {
        continue;
      }
      let value: number | null = null;
      if (rule.operator === AlertOperator.change_up_pct || rule.operator === AlertOperator.change_down_pct) {
        if (typeof event.changePercent !== "number" || !Number.isFinite(event.changePercent)) {
          continue;
        }
        value = rule.operator === AlertOperator.change_down_pct ? -event.changePercent : event.changePercent;
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
    const falsePositiveRate = reviewedEvents ? ignoredEvents / reviewedEvents : null;

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
      suggestedThresholdUpper: null
    };

    if (reviewedEvents < 5) {
      return {
        ...base,
        message: "Not enough reviewed alerts yet. Confirm/Ignore a few events to generate tuning suggestions."
      };
    }

    const currentThresholdValue =
      rule.thresholdValue !== null && rule.thresholdValue !== undefined ? Number(rule.thresholdValue) : null;
    const currentLower = rule.thresholdLower !== null && rule.thresholdLower !== undefined ? Number(rule.thresholdLower) : null;
    const currentUpper = rule.thresholdUpper !== null && rule.thresholdUpper !== undefined ? Number(rule.thresholdUpper) : null;

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
      ([AlertOperator.gt, AlertOperator.gte, AlertOperator.change_up_pct, AlertOperator.change_down_pct] as AlertOperator[]).includes(
        rule.operator
      )
    ) {
      const suggested = suggestHighThreshold(currentThresholdValue);
      if (suggested !== null && currentThresholdValue !== null && suggested > currentThresholdValue) {
        const ignoredAvg = safeMean(ignored);
        const confirmedAvg = safeMean(confirmed);
        return {
          ...base,
          action: AlertTuningAction.increase_threshold,
          suggestedThresholdValue: suggested,
          message: `High false-positive rate: consider raising threshold from ${currentThresholdValue} to ~${suggested.toFixed(4)} (ignored avg ${ignoredAvg?.toFixed(4) ?? "n/a"}, confirmed avg ${confirmedAvg?.toFixed(4) ?? "n/a"}).`
        };
      }
      return base;
    }

    if (([AlertOperator.lt, AlertOperator.lte] as AlertOperator[]).includes(rule.operator)) {
      const suggested = suggestLowThreshold(currentThresholdValue);
      if (suggested !== null && currentThresholdValue !== null && suggested < currentThresholdValue) {
        const ignoredAvg = safeMean(ignored);
        const confirmedAvg = safeMean(confirmed);
        return {
          ...base,
          action: AlertTuningAction.decrease_threshold,
          suggestedThresholdValue: suggested,
          message: `High false-positive rate: consider lowering threshold from ${currentThresholdValue} to ~${suggested.toFixed(4)} (ignored avg ${ignoredAvg?.toFixed(4) ?? "n/a"}, confirmed avg ${confirmedAvg?.toFixed(4) ?? "n/a"}).`
        };
      }
      return base;
    }

    if (rule.operator === AlertOperator.outside_range && currentLower !== null && currentUpper !== null) {
      const lowerIgnored: number[] = [];
      const lowerConfirmed: number[] = [];
      const upperIgnored: number[] = [];
      const upperConfirmed: number[] = [];

      for (const event of events) {
        if (!([AlertEventStatus.confirmed, AlertEventStatus.ignored] as AlertEventStatus[]).includes(event.status)) {
          continue;
        }
        const value = Number(event.metricValue);
        if (!Number.isFinite(value)) {
          continue;
        }
        const target = value < currentLower ? "lower" : value > currentUpper ? "upper" : null;
        if (!target) {
          continue;
        }
        if (target === "lower") {
          (event.status === AlertEventStatus.confirmed ? lowerConfirmed : lowerIgnored).push(value);
        } else {
          (event.status === AlertEventStatus.confirmed ? upperConfirmed : upperIgnored).push(value);
        }
      }

      const suggestLower = () => {
        if (!lowerIgnored.length) {
          return null;
        }
        const minIgnored = Math.min(...lowerIgnored);
        const maxConfirmed = lowerConfirmed.length ? Math.max(...lowerConfirmed) : null;
        if (maxConfirmed !== null && maxConfirmed < minIgnored) {
          return (maxConfirmed + minIgnored) / 2;
        }
        const p10 = quantile(lowerIgnored, 0.1);
        return typeof p10 === "number" && Number.isFinite(p10) ? Math.min(currentLower, p10) : null;
      };

      const suggestUpper = () => {
        if (!upperIgnored.length) {
          return null;
        }
        const maxIgnored = Math.max(...upperIgnored);
        const minConfirmed = upperConfirmed.length ? Math.min(...upperConfirmed) : null;
        if (minConfirmed !== null && minConfirmed > maxIgnored) {
          return (minConfirmed + maxIgnored) / 2;
        }
        const p90 = quantile(upperIgnored, 0.9);
        return typeof p90 === "number" && Number.isFinite(p90) ? Math.max(currentUpper, p90) : null;
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
        message: `Consider adjusting range from [${currentLower}, ${currentUpper}] to [${suggestedLower?.toFixed(4) ?? currentLower}, ${suggestedUpper?.toFixed(4) ?? currentUpper}] based on ignored/confirmed splits.`
      };
    }

    return base;
  }

  async updateEventStatus(orgId: string, eventId: string, status: AlertEventStatus, note?: string, updatedById?: string) {
    if (!([AlertEventStatus.confirmed, AlertEventStatus.ignored] as AlertEventStatus[]).includes(status)) {
      throw new Error("Unsupported alert event status update");
    }
    const existing = await this.prisma.alertEvent.findUnique({
      where: { id: eventId },
      include: { rule: true }
    });
    if (!existing || existing.rule?.orgId !== orgId) {
      throw new Error("Alert event not found for this org");
    }
    const trimmedNote = typeof note === "string" ? note.trim() : undefined;
    const existingContext =
      existing.context && typeof existing.context === "object" && !Array.isArray(existing.context)
        ? (existing.context as Record<string, unknown>)
        : null;
    const existingFeedback =
      existingContext?.feedback && typeof existingContext.feedback === "object" && !Array.isArray(existingContext.feedback)
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
              updatedAt: new Date().toISOString()
            }
          }
        : undefined;

    return this.prisma.alertEvent.update({
      where: { id: eventId },
      data: { status, ...(nextContext ? { context: nextContext } : {}) },
      include: { rule: true, deliveries: { include: { channel: true } } }
    });
  }

  async upsertRule(orgId: string, input: UpsertAlertRuleInput, createdById?: string) {
    const existingRule = input.id ? await this.prisma.alertRule.findUnique({ where: { id: input.id } }) : null;
    if (input.id && (!existingRule || existingRule.orgId !== orgId)) {
      throw new Error("Alert rule not found for this org");
    }

    const metricProvider = input.metricProvider ?? existingRule?.metricProvider ?? AlertMetricProvider.economic_data;
    if (!this.resolveMetricProvider({ metricProvider })) {
      throw new Error(`No metric provider registered for type ${metricProvider}`);
    }
    const dataItem =
      metricProvider === AlertMetricProvider.economic_data
        ? await this.prisma.economicDataItem.findUnique({
            where: { slug: input.metricSlug }
          })
        : null;
    const baseData: Prisma.AlertRuleUncheckedCreateInput = {
      orgId,
      name: input.name,
      description: input.description,
      severity: input.severity ?? AlertSeverity.medium,
      status: input.status ?? AlertStatus.active,
      metricProvider,
      metricSlug: input.metricSlug,
      operator: input.operator,
      thresholdValue: input.thresholdValue !== undefined ? new Prisma.Decimal(input.thresholdValue) : null,
      thresholdLower: input.thresholdLower !== undefined ? new Prisma.Decimal(input.thresholdLower) : null,
      thresholdUpper: input.thresholdUpper !== undefined ? new Prisma.Decimal(input.thresholdUpper) : null,
      changeWindowMin: input.changeWindowMin ?? null,
      cooldownSeconds: input.cooldownSeconds ?? 3600,
      checkIntervalSec: input.checkIntervalSec ?? 300,
      metadata: toPrismaJsonValue(input.metadata ?? {}),
      createdById,
      dataItemId: metricProvider === AlertMetricProvider.economic_data ? dataItem?.id ?? null : null
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
            dataItemId: baseData.dataItemId
          }
        });
      } else {
        currentRule = await tx.alertRule.create({ data: baseData });
      }

      if (input.channelIds) {
        await tx.alertRuleChannel.deleteMany({ where: { ruleId: currentRule.id } });
        for (const channelId of input.channelIds) {
          await tx.alertRuleChannel.create({
            data: {
              ruleId: currentRule.id,
              channelId
            }
          });
        }
      }

      return currentRule;
    });

    await this.ensureRuleSchedule(rule);
    await this.enqueueRuleCheck(rule.id);
    return rule;
  }

  async deleteRule(orgId: string, ruleId: string) {
    const existing = await this.prisma.alertRule.findUnique({ where: { id: ruleId } });
    if (!existing || existing.orgId !== orgId) {
      return false;
    }
    await this.prisma.alertRule.delete({ where: { id: ruleId } });
    await this.removeJob(ruleId, true);
    return true;
  }

  async enqueueRuleCheck(ruleId: string) {
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      this.buildRuleJobName(ruleId),
      { type: "evaluate", ruleId, traceId },
      {
        jobId: `evaluate:${ruleId}:${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: false
      }
    );
  }

  async enqueueActiveRuleChecks() {
    const activeRules = await this.prisma.alertRule.findMany({
      where: { status: AlertStatus.active }
    });
    for (const rule of activeRules) {
      await this.enqueueRuleCheck(rule.id);
    }
  }

  async ensureAllSchedules() {
    const activeRules = await this.prisma.alertRule.findMany({
      where: { status: AlertStatus.active }
    });
    for (const rule of activeRules) {
      await this.ensureRuleSchedule(rule);
    }
  }

  async evaluateRule(ruleId: string) {
    const rule = await this.prisma.alertRule.findUnique({
      where: { id: ruleId },
      include: { channels: { include: { channel: true } } }
    });
    if (!rule || rule.status !== AlertStatus.active) {
      return null;
    }

    if (rule.lastTriggeredAt) {
      const nextAllowed = rule.lastTriggeredAt.getTime() + rule.cooldownSeconds * 1000;
      if (Date.now() < nextAllowed) {
        return null;
      }
    }

    const provider = this.resolveMetricProvider(rule);
    if (!provider) {
      logger.warn({ ruleId: rule.id, metricProvider: rule.metricProvider }, "Alert rule has no metric provider registered");
      return null;
    }

    const { latest, previous, changePercent, context: providerContext } = await provider.fetch(rule);
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
      ...(triggered.context ?? {})
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
        context: toPrismaJsonValueOrUndefined(context)
      }
    });

    await this.prisma.alertRule.update({
      where: { id: rule.id },
      data: { lastTriggeredAt: new Date() }
    });

    const activeChannels = rule.channels
      .map((link) => link.channel)
      .filter((channel): channel is NonNullable<typeof channel> => !!channel && channel.isActive);

    const externalDeliveries = await Promise.all(
      activeChannels.map((channel) =>
        this.prisma.alertDelivery.create({
          data: {
            eventId: event.id,
            channelId: channel.id,
            channelType: channel.type,
            targetSnapshot: channel
          }
        })
      )
    );

    const inAppDeliveries = await this.createInAppDeliveries(rule, event.id);

    if (externalDeliveries.length > 0) {
      await this.enqueueNotificationJobs(externalDeliveries);
    }

    const hasAnyDeliveries = externalDeliveries.length > 0 || inAppDeliveries.length > 0;
    if (!hasAnyDeliveries) {
      await this.prisma.alertEvent.update({
        where: { id: event.id },
        data: { status: AlertEventStatus.delivered }
      });
    }

    if (inAppDeliveries.length > 0) {
      void this.deliverInAppNotifications(
        rule,
        {
          id: event.id,
          metricValue: event.metricValue,
          changePercent: event.changePercent ?? null,
          message: event.message,
          context: context ?? null
        },
        inAppDeliveries
      );
    }

    const streamStatus = hasAnyDeliveries ? event.status : AlertEventStatus.delivered;
    await this.pubsub.publish("alertEvents", {
      orgId: rule.orgId,
      event: {
        id: event.id,
        ruleId: rule.id,
        ruleName: rule.name,
        metricProvider: rule.metricProvider,
        metricSlug: rule.metricSlug,
        triggeredAt: event.triggeredAt,
        message: triggered.message,
        severity: rule.severity,
        metricValue: Number(event.metricValue),
        changePercent: event.changePercent ?? null,
        status: streamStatus,
        context: (context as Record<string, unknown> | undefined) ?? null
      }
    } satisfies AlertEventPayload);

    return { event, deliveries: externalDeliveries };
  }

  private async createInAppDeliveries(
    rule: { orgId: string; createdById?: string | null; metadata?: Prisma.JsonValue | null },
    eventId: string
  ) {
    const muteUntilMs = this.extractMuteUntilMs(rule.metadata);
    if (this.notificationThrottle.isMutedNow(muteUntilMs)) {
      return [] as { id: string; userId: string }[];
    }
    const recipients = await this.resolveInAppRecipients(rule);
    if (!recipients.length) {
      return [] as { id: string; userId: string }[];
    }
    const created = await Promise.all(
      recipients.map(async (userId) => {
        const delivery = await this.prisma.alertDelivery.create({
          data: {
            eventId,
            channelType: AlertChannelType.in_app,
            targetSnapshot: { userId }
          }
        });
        return { id: delivery.id, userId };
      })
    );
    return created;
  }

  private async deliverInAppNotifications(
    rule: { id: string; orgId: string; name: string; metricSlug: string; severity: AlertSeverity; createdById?: string | null; metadata?: Prisma.JsonValue | null },
    event: {
      id: string;
      metricValue: Prisma.Decimal;
      changePercent?: number | null;
      message?: string | null;
      context?: Record<string, unknown> | null;
    },
    deliveries: { id: string; userId: string }[]
  ) {
    const metricValue = Number(event.metricValue);
    const title = `Alert triggered: ${rule.name}`;
    const changeText =
      typeof event.changePercent === "number" && Number.isFinite(event.changePercent)
        ? ` (${event.changePercent.toFixed(2)}%)`
        : "";
    const body =
      event.message ??
      `Metric ${rule.metricSlug} triggered at ${Number.isFinite(metricValue) ? metricValue : "N/A"}${changeText}`;
    const context =
      event.context && typeof event.context === "object" && !Array.isArray(event.context)
        ? (event.context as Record<string, unknown>)
        : null;
    const contextSummary = context
      ? {
          countryCode: typeof context.countryCode === "string" ? context.countryCode : undefined,
          countryName: typeof context.countryName === "string" ? context.countryName : undefined,
          itemName: typeof context.itemName === "string" ? context.itemName : undefined,
          sourceName: typeof context.sourceName === "string" ? context.sourceName : undefined,
          recordedAt: typeof context.recordedAt === "string" ? context.recordedAt : undefined,
          unit: typeof context.unit === "string" ? context.unit : undefined
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
                metricSlug: rule.metricSlug,
                metricValue,
                ...(typeof event.changePercent === "number" && Number.isFinite(event.changePercent)
                  ? { changePercent: event.changePercent }
                  : {}),
                ...(contextSummary ? { context: contextSummary } : {})
              }
            });
            await this.prisma.alertDelivery.update({
              where: { id: delivery.id },
              data: {
                status: AlertDeliveryStatus.sent,
                sentAt: new Date(),
                error: null,
                targetSnapshot: {
                  userId,
                  notificationId: record.id
                }
              }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.prisma.alertDelivery.update({
              where: { id: delivery.id },
              data: {
                status: AlertDeliveryStatus.failed,
                error: message,
                targetSnapshot: {
                  userId
                }
              }
            });
          }
        })
      );
    } catch (error) {
      logger.warn({ ruleId: rule.id, eventId: event.id, error }, "Failed to send in-app alert notification");
    } finally {
      await this.reconcileEventStatus(event.id);
    }
  }

  private async resolveInAppRecipients(rule: { orgId: string; createdById?: string | null; metadata?: Prisma.JsonValue | null }) {
    const metadata = this.toMetadata(rule.metadata);
    const recipients = new Set<string>();
    const configuredUsers = this.toStringArray(metadata?.notifyUserIds);
    if (configuredUsers.length) {
      configuredUsers.forEach((userId) => recipients.add(userId));
    }
    const notifyAll = metadata?.notifyAllMembers === true || metadata?.notifyAllUsers === true;
    if (notifyAll) {
      const members = await this.prisma.membership.findMany({
        where: {
          orgId: rule.orgId,
          user: { isActive: true }
        },
        select: { userId: true }
      });
      members.forEach((member) => recipients.add(member.userId));
    }
    if (!recipients.size && rule.createdById) {
      recipients.add(rule.createdById);
    }
    return Array.from(recipients);
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  private toMetadata(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private resolveMetricProvider(rule: { metricProvider: AlertMetricProvider }) {
    return this.metricProviders.find((provider) => provider.supports(rule));
  }

  private normalizeAlertContext(context?: Record<string, unknown> | null): Record<string, unknown> | undefined {
    if (!context) {
      return context ?? undefined;
    }

    const normalizedContext = { ...context };
    const rawCountry = typeof normalizedContext.country === "string" ? normalizedContext.country : null;
    const rawCountryCode = typeof normalizedContext.countryCode === "string" ? normalizedContext.countryCode : null;
    const countryValue = rawCountryCode ?? rawCountry;
    const normalizedCountry = normalizeCountryCode(countryValue);

    if (normalizedCountry) {
      normalizedContext.countryCode = normalizedCountry;
      if (!normalizedContext.countryName) {
        const rawCountryLooksLikeCode = rawCountry ? /^[A-Za-z]{2,3}$/.test(rawCountry.trim()) : false;
        if (rawCountry && rawCountry !== normalizedCountry && !rawCountryLooksLikeCode) {
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
    changePercent?: number | null
  ): false | { message?: string; context?: Record<string, unknown> } {
    const thresholdValue = rule.thresholdValue !== null ? Number(rule.thresholdValue) : undefined;
    const lower = rule.thresholdLower !== null ? Number(rule.thresholdLower) : undefined;
    const upper = rule.thresholdUpper !== null ? Number(rule.thresholdUpper) : undefined;
    switch (rule.operator) {
      case "gt":
        return thresholdValue !== undefined && latest > thresholdValue
          ? { message: `Value ${latest} is greater than ${thresholdValue}`, context: { latest, threshold: thresholdValue } }
          : false;
      case "gte":
        return thresholdValue !== undefined && latest >= thresholdValue
          ? { message: `Value ${latest} is >= ${thresholdValue}`, context: { latest, threshold: thresholdValue } }
          : false;
      case "lt":
        return thresholdValue !== undefined && latest < thresholdValue
          ? { message: `Value ${latest} is below ${thresholdValue}`, context: { latest, threshold: thresholdValue } }
          : false;
      case "lte":
        return thresholdValue !== undefined && latest <= thresholdValue
          ? { message: `Value ${latest} is <= ${thresholdValue}`, context: { latest, threshold: thresholdValue } }
          : false;
      case "eq":
        return thresholdValue !== undefined && latest === thresholdValue
          ? { message: `Value ${latest} equals ${thresholdValue}`, context: { latest, threshold: thresholdValue } }
          : false;
      case "outside_range":
        if (lower === undefined || upper === undefined) {
          return false;
        }
        return latest < lower || latest > upper
          ? { message: `Value ${latest} is outside ${lower}-${upper}`, context: { latest, lower, upper } }
          : false;
      case "within_range":
        if (lower === undefined || upper === undefined) {
          return false;
        }
        return latest >= lower && latest <= upper
          ? { message: `Value ${latest} is within ${lower}-${upper}`, context: { latest, lower, upper } }
          : false;
      case "change_up_pct":
        return typeof changePercent === "number" && thresholdValue !== undefined && changePercent >= thresholdValue
          ? { message: `Change ${changePercent.toFixed(2)}% >= ${thresholdValue}%`, context: { changePercent } }
          : false;
      case "change_down_pct":
        return typeof changePercent === "number" && thresholdValue !== undefined && changePercent <= -1 * thresholdValue
          ? { message: `Change ${changePercent.toFixed(2)}% <= -${thresholdValue}%`, context: { changePercent } }
          : false;
      default:
        return false;
    }
  }

  private async enqueueNotificationJobs(deliveries: { id: string }[]) {
    if (deliveries.length === 0) {
      return;
    }
    const attempts = NOTIFICATION_BACKOFF_DELAYS_MS.length + 1;
    const traceId = ensureTraceId(getCurrentTraceId());
    await Promise.all(
      deliveries.map((delivery) =>
        this.queue.add(
          this.buildDeliveryJobName(delivery.id),
          { type: "deliver", deliveryId: delivery.id, traceId },
          {
            jobId: `deliver:${delivery.id}`,
            attempts,
            backoff: { type: "alertNotifications" },
            removeOnComplete: true,
            removeOnFail: false
          }
        )
      )
    );
  }

  async handleDeliveryJob(job: Job<AlertJobPayload>, token?: string) {
    if (job.data.type !== "deliver" || !job.data.deliveryId) {
      return;
    }
    const delivery = await this.prisma.alertDelivery.findUnique({
      where: { id: job.data.deliveryId },
      include: { event: { include: { rule: true } } }
    });
    if (!delivery || !delivery.event || !delivery.event.rule) {
      return;
    }
    const channel = delivery.targetSnapshot as
      | { id?: string; type?: AlertChannelType; target?: string; name?: string; config?: unknown }
      | null;
    if (!channel?.type || !channel?.target) {
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: { status: AlertDeliveryStatus.failed, error: "Invalid channel snapshot" }
      });
      await this.reconcileEventStatus(delivery.eventId);
      return;
    }
    if (delivery.status !== AlertDeliveryStatus.pending) {
      await this.reconcileEventStatus(delivery.eventId);
      return;
    }

    const ruleMuteUntilMs = this.extractMuteUntilMs(delivery.event.rule.metadata);
    const channelMuteUntilMs = this.extractMuteUntilMs(channel.config);
    const muteUntilMs = Math.max(ruleMuteUntilMs ?? 0, channelMuteUntilMs ?? 0) || null;
    if (this.notificationThrottle.isMutedNow(muteUntilMs)) {
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: {
          status: AlertDeliveryStatus.sent,
          sentAt: new Date(),
          error: `suppressed: muted until ${new Date(muteUntilMs!).toISOString()}`
        }
      });
      await this.reconcileEventStatus(delivery.eventId);
      return;
    }

    const minIntervalSeconds = this.extractNotifyIntervalSeconds(channel.config);
    if (channel.type !== AlertChannelType.email && channel.type !== AlertChannelType.webhook) {
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: { status: AlertDeliveryStatus.failed, error: `Unsupported channel type ${channel.type}` }
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
        const scheduledAtMs = await this.notificationThrottle.reserveNotificationScheduleMs({
          channelType,
          channelId: delivery.channelId ?? channel.id ?? null,
          minIntervalSeconds
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
        await this.sendEmail(channel.target, delivery.event, delivery.event.rule);
      } else if (channel.type === "webhook") {
        await this.sendWebhook(channel.target, delivery.event, delivery.event.rule);
      } else {
        throw new Error(`Unsupported channel type ${channel.type}`);
      }
      await this.prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: { status: AlertDeliveryStatus.sent, sentAt: new Date() }
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
          status: isLastAttempt ? AlertDeliveryStatus.failed : AlertDeliveryStatus.pending,
          error: message
        }
      });
      logger.error(
        { delivery: delivery.id, channel: channel.name ?? channel.target, attempt: job.attemptsMade, error },
        "Alert delivery attempt failed"
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
    const index = Math.min(Math.max(attemptsMade - 1, 0), NOTIFICATION_BACKOFF_DELAYS_MS.length - 1);
    return NOTIFICATION_BACKOFF_DELAYS_MS[index] ?? 60_000;
  }

  private async reconcileEventStatus(eventId: string) {
    const current = await this.prisma.alertEvent.findUnique({
      where: { id: eventId },
      select: { status: true }
    });
    if (
      !current ||
      current.status === AlertEventStatus.confirmed ||
      current.status === AlertEventStatus.ignored
    ) {
      return;
    }
    const deliveries = await this.prisma.alertDelivery.findMany({ where: { eventId } });
    if (!deliveries.length) {
      return;
    }
    const hasPending = deliveries.some((delivery) => delivery.status === AlertDeliveryStatus.pending);
    if (hasPending) {
      return;
    }
    const anySent = deliveries.some((delivery) => delivery.status === AlertDeliveryStatus.sent);
    await this.prisma.alertEvent.update({
      where: { id: eventId },
      data: { status: anySent ? AlertEventStatus.delivered : AlertEventStatus.failed }
    });
  }

  private async sendEmail(
    target: string,
    event: { metricValue: Prisma.Decimal; triggeredAt: Date; ruleId: string; message?: string | null; changePercent?: number | null },
    rule: { name: string; metricSlug: string; operator?: AlertOperator; thresholdValue?: Prisma.Decimal | null; thresholdLower?: Prisma.Decimal | null; thresholdUpper?: Prisma.Decimal | null }
  ) {
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
      metric: rule.metricSlug,
      value: Number(event.metricValue),
      threshold,
      triggeredAt: event.triggeredAt.toISOString(),
      message: event.message ?? undefined,
      changePercent: event.changePercent ?? null
    });
    const text = this.email.buildAlertTextTemplate({
      ruleName: rule.name,
      metric: rule.metricSlug,
      value: Number(event.metricValue),
      threshold,
      triggeredAt: event.triggeredAt.toISOString(),
      message: event.message ?? undefined,
      changePercent: event.changePercent ?? null
    });
    await this.email.send({
      to: target,
      subject: `[Alert] ${rule.name} triggered`,
      html,
      text
    });
  }

  private async sendWebhook(
    target: string,
    event: { id: string; triggeredAt: Date; metricValue: Prisma.Decimal; severity: AlertSeverity; ruleId: string; message?: string | null },
    rule: {
      name: string;
      metricSlug: string;
      operator?: AlertOperator;
      thresholdValue?: Prisma.Decimal | null;
      thresholdLower?: Prisma.Decimal | null;
      thresholdUpper?: Prisma.Decimal | null;
    }
  ) {
    const payload = {
      alertId: event.id,
      ruleName: rule.name,
      metric: rule.metricSlug,
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
      message: event.message
    };
    await firstValueFrom(this.http.post(target, payload, { timeout: this.env.alertingConfig.webhookTimeoutMs }));
  }

  async scheduleScanJob() {
    await this.queue.add(
      "scan-active-rules",
      { type: "scan" },
      {
        jobId: "scan-active-rules",
        repeat: { every: this.env.alertingConfig.scanIntervalMs },
        removeOnComplete: true
      }
    );
  }

  private async ensureRuleSchedule(rule: { id: string; checkIntervalSec: number; status: AlertStatus }) {
    await this.removeJob(rule.id, false);
    if (rule.status !== AlertStatus.active) {
      return;
    }
    const every = Math.max(60, rule.checkIntervalSec) * 1000;
    await this.queue.add(
      this.buildRuleJobName(rule.id),
      { type: "evaluate", ruleId: rule.id },
      {
        jobId: `evaluate:${rule.id}`,
        repeat: { every },
        removeOnComplete: true,
        removeOnFail: false
      }
    );
  }

  private buildRuleJobName(ruleId: string) {
    return `evaluate-rule:${ruleId}`;
  }

  private buildDeliveryJobName(deliveryId: string) {
    return `deliver-notification:${deliveryId}`;
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
    await this.queue.remove(`evaluate:${ruleId}`);
    await this.queue.remove(this.buildRuleJobName(ruleId));
  }
}
