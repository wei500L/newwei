import { createLogger } from '@modular/utils';
import { Injectable } from '@nestjs/common';

import type {
  SituationMonitorRealtimeEvent,
  SituationMonitorRealtimeEventType,
} from './situation-monitor-signals.types';

type SituationMonitorListener = (
  event: SituationMonitorRealtimeEvent,
) => void | Promise<void>;

@Injectable()
export class SituationMonitorSignalsDispatcher {
  private readonly listeners = new Set<SituationMonitorListener>();
  private readonly logger = createLogger({ name: 'situation-monitor-signals-dispatcher' });

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
  }
}
