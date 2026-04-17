import { NotificationPresentationKind, createLogger } from "@modular/utils";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  NotificationType,
  UserDigestDeliveryStatus,
} from "@prisma/client";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { EmailService } from "../email/email.service";
import { NotificationsService } from "../notifications/notifications.service";

import {
  DEFAULT_USER_DIGEST_DELIVERY_TIME,
  DEFAULT_USER_DIGEST_DELIVERY_TIMEZONE,
} from "./user-digest.constants";
import {
  UserDigestEventV1,
  UserDigestService,
  type UserDigestV1,
} from "./user-digest.service";

dayjs.extend(utc);
dayjs.extend(timezone);

const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

interface DeliveryUserContext {
  email: string;
  emailVerified: Date | null;
  firstName: string;
}

interface DeliveryScheduleConfig {
  timezone: string;
  sendHour: number;
  sendMinute: number;
}

export interface UserDigestDeliverySettingsV1 {
  version: 1;
  enabled: boolean;
  time: string;
  timezone: string;
  targetEmail: string;
  emailVerified: boolean;
  nextRunAt: string | null;
  lastSentAt: string | null;
  lastStatus: UserDigestDeliveryStatus;
  lastStatusAt: string | null;
  lastError: string | null;
}

export interface UserDigestDeliveryOrgRunSummary {
  dueCount: number;
  sentCount: number;
  emptyCount: number;
  failedCount: number;
}

interface DueScheduleRecord {
  id: string;
  orgId: string;
  userId: string;
  timezone: string;
  sendHour: number;
  sendMinute: number;
  nextRunAt: Date | null;
  user: DeliveryUserContext;
}

