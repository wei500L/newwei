import { createLogger } from "@modular/utils";
import { Body, Controller, Delete, Get, Post, Put, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Queue } from "bullmq";
import type { Request } from "express";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { resolveRequestIp } from "../../common/request-ip";
import { AkshareService } from "../akshare/akshare.service";
import type { AuthenticatedUser } from "../auth/auth.service";
import { EnvService } from "../config/config.service";
import { toBullmqConnection } from "../config/redis-connection";
import {
  SITUATION_MONITOR_SIGNALS_QUEUE_NAME,
  TELEGRAM_POLL_JOB_NAME,
} from "../situation-monitor/signals/situation-monitor-signals.constants";
import { SituationMonitorSignalsService } from "../situation-monitor/signals/situation-monitor-signals.service";
import {
  removeLegacyTelegramRepeatJobs,
  removeQueuedTelegramPollJobs,
  removeTelegramPollScheduler,
  TelegramSchedulerJobPayload,
  upsertTelegramPollScheduler,
} from "../situation-monitor/signals/situation-monitor-telegram-scheduler";
import { SituationMonitorExternalSnapshotService } from "../situation-monitor/situation-monitor-external-snapshot.service";
import { SituationMonitorService } from "../situation-monitor/situation-monitor.service";

import { UpdateSituationMonitorSettingsDto } from "./dto/situation-monitor-settings.dto";
import {
  CompleteSituationMonitorTelegramAuthDto,
  StartSituationMonitorTelegramAuthDto,
} from "./dto/situation-monitor-telegram-auth.dto";
import { SituationMonitorSettingsService } from "./situation-monitor-settings.service";
import { SituationMonitorTelegramAuthService } from "./situation-monitor-telegram-auth.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/situation-monitor")
@Permissions("settings.manage")
export class SituationMonitorSettingsController {
  private readonly logger = createLogger({ name: "situation-monitor-settings-controller" });

  constructor(
    private readonly settings: SituationMonitorSettingsService,
    private readonly telegramAuth: SituationMonitorTelegramAuthService,
    private readonly env: EnvService,
    private readonly signals: SituationMonitorSignalsService,
    private readonly akshareService: AkshareService,
    private readonly externalSnapshots: SituationMonitorExternalSnapshotService,
    private readonly monitor: SituationMonitorService,
  ) {}

  private async withExternalSnapshotStatus<T extends object>(
    payload: T,
    user: AuthenticatedUser,
  ) {
    const [externalSnapshotStatus, qualitySummary] = await Promise.all([
      this.externalSnapshots.getStatusSummary(),
      this.monitor.getQualitySummary(user.orgId).catch((error) => {
        this.logger.warn(
          { error, orgId: user.orgId },
          "Failed to build Situation Monitor quality summary for settings response",
        );
        return null;
      }),
    ]);
    return {
      ...payload,
      externalSnapshotStatus,
      qualitySummary,
    };
  }

  @Get()
  async getSettings(@CurrentUser() user: AuthenticatedUser) {
    return await this.withExternalSnapshotStatus(
      await this.settings.getPublicSettings(),
      user,
    );
  }

  @Put()
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSituationMonitorSettingsDto
  ) {
    const updated = await this.settings.updateSettings(user.orgId, user.id, body);
    await this.syncTelegramScheduleBestEffort(updated.telegramEnabled, updated.telegramPollIntervalMs);
    await this.syncEconomicDataScheduleBestEffort();
    return await this.withExternalSnapshotStatus(updated, user);
  }

  @Delete()
  async reset(@CurrentUser() user: AuthenticatedUser) {
    const reset = await this.settings.resetToEnv(user.orgId, user.id);
    await this.syncTelegramScheduleBestEffort(reset.telegramEnabled, reset.telegramPollIntervalMs);
    await this.syncEconomicDataScheduleBestEffort();
    if (!reset.hasTelegramSession) {
      await this.signals.clearTelegramState({ clearItems: true });
    }
    return await this.withExternalSnapshotStatus(reset, user);
  }

  @Delete("telegram-auth")
  async clearTelegramAuth(@CurrentUser() user: AuthenticatedUser) {
    const updated = await this.settings.clearTelegramConfiguration(user.orgId, user.id);
    await this.syncTelegramScheduleBestEffort(updated.telegramEnabled, updated.telegramPollIntervalMs);
    await this.signals.clearTelegramState({ clearItems: true });
    return await this.withExternalSnapshotStatus(updated, user);
  }

  @Post("telegram-auth/start")
  async startTelegramAuth(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Body() body: StartSituationMonitorTelegramAuthDto
  ) {
    return this.telegramAuth.startAuth(user.orgId, user.id, body, {
      clientIp: resolveRequestIp(request),
    });
  }

  @Post("telegram-auth/complete")
  async completeTelegramAuth(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CompleteSituationMonitorTelegramAuthDto
  ) {
    const completed = await this.telegramAuth.completeAuth(user.orgId, user.id, body);
    const updated = await this.settings.updateSettings(user.orgId, user.id, {
      telegramApiId: completed.telegramApiId,
      telegramApiHash: completed.telegramApiHash,
      telegramSession: completed.telegramSession,
      telegramEnabled: body.enableTelegram,
    });
    await this.syncTelegramScheduleBestEffort(updated.telegramEnabled, updated.telegramPollIntervalMs);
    return await this.withExternalSnapshotStatus(updated, user);
  }

  @Post("external-snapshot/refresh")
  async forceExternalSnapshotRefresh() {
    return await this.externalSnapshots.forceRefresh();
  }

  private async syncTelegramScheduleBestEffort(
    enabled: boolean,
    intervalMs: number
  ): Promise<void> {
    const queue = new Queue<TelegramSchedulerJobPayload>(
      SITUATION_MONITOR_SIGNALS_QUEUE_NAME,
      {
        connection: toBullmqConnection(this.env.redisConfig),
        defaultJobOptions: {
          removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
        },
      }
    );
    try {
      await removeLegacyTelegramRepeatJobs(queue);
      if (!enabled) {
        await removeTelegramPollScheduler(queue);
        await removeQueuedTelegramPollJobs(queue);
        return;
      }
      await upsertTelegramPollScheduler(queue, intervalMs);
      await queue.add(
        `${TELEGRAM_POLL_JOB_NAME}:bootstrap`,
        { type: "poll", source: "telegram" },
        { removeOnComplete: true, removeOnFail: BULLMQ_FAILED_JOB_RETENTION }
      );
    } catch (error) {
      this.logger.warn(
        { error, enabled, intervalMs },
        "Failed to hot-sync telegram poll scheduler after settings update"
      );
    } finally {
      await queue.close();
    }
  }

  private async syncEconomicDataScheduleBestEffort(): Promise<void> {
    try {
      await this.akshareService.ensureRepeatableJobs();
    } catch (error) {
      this.logger.warn(
        { error },
        "Failed to hot-sync economic data repeatable jobs after settings update"
      );
    }
  }
}
