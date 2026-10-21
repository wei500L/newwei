import { createLogger } from "@modular/utils";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";

import { REDIS_CLIENT } from "../../cache/cache.tokens";
import { EnvService } from "../../config/config.service";

import { SituationMonitorSignalsGateway } from "./situation-monitor-signals.gateway";
import type {
  SituationMonitorRealtimeEvent,
  SituationMonitorRealtimeEventType,
  SituationOrefRealtimePayload,
  SituationTelegramRealtimePayload,
} from "./situation-monitor-signals.types";

/**
 * Redis event bridge consumed from the api-go situation-signals worker.
 *
 * When `API_GO_SITUATION_SIGNALS_WORKER_MODE=go`, api-go owns the
 * `situationMonitorSignals` queue (Telegram polling + Oref polling) and
 * publishes one message per update on this channel:
 *
 *   {"version":1,"type":"situation:telegram.update"|"situation:oref.update",
 *    "payload":<original NestJS dispatcher payload>,"timestamp":"<ISO Z ms>"}
 *
 * Every NestJS instance subscribes and pushes the parsed event to the
 * Socket.IO connections registered on this instance through
 * `SituationMonitorSignalsGateway.emitLocalEvent`. The gateway applies the same
 * per-organization monitor augmentation the ordinary broadcast path uses.
 *
 * Loop-prevention contract: this subscriber must never call
 * `SituationMonitorSignalsDispatcher.publish`, and `emitLocalEvent` never
 * publishes back to Redis. The bridge message has already been delivered to
 * every instance, so re-entering the dispatcher (or the channel) would loop the
 * same event through the bridge forever.
 *
 * In `legacy` mode no Redis connection is opened and no listener is registered,
 * so the default path is byte-for-byte compatible with the existing worker.
 */
export const SITUATION_MONITOR_SIGNALS_EVENTS_CHANNEL =
  "situation-monitor:signals:events:v1";

const SIGNALS_EVENTS_VERSION = 1;

type SupportedSituationMonitorRealtimeEvent =
  | SituationMonitorRealtimeEvent<SituationTelegramRealtimePayload>
  | SituationMonitorRealtimeEvent<SituationOrefRealtimePayload>;

function isSituationMonitorRealtimeEventType(
  value: unknown,
): value is SituationMonitorRealtimeEventType {
  return (
    value === "situation:telegram.update" ||
    value === "situation:oref.update"
  );
}

@Injectable()
export class SituationMonitorSignalsEventsSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger({
    name: "situation-monitor-signals-events-subscriber",
  });
  private subscriber?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly env: EnvService,
    private readonly gateway: SituationMonitorSignalsGateway,
  ) {}

  async onModuleInit() {
    if (!this.isGoWorkerMode()) {
      return;
    }

    const subscriber = this.redis.duplicate();
    subscriber.on("error", (error) => {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Situation monitor signals events subscriber redis error",
      );
    });
    subscriber.on("message", (channel, message) => {
      if (channel !== SITUATION_MONITOR_SIGNALS_EVENTS_CHANNEL) {
        return;
      }
      void this.handleMessage(message).catch((error) => {
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to handle situation monitor signals event",
        );
      });
    });
    this.subscriber = subscriber;

    try {
      await subscriber.subscribe(SITUATION_MONITOR_SIGNALS_EVENTS_CHANNEL);
      this.logger.info(
        { channel: SITUATION_MONITOR_SIGNALS_EVENTS_CHANNEL },
        "Situation monitor signals events subscriber connected",
      );
    } catch (error) {
      this.subscriber = undefined;
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to subscribe situation monitor signals events channel",
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
      await subscriber.unsubscribe(SITUATION_MONITOR_SIGNALS_EVENTS_CHANNEL);
    } catch {
      // best-effort unsubscribe
    }
    try {
      // Only the duplicate connection is closed; the shared REDIS_CLIENT stays
      // owned by CacheModule.
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  }

  private isGoWorkerMode(): boolean {
    return (
      this.env.get<string>("API_GO_SITUATION_SIGNALS_WORKER_MODE", {
        infer: true,
      }) === "go"
    );
  }

  private async handleMessage(raw: string) {
    const event = this.parseMessage(raw);
    if (!event) {
      return;
    }
    // Local sockets only: the event already reached every NestJS instance via
    // the Redis bridge, and the gateway path must not publish back to it.
    await this.gateway.emitLocalEvent(event);
  }

  private parseMessage(
    raw: string,
  ): SupportedSituationMonitorRealtimeEvent | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      this.logger.warn(
        { error },
        "Ignoring malformed situation monitor signals event payload",
      );
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.logger.warn(
        "Ignoring non-object situation monitor signals event payload",
      );
      return null;
    }

    const record = value as Record<string, unknown>;
    if (record.version !== SIGNALS_EVENTS_VERSION) {
      this.logger.warn(
        { version: record.version },
        "Ignoring unsupported situation monitor signals event version",
      );
      return null;
    }

    const rawType = record.type;
    if (!isSituationMonitorRealtimeEventType(rawType)) {
      this.logger.warn(
        { type: rawType },
        "Ignoring unknown situation monitor realtime event type",
      );
      return null;
    }

    const timestamp = record.timestamp;
    if (typeof timestamp !== "string" || timestamp.length === 0) {
      this.logger.warn(
        { type: rawType },
        "Ignoring situation monitor signals event without timestamp",
      );
      return null;
    }

    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      this.logger.warn(
        { type: rawType },
        "Ignoring situation monitor signals event without object payload",
      );
      return null;
    }

    if (rawType === "situation:telegram.update") {
      return {
        type: rawType,
        timestamp,
        payload: payload as SituationTelegramRealtimePayload,
      };
    }
    return {
      type: rawType,
      timestamp,
      payload: payload as SituationOrefRealtimePayload,
    };
  }
}
