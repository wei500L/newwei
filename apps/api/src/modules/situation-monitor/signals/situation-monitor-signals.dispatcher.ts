import { createLogger } from '@modular/utils';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../../cache/cache.tokens';
import { EnvService } from '../../config/config.service';

import type {
  SituationMonitorRealtimeEvent,
  SituationMonitorRealtimeEventType,
} from './situation-monitor-signals.types';

type SituationMonitorListener = (
  event: SituationMonitorRealtimeEvent,
) => void | Promise<void>;

/**
 * One-way event bridge consumed by the Go realtime Socket.IO transport.
 *
 * Contract: when `API_GO_REALTIME_SOCKET_MODE=go`, every event dispatched to
 * the in-process listeners is also published on this channel as
 * `{"version":1,"type","payload","timestamp"}`. `payload` is the original,
 * not-per-user-augmented payload handed to the listeners, and `timestamp` is
 * the dispatcher-generated ISO-8601 string (`event.timestamp`), so the Go side
 * can reproduce the same ordering without re-deriving it.
 *
 * Loop safety: the bridge is one-way. Only this dispatcher publishes to the
 * channel, the Go subscriber only fans the message out to its local sockets
 * and never calls back into `publish()`, and nothing in this process
 * subscribes to the channel. A message therefore cannot re-enter the
 * dispatcher and duplicate in-process delivery.
 *
 * Publication is best effort: Redis failures are logged and never break the
 * in-process listener path.
 */
const SITUATION_MONITOR_SIGNALS_EVENTS_CHANNEL =
  'situation-monitor:signals:events:v1';

const SITUATION_MONITOR_SIGNALS_EVENTS_VERSION = 1;

interface SituationMonitorSignalsBridgeMessage<T> {
  version: number;
  type: SituationMonitorRealtimeEventType;
  payload: T;
  timestamp: string;
}

@Injectable()
export class SituationMonitorSignalsDispatcher {
  private readonly listeners = new Set<SituationMonitorListener>();
  private readonly logger = createLogger({ name: 'situation-monitor-signals-dispatcher' });

  constructor(
    private readonly env: EnvService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  registerListener(listener: SituationMonitorListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish<T>(type: SituationMonitorRealtimeEventType, payload: T) {
    const event: SituationMonitorRealtimeEvent<T> = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.warn({ error, type }, 'Situation monitor realtime listener failed');
      }
    }

    // Fire-and-forget: the bridge is best effort and must never block the
    // BullMQ polling job (concurrency 1) while a shared ioredis client is
    // reconnecting. The method catches and logs its own failures.
    void this.publishToRealtimeBridge(event);
  }

  private async publishToRealtimeBridge<T>(
    event: SituationMonitorRealtimeEvent<T>,
  ) {
    if (
      this.env.get<string>('API_GO_REALTIME_SOCKET_MODE', { infer: true }) !==
      'go'
    ) {
      return;
    }

    const message: SituationMonitorSignalsBridgeMessage<T> = {
      version: SITUATION_MONITOR_SIGNALS_EVENTS_VERSION,
      type: event.type,
      payload: event.payload,
      timestamp: event.timestamp,
    };

    try {
      await this.redis.publish(
        SITUATION_MONITOR_SIGNALS_EVENTS_CHANNEL,
        JSON.stringify(message),
      );
    } catch (error) {
      // The in-process listeners already ran; a degraded bridge must not fail
      // the dispatcher or the polling job that produced the event.
      this.logger.warn(
        { error, type: event.type },
        'Situation monitor realtime bridge publish failed',
      );
    }
  }
}