@Injectable()
export class UserDigestDeliveryService {
  private readonly logger = createLogger({ name: "user-digest-delivery" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly digestService: UserDigestService,
    private readonly emailService: EmailService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getDelivery(
    orgId: string,
    userId: string,
  ): Promise<UserDigestDeliverySettingsV1> {
    const user = await this.getUserContextOrThrow(orgId, userId);
    const schedule = await this.prisma.userDigestDeliverySchedule.findUnique({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
    });

    return this.toSettings(schedule, user);
  }

  async updateDelivery(
    orgId: string,
    userId: string,
    input: {
      enabled: boolean;
      time: string;
      timezone: string;
    },
  ): Promise<UserDigestDeliverySettingsV1> {
    const user = await this.getUserContextOrThrow(orgId, userId);
    const normalized = this.normalizeScheduleInput(input);
    if (normalized.enabled && !user.emailVerified) {
      throw new BadRequestException(
        "Verified email is required before enabling digest delivery",
      );
    }

    const nextRunAt = normalized.enabled
      ? this.computeNextRunAt(normalized, new Date())
      : null;

    const schedule = await this.prisma.userDigestDeliverySchedule.upsert({
      where: {
        orgId_userId: {
          orgId,
          userId,
        },
      },
      update: {
        enabled: normalized.enabled,
        timezone: normalized.timezone,
        sendHour: normalized.sendHour,
        sendMinute: normalized.sendMinute,
        nextRunAt,
        ...(normalized.enabled ? {} : { lastError: null }),
      },
      create: {
        orgId,
        userId,
        enabled: normalized.enabled,
        timezone: normalized.timezone,
        sendHour: normalized.sendHour,
        sendMinute: normalized.sendMinute,
        nextRunAt,
      },
    });

    return this.toSettings(schedule, user);
  }

  async runDueDeliveriesForOrg(
    orgId: string,
    now = new Date(),
  ): Promise<UserDigestDeliveryOrgRunSummary> {
    const schedules =
      await this.prisma.userDigestDeliverySchedule.findMany({
        where: {
          orgId,
          enabled: true,
          nextRunAt: { lte: now },
          user: {
            isActive: true,
            memberships: {
              some: {
                orgId,
                isActive: true,
                org: { isActive: true },
              },
            },
          },
        },
        orderBy: [{ nextRunAt: "asc" }, { updatedAt: "asc" }],
        select: {
          id: true,
          orgId: true,
          userId: true,
          timezone: true,
          sendHour: true,
          sendMinute: true,
          nextRunAt: true,
          user: {
            select: {
              id: true,
              email: true,
              emailVerified: true,
              isActive: true,
              firstName: true,
            },
          },
        },
      });

    const summary: UserDigestDeliveryOrgRunSummary = {
      dueCount: schedules.length,
      sentCount: 0,
      emptyCount: 0,
      failedCount: 0,
    };

    for (const schedule of schedules) {
      const status = await this.processDueSchedule(schedule, now);
      if (status === UserDigestDeliveryStatus.sent) {
        summary.sentCount += 1;
      } else if (status === UserDigestDeliveryStatus.empty_notified) {
        summary.emptyCount += 1;
      } else if (status === UserDigestDeliveryStatus.failed) {
        summary.failedCount += 1;
      }
    }

    return summary;
  }

  private async processDueSchedule(
    schedule: DueScheduleRecord,
    now: Date,
  ): Promise<UserDigestDeliveryStatus> {
    const config: DeliveryScheduleConfig = {
      timezone: schedule.timezone,
      sendHour: schedule.sendHour,
      sendMinute: schedule.sendMinute,
    };
    const nextRunAt = this.computeNextRunAt(config, now);

    if (!schedule.user.emailVerified) {
      await this.prisma.userDigestDeliverySchedule.update({
        where: { id: schedule.id },
        data: {
          enabled: false,
          nextRunAt: null,
          lastStatus: UserDigestDeliveryStatus.failed,
          lastStatusAt: now,
          lastError: "Email is no longer verified for this user",
        },
      });
      await this.safeNotifyFailure(schedule.orgId, schedule.userId, {
        link: "/today",
        targetEmail: schedule.user.email,
        message: "邮箱未验证，已自动停用摘要邮件投递。",
      });
      return UserDigestDeliveryStatus.failed;
    }

    const digest = await this.digestService.generateDigest(
      schedule.orgId,
      schedule.userId,
    );

    if (digest.events.length === 0) {
      await this.prisma.userDigestDeliverySchedule.update({
        where: { id: schedule.id },
        data: {
          nextRunAt,
          lastStatus: UserDigestDeliveryStatus.empty_notified,
          lastStatusAt: now,
          lastError: null,
        },
      });
      await this.safeNotifyEmpty(schedule.orgId, schedule.userId, {
        link: "/today",
        nextRunAt: nextRunAt.toISOString(),
      });
      return UserDigestDeliveryStatus.empty_notified;
    }

    try {
      const emailPayload = this.buildEmailPayload(digest, config, {
        firstName: schedule.user.firstName,
        email: schedule.user.email,
      });
      await this.emailService.send({
        to: schedule.user.email,
        subject: emailPayload.subject,
        html: emailPayload.html,
        text: emailPayload.text,
      });

      await this.prisma.userDigestDeliverySchedule.update({
        where: { id: schedule.id },
        data: {
          nextRunAt,
          lastSentAt: now,
          lastStatus: UserDigestDeliveryStatus.sent,
          lastStatusAt: now,
          lastError: null,
        },
      });

      await this.safeNotifyReady(schedule.orgId, schedule.userId, {
        link: "/today",
        eventCount: digest.events.length,
        generatedAt: digest.generatedAt,
        nextRunAt: nextRunAt.toISOString(),
      });

      return UserDigestDeliveryStatus.sent;
    } catch (error) {
      const errorMessage = this.toErrorMessage(error);
      this.logger.warn(
        {
          error,
          orgId: schedule.orgId,
          userId: schedule.userId,
          targetEmail: schedule.user.email,
        },
        "Failed to deliver user digest email",
      );
      await this.prisma.userDigestDeliverySchedule.update({
        where: { id: schedule.id },
        data: {
          nextRunAt,
          lastStatus: UserDigestDeliveryStatus.failed,
          lastStatusAt: now,
          lastError: errorMessage,
        },
      });
      await this.safeNotifyFailure(schedule.orgId, schedule.userId, {
        link: "/today",
        targetEmail: schedule.user.email,
        message: errorMessage,
      });
      return UserDigestDeliveryStatus.failed;
    }
  }

  private async safeNotifyReady(
    orgId: string,
    userId: string,
    params: {
      link: string;
      eventCount: number;
      generatedAt: string;
      nextRunAt: string;
    },
  ) {
    await this.safeNotify(orgId, userId, {
      title: "每日摘要已送达",
      body: `本次已发送 ${params.eventCount} 条摘要事件。`,
      data: {
        link: params.link,
        presentation: {
          kind: NotificationPresentationKind.UserDigestReady,
          params,
        },
      },
    });
  }

  private async safeNotifyEmpty(
    orgId: string,
    userId: string,
    params: { link: string; nextRunAt: string },
  ) {
    await this.safeNotify(orgId, userId, {
      title: "今日摘要暂无新内容",
      body: "当前窗口内没有新的摘要事件，系统将在下一个日程点继续检查。",
      data: {
        link: params.link,
        presentation: {
          kind: NotificationPresentationKind.UserDigestEmpty,
          params,
        },
      },
    });
  }

  private async safeNotifyFailure(
    orgId: string,
    userId: string,
    params: { link: string; targetEmail: string; message: string },
  ) {
    await this.safeNotify(orgId, userId, {
      title: "每日摘要投递失败",
      body: params.message,
      data: {
        link: params.link,
        presentation: {
          kind: NotificationPresentationKind.UserDigestDeliveryFailed,
          params,
          technicalDetail: params.message,
        },
      },
    });
  }

  private async safeNotify(
    orgId: string,
    userId: string,
    input: {
      title: string;
      body: string;
      data: Record<string, unknown>;
    },
  ) {
    try {
      await this.notificationsService.notify({
        orgId,
        userId,
        type: NotificationType.system,
        title: input.title,
        body: input.body,
        data: input.data,
      });
    } catch (error) {
      this.logger.warn(
        { error, orgId, userId, title: input.title },
        "Failed to write user digest notification",
      );
    }
  }

  private buildEmailPayload(
    digest: UserDigestV1,
    config: DeliveryScheduleConfig,
    user: { firstName: string; email: string },
  ) {
    const consoleBaseUrl = this.getConsoleBaseUrl();
    const digestLink = `${consoleBaseUrl}/today`;
    const subjectDate = this.formatDate(digest.generatedAt, config.timezone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const events = digest.events.map((event) =>
      this.toEmailEvent(event, config.timezone, digestLink),
    );
    const html = this.emailService.buildUserDigestTemplate({
      recipientName: user.firstName,
      generatedAtLabel: this.formatDate(digest.generatedAt, config.timezone, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      windowLabel: `${digest.preference.windowDays} 天`,
      eventCount: digest.events.length,
      digestLink,
      events,
    });
    const text = this.emailService.buildUserDigestTextTemplate({
      recipientName: user.firstName,
      generatedAtLabel: this.formatDate(digest.generatedAt, config.timezone, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      windowLabel: `${digest.preference.windowDays} 天`,
      eventCount: digest.events.length,
      digestLink,
      events,
    });

    return {
      subject: `每日摘要｜${subjectDate}`,
      html,
      text,
    };
  }

  private toEmailEvent(
    event: UserDigestEventV1,
    timezoneId: string,
    fallbackLink: string,
  ) {
    const title =
      event.title?.trim() ||
      event.primaryEntity?.trim() ||
      event.primaryTopic?.trim() ||
      event.eventId;
    return {
      title,
      summary: event.summary?.trim() || "暂无摘要。",
      itemCount: event.itemCount,
      updatedAtLabel: this.formatDate(event.lastAt, timezoneId, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      link: this.toSafeHttpUrl(event.representativeUrl) ?? fallbackLink,
    };
  }

  private toSettings(
    schedule:
      | {
          enabled: boolean;
          timezone: string;
          sendHour: number;
          sendMinute: number;
          nextRunAt: Date | null;
          lastSentAt: Date | null;
          lastStatus: UserDigestDeliveryStatus;
          lastStatusAt: Date | null;
          lastError: string | null;
        }
      | null,
    user: DeliveryUserContext,
  ): UserDigestDeliverySettingsV1 {
    const config = schedule ?? {
      enabled: false,
      timezone: DEFAULT_USER_DIGEST_DELIVERY_TIMEZONE,
      sendHour: Number.parseInt(
        DEFAULT_USER_DIGEST_DELIVERY_TIME.split(":")[0] ?? "9",
        10,
      ),
      sendMinute: Number.parseInt(
        DEFAULT_USER_DIGEST_DELIVERY_TIME.split(":")[1] ?? "0",
        10,
      ),
      nextRunAt: null,
      lastSentAt: null,
      lastStatus: UserDigestDeliveryStatus.idle,
      lastStatusAt: null,
      lastError: null,
    };

    return {
      version: 1,
      enabled: config.enabled,
      time: this.formatTime(config.sendHour, config.sendMinute),
      timezone: config.timezone,
      targetEmail: user.email,
      emailVerified: Boolean(user.emailVerified),
      nextRunAt: config.nextRunAt?.toISOString() ?? null,
      lastSentAt: config.lastSentAt?.toISOString() ?? null,
      lastStatus: config.lastStatus,
      lastStatusAt: config.lastStatusAt?.toISOString() ?? null,
      lastError: config.lastError,
    };
  }

  private normalizeScheduleInput(input: {
    enabled: boolean;
    time: string;
    timezone: string;
  }): DeliveryScheduleConfig & { enabled: boolean } {
    const timezoneId = input.timezone.trim();
    if (!this.isValidTimezone(timezoneId)) {
      throw new BadRequestException("timezone must be a valid IANA timezone");
    }

    const match = input.time.trim().match(TIME_PATTERN);
    if (!match) {
      throw new BadRequestException("time must use HH:mm format");
    }

    const sendHour = Number.parseInt(match[1] ?? "", 10);
    const sendMinute = Number.parseInt(match[2] ?? "", 10);
    if (
      !Number.isInteger(sendHour) ||
      !Number.isInteger(sendMinute) ||
      sendHour < 0 ||
      sendHour > 23 ||
      sendMinute < 0 ||
      sendMinute > 59
    ) {
      throw new BadRequestException("time must be a valid 24-hour clock value");
    }

    return {
      enabled: input.enabled,
      timezone: timezoneId,
      sendHour,
      sendMinute,
    };
  }

  private computeNextRunAt(
    config: DeliveryScheduleConfig,
    reference: Date,
  ): Date {
    const zonedReference = dayjs(reference).tz(config.timezone);
    let next = zonedReference
      .hour(config.sendHour)
      .minute(config.sendMinute)
      .second(0)
      .millisecond(0);

    if (!next.isAfter(zonedReference)) {
      next = next.add(1, "day");
    }

    return next.utc().toDate();
  }

  private async getUserContextOrThrow(
    orgId: string,
    userId: string,
  ): Promise<DeliveryUserContext> {
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_orgId: {
          userId,
          orgId,
        },
      },
      select: {
        isActive: true,
        user: {
          select: {
            id: true,
            email: true,
            emailVerified: true,
            isActive: true,
            firstName: true,
          },
        },
      },
    });

    if (!membership?.user) {
      throw new NotFoundException("Digest delivery user not found");
    }
    if (!membership.isActive || !membership.user.isActive) {
      throw new BadRequestException("Digest delivery is unavailable for inactive users");
    }

    return {
      email: membership.user.email,
      emailVerified: membership.user.emailVerified,
      firstName: membership.user.firstName,
    };
  }

  private formatTime(hour: number, minute: number) {
    return `${hour.toString().padStart(2, "0")}:${minute
      .toString()
      .padStart(2, "0")}`;
  }

  private isValidTimezone(timezoneId: string) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezoneId }).format(
        new Date(),
      );
      return true;
    } catch {
      return false;
    }
  }

  private formatDate(
    value: string,
    timezoneId: string,
    options: Intl.DateTimeFormatOptions,
  ) {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezoneId,
        ...options,
      }).format(new Date(value));
    } catch {
      return value;
    }
  }

  private getConsoleBaseUrl() {
    const raw =
      this.env.get<string>("NEXTAUTH_URL", { infer: true }) ||
      process.env.NEXTAUTH_URL ||
      "http://localhost:3000";
    return raw.trim().replace(/\/+$/, "");
  }

  private toSafeHttpUrl(value: string | null) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed.toString()
        : null;
    } catch {
      return null;
    }
  }

  private toErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim().slice(0, 191);
    }
    return "Digest email delivery failed";
  }
}
