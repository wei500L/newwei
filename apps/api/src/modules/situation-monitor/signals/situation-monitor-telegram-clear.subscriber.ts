import { createLogger } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";

import { REDIS_CLIENT } from "../../cache/cache.tokens";

import { SituationMonitorSignalsService } from "./situation-monitor-signals.service";

/**
 * Cross-instance Telegram clear broadcast (T1).
 *
 * `clearTelegramState` disconnects the local GramJS client, empties the
 * process-local channels/cursor/items and deletes the shared Redis state cache.
 * Before this channel existed, only the NestJS instance that handled the HTTP
 * request performed that work: in a multi-instance deployment the other
 * instances kept their old client and in-memory items and could write them back
 * to Redis afterwards. Once the request is served by api-go, no NestJS instance
 * runs the local half at all.
 *
 * Every NestJS instance subscribes and runs `clearTelegramState` on receipt.
 * The controller performs its own local clear first and then publishes, so the
 * instance that handled the request runs the idempotent clear twice; api-go
 * publishes the same message without a local NestJS clear.
 */
export const SITUATION_MONITOR_TELEGRAM_CLEAR_CHANNEL =
  "situation-monitor:telegram-clear:v1";

const TELEGRAM_CLEAR_VERSION = 1;

export interface SituationMonitorTelegramClearMessage {
  version: number;
  clearItems: boolean;
}

@Injectable()
export class SituationMonitorTelegramClearSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: "situation-monitor-telegram-clear",
  });
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly signals: SituationMonitorSignalsService,
  ) {}

  async onModuleInit() {
    const subscriber = this.redis.duplicate();
    subscriber.on("error", (error) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Situation monitor Telegram clear subscriber redis error",
      );
    });
    subscriber.on("message", (channel, message) => {
      if (channel !== SITUATION_MONITOR_TELEGRAM_CLEAR_CHANNEL) {
        return;
      }
      void this.handleMessage(message).catch((error) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to handle situation monitor Telegram clear message",
        );
      });
    });
    this.subscriber = subscriber;

    try {
      await subscriber.subscribe(SITUATION_MONITOR_TELEGRAM_CLEAR_CHANNEL);
      this.logger.info(
        { channel: SITUATION_MONITOR_TELEGRAM_CLEAR_CHANNEL },
        "Situation monitor Telegram clear subscriber connected",
      );
    } catch (error) {
      this.subscriber = undefined;
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to subscribe situation monitor Telegram clear channel",
      );
      await subscriber.quit().catch(() => subscriber.disconnect());
    }
  }

  async onModuleDestroy() {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (!subscriber) {
      return;
    }
    try {
      await subscriber.unsubscribe(SITUATION_MONITOR_TELEGRAM_CLEAR_CHANNEL);
    } catch {
      // best-effort unsubscribe
    }
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  }

  /**
   * Publishes the broadcast so every instance (including this one) clears its
   * Telegram client and in-memory state. The shared REDIS_CLIENT is only used
   * for PUBLISH; the subscription owns a duplicate connection.
   */
  async publish(clearItems = true): Promise<void> {
    await this.redis.publish(
      SITUATION_MONITOR_TELEGRAM_CLEAR_CHANNEL,
      JSON.stringify({
        version: TELEGRAM_CLEAR_VERSION,
        clearItems,
      } satisfies SituationMonitorTelegramClearMessage),
    );
  }

  private async handleMessage(raw: string) {
    const message = this.parseMessage(raw);
    if (!message) {
      return;
    }
    await this.signals.clearTelegramState({ clearItems: message.clearItems });
  }

  private parseMessage(raw: string): SituationMonitorTelegramClearMessage | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== TELEGRAM_CLEAR_VERSION) {
      return null;
    }
    if (typeof record.clearItems !== "boolean") {
      return null;
    }
    return {
      version: TELEGRAM_CLEAR_VERSION,
      clearItems: record.clearItems,
    };
  }
}
