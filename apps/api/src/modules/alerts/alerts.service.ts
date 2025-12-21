import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
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
  Prisma
} from "@prisma/client";
import { DelayedError, Job, Queue } from "bullmq";
import { PubSubEngine } from "graphql-subscriptions";
import { firstValueFrom } from "rxjs";

import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";

import { AlertsNotificationThrottleService } from "./alerts-notification-throttle.service";
import { ALERTS_QUEUE, ALERT_METRIC_PROVIDERS } from "./alerts.constants";
import { ALERTS_PUBSUB, AlertEventPayload } from "./alerts.pubsub";
import { MetricProvider } from "./providers/metric-provider";

export interface AlertChannelInput {
  id?: string;
  type: AlertChannelType;
  name: string;
  target: string;
  config?: Record<string, unknown>;
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

  constructor(
    prisma: PrismaService,
    email: EmailService,
    http: HttpService,
    notificationThrottle: AlertsNotificationThrottleService,
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
  }

  async listChannels(orgId: string) {
    return this.prisma.alertNotificationChannel.findMany({
      where: { orgId },
      orderBy: { createdAt: "asc" }
    });
  }

  async createChannel(orgId: string, input: AlertChannelInput, createdById?: string) {
    return this.prisma.alertNotificationChannel.create({
      data: {
        orgId,
        name: input.name,
        type: input.type,
        target: input.target,
        config: input.config ?? {},
        isActive: input.isActive ?? true,
        createdById
      }
    });
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

  async listEvents(orgId: string, limit = 50) {
    return this.prisma.alertEvent.findMany({
      where: { rule: { orgId } },
      include: { rule: true, deliveries: { include: { channel: true } } },
      orderBy: { triggeredAt: "desc" },
      take: limit
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
      metadata: input.metadata ?? {},
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

    const event = await this.prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        triggeredAt: new Date(),
        metricValue: new Prisma.Decimal(latest),
        changePercent: changePercent ?? null,
        severity: rule.severity,
        status: AlertEventStatus.pending,
        message: triggered.message,
        context: { ...(providerContext ?? {}), ...(triggered.context ?? {}) }
      }
    });

    await this.prisma.alertRule.update({
      where: { id: rule.id },
      data: { lastTriggeredAt: new Date() }
    });

    const activeChannels = rule.channels
      .map((link) => link.channel)
      .filter((channel): channel is NonNullable<typeof channel> => !!channel && channel.isActive);

    const deliveries = await Promise.all(
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

    await this.enqueueNotificationJobs(event.id, deliveries);
    await this.pubsub.publish("alertEvents", {
      orgId: rule.orgId,
      event: {
        id: event.id,
        ruleId: rule.id,
        triggeredAt: event.triggeredAt.toISOString(),
        message: triggered.message,
        severity: rule.severity,
        metricValue: Number(event.metricValue),
        changePercent: event.changePercent ?? null,
        status: "pending"
      }
    } satisfies AlertEventPayload);

    return { event, deliveries };
  }

  private resolveMetricProvider(rule: { metricProvider: AlertMetricProvider }) {
    return this.metricProviders.find((provider) => provider.supports(rule));
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
        return changePercent !== null && thresholdValue !== undefined && changePercent >= thresholdValue
          ? { message: `Change ${changePercent.toFixed(2)}% >= ${thresholdValue}%`, context: { changePercent } }
          : false;
      case "change_down_pct":
        return changePercent !== null && thresholdValue !== undefined && changePercent <= -1 * thresholdValue
          ? { message: `Change ${changePercent.toFixed(2)}% <= -${thresholdValue}%`, context: { changePercent } }
          : false;
      default:
        return false;
    }
  }

  private async enqueueNotificationJobs(eventId: string, deliveries: { id: string }[]) {
    if (deliveries.length === 0) {
      await this.prisma.alertEvent.update({
        where: { id: eventId },
        data: { status: AlertEventStatus.delivered }
      });
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
      await this.updateEventStatus(delivery.eventId);
      return;
    }
    if (delivery.status !== AlertDeliveryStatus.pending) {
      await this.updateEventStatus(delivery.eventId);
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
      await this.updateEventStatus(delivery.eventId);
      return;
    }

    try {
      const hadScheduledAtMs = !!job.data.scheduledAtMs;
      if (job.data.scheduledAtMs && Date.now() < job.data.scheduledAtMs) {
        await job.moveToDelayed(job.data.scheduledAtMs, token);
        throw new DelayedError();
      }

      if (!job.data.scheduledAtMs) {
        const scheduledAtMs = await this.notificationThrottle.reserveNotificationScheduleMs({
          channelType: channel.type,
          channelId: delivery.channelId ?? channel.id ?? null
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
      await this.updateEventStatus(delivery.eventId);
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

  getNotificationBackoffDelay(attemptsMade: number) {
    const index = Math.min(Math.max(attemptsMade - 1, 0), NOTIFICATION_BACKOFF_DELAYS_MS.length - 1);
    return NOTIFICATION_BACKOFF_DELAYS_MS[index];
  }

  private async updateEventStatus(eventId: string) {
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
      message: event.message,
      changePercent: event.changePercent ?? null
    });
    await this.email.send({
      to: target,
      subject: `[Alert] ${rule.name} triggered`,
      html
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
    await this.queue.removeJobs([`evaluate:${ruleId}`, this.buildRuleJobName(ruleId)]);
  }
}
