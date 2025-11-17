import { HttpService } from "@nestjs/axios";
import { Inject, Injectable } from "@nestjs/common";
import {
  AlertChannelType,
  AlertDeliveryStatus,
  AlertEventStatus,
  AlertOperator,
  AlertSeverity,
  AlertStatus,
  Prisma
} from "@prisma/client";
import { Queue } from "bullmq";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";
import { ALERTS_QUEUE } from "./alerts.constants";
import { EnvService } from "../config/config.service";
import { firstValueFrom } from "rxjs";
import { createLogger } from "@modular/utils";

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
  | { type: "scan" }
  | {
      type: "evaluate";
      ruleId: string;
    };

const logger = createLogger({ name: "alerts" });

@Injectable()
export class AlertsService {
  private readonly prisma: PrismaService;
  private readonly email: EmailService;
  private readonly http: HttpService;

  constructor(
    prisma: PrismaService,
    email: EmailService,
    http: HttpService,
    private readonly env: EnvService,
    @Inject(ALERTS_QUEUE) private readonly queue: Queue<AlertJobPayload>
  ) {
    this.prisma = prisma;
    this.email = email;
    this.http = http;
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
    const dataItem = await this.prisma.economicDataItem.findUnique({
      where: { slug: input.metricSlug }
    });
    const baseData: Prisma.AlertRuleUncheckedCreateInput = {
      orgId,
      name: input.name,
      description: input.description,
      severity: input.severity ?? AlertSeverity.medium,
      status: input.status ?? AlertStatus.active,
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
      dataItemId: dataItem?.id ?? null
    };

    const rule = await this.prisma.$transaction(async (tx) => {
      let currentRule;
      if (input.id) {
        const existing = await tx.alertRule.findUnique({ where: { id: input.id } });
        if (!existing || existing.orgId !== orgId) {
          throw new Error("Alert rule not found for this org");
        }
        currentRule = await tx.alertRule.update({
          where: { id: input.id },
          data: {
            name: baseData.name,
            description: baseData.description,
            severity: baseData.severity,
            status: baseData.status,
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
    await this.queue.add(
      this.buildRuleJobName(ruleId),
      { type: "evaluate", ruleId },
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

    const { latest, previous, changePercent } = await this.fetchLatestValues(rule.metricSlug, rule.operator, rule.changeWindowMin);
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
        context: triggered.context ?? {}
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

    await this.dispatchNotifications(event.id, rule, activeChannels);

    return { event, deliveries };
  }

  private async fetchLatestValues(metricSlug: string, operator: AlertOperator, changeWindowMin?: number) {
    const take = operator === "change_up_pct" || operator === "change_down_pct" ? 2 : 1;
    const where: Prisma.EconomicDataPointWhereInput = {
      item: { slug: metricSlug }
    };
    if (changeWindowMin) {
      const windowStart = new Date(Date.now() - changeWindowMin * 60 * 1000);
      where.recordedAt = { gte: windowStart };
    }
    const points = await this.prisma.economicDataPoint.findMany({
      where,
      orderBy: { recordedAt: "desc" },
      take
    });
    if (!points.length) {
      return { latest: null, previous: null, changePercent: null };
    }
    const latest = Number(points[0].value);
    const previous = points.length > 1 ? Number(points[1].value) : null;
    const changePercent = previous ? ((latest - previous) / previous) * 100 : null;
    return { latest, previous, changePercent };
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

  private async dispatchNotifications(
    eventId: string,
    rule: {
      name: string;
      metricSlug: string;
      severity: AlertSeverity;
      operator?: AlertOperator;
      thresholdValue?: Prisma.Decimal | null;
      thresholdLower?: Prisma.Decimal | null;
      thresholdUpper?: Prisma.Decimal | null;
    },
    channels: { id: string; type: AlertChannelType; target: string; name: string }[]
  ) {
    const event = await this.prisma.alertEvent.findUnique({
      where: { id: eventId },
      include: { rule: true, deliveries: true }
    });
    if (!event) {
      return;
    }
    for (const delivery of event.deliveries) {
      const channel = channels.find((c) => c.id === delivery.channelId);
      if (!channel) {
        continue;
      }
      try {
        if (channel.type === "email") {
          await this.sendEmail(channel.target, event, rule);
        } else if (channel.type === "webhook") {
          await this.sendWebhook(channel.target, event, rule);
        }
        await this.prisma.alertDelivery.update({
          where: { id: delivery.id },
          data: { status: AlertDeliveryStatus.sent, sentAt: new Date() }
        });
      } catch (error) {
        const message = (error as Error)?.message ?? "unknown error";
        logger.error({ delivery: delivery.id, channel: channel.name, error }, "Alert delivery failed");
        await this.prisma.alertDelivery.update({
          where: { id: delivery.id },
          data: { status: AlertDeliveryStatus.failed, error: message }
        });
      }
    }
    await this.prisma.alertEvent.update({
      where: { id: eventId },
      data: { status: AlertEventStatus.delivered }
    });
  }

  private async sendEmail(
    target: string,
    event: { metricValue: Prisma.Decimal; triggeredAt: Date; ruleId: string; message?: string },
    rule: { name: string; metricSlug: string; operator?: AlertOperator; thresholdValue?: Prisma.Decimal | null; thresholdLower?: Prisma.Decimal | null; thresholdUpper?: Prisma.Decimal | null }
  ) {
    await this.email.send({
      to: target,
      subject: `[Alert] ${rule.name} triggered`,
      text: `Rule ${rule.name} for ${rule.metricSlug} triggered at ${event.triggeredAt.toISOString()} with value ${event.metricValue.toString()}.
Operator: ${rule.operator ?? "n/a"}
Threshold: ${rule.thresholdValue ?? rule.thresholdLower ?? rule.thresholdUpper ?? "n/a"}
${event.message ?? ""}`
    });
  }

  private async sendWebhook(
    target: string,
    event: { id: string; triggeredAt: Date; metricValue: Prisma.Decimal; severity: AlertSeverity; ruleId: string; message?: string },
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
    const delays = [60_000, 5 * 60_000, 15 * 60_000];
    let lastError: unknown;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        await firstValueFrom(this.http.post(target, payload, { timeout: this.env.alertingConfig.webhookTimeoutMs }));
        return;
      } catch (error) {
        lastError = error;
        if (attempt === delays.length - 1) {
          break;
        }
        await this.delay(delays[attempt]);
      }
    }
    throw lastError ?? new Error("Webhook delivery failed");
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

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
