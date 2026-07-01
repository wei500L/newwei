import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

export interface NewsnowRealtimeEvent {
  orgId: string;
  sourceId: string;
  newItemsCount: number;
  topTitles: string[];
  updatedTime: string;
  intervalMs: number;
  timestamp: string;
}

type NewsnowRealtimeListener = (
  event: NewsnowRealtimeEvent,
) => void | Promise<void>;

@Injectable()
export class NewsnowRealtimeDispatcher {
  private readonly listeners = new Set<NewsnowRealtimeListener>();
  private readonly logger = createLogger({ name: "newsnow-realtime-dispatcher" });

  registerListener(listener: NewsnowRealtimeListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(
    event: Omit<NewsnowRealtimeEvent, "timestamp">,
  ) {
    const orgId = typeof event.orgId === "string" ? event.orgId.trim() : "";
    if (!orgId) {
      this.logger.warn(
        { sourceId: event.sourceId },
        "Dropped NewsNow realtime event without orgId",
      );
      return;
    }

    const payload: NewsnowRealtimeEvent = {
      ...event,
      orgId,
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        await listener(payload);
      } catch (error) {
        this.logger.error({ sourceId: payload.sourceId, error }, "NewsNow realtime listener failed");
      }
    }
  }
}
