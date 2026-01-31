import { createLogger } from "@modular/utils";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Queue, QueueEvents } from "bullmq";

import { PrismaService } from "../config/prisma.service";

import { ALERTS_QUEUE, ALERTS_QUEUE_EVENTS } from "./alerts.constants";
import type { AlertJobPayload } from "./alerts.service";

export interface AlertsQueueEventPayload {
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type AlertsQueueEventListener = (orgId: string, payload: AlertsQueueEventPayload) => Promise<void> | void;

interface OrgCacheEntry {
  orgId: string;
  expiresAt: number;
}

@Injectable()
export class AlertsQueueEventPublisher implements OnModuleDestroy {
  private readonly listeners = new Set<AlertsQueueEventListener>();
  private readonly logger = createLogger({ name: "alerts-queue-events" });
  private readonly orgCache = new Map<string, OrgCacheEntry>();
  private readonly orgCacheTtlMs = 10 * 60_000;

  private readonly handleCompleted = async ({
    jobId,
    returnvalue
  }: {
    jobId: string;
    returnvalue?: unknown;
  }) => {
    const completedData =
      returnvalue && typeof returnvalue === "object" && !Array.isArray(returnvalue)
        ? (returnvalue as Record<string, unknown>)
        : returnvalue !== undefined
          ? { returnvalue }
          : undefined;
    await this.emit(jobId, "COMPLETED", completedData);
  };

  private readonly handleActive = async ({
    jobId,
    prev
  }: {
    jobId: string;
    prev?: string | null;
  }) => {
    await this.emit(jobId, "ACTIVE", prev ? { prev } : undefined);
  };

  private readonly handleProgress = async ({
    jobId,
    data
  }: {
    jobId: string;
    data?: unknown;
  }) => {
    const progressData =
      data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : data !== undefined
          ? { progress: data }
          : undefined;
    await this.emit(jobId, "PROGRESS", progressData);
  };

  private readonly handleFailed = async ({
    jobId,
    failedReason
  }: {
    jobId: string;
    failedReason?: string;
  }) => {
    await this.emit(jobId, "FAILED", failedReason ? { reason: failedReason } : undefined);
  };

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ALERTS_QUEUE_EVENTS) private readonly events: QueueEvents,
    @Inject(ALERTS_QUEUE) private readonly queue: Queue<AlertJobPayload>
  ) {
    this.events.on("active", this.handleActive);
    this.events.on("progress", this.handleProgress);
    this.events.on("completed", this.handleCompleted);
    this.events.on("failed", this.handleFailed);
  }

  registerListener(listener: AlertsQueueEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(jobId: string, event: string, data?: Record<string, unknown>) {
    try {
      const orgId = await this.resolveOrgId(jobId);
      if (!orgId) {
        this.logger.debug({ jobId, event }, "Skipping alerts queue event without org context");
        return;
      }

      const payload: AlertsQueueEventPayload = {
        event,
        jobId,
        data,
        timestamp: new Date().toISOString()
      };

      await this.dispatchToListeners(orgId, payload);
    } catch (error) {
      this.logger.error({ jobId, event, error }, "Failed to publish alerts queue event");
    }
  }

  private async resolveOrgId(jobId: string): Promise<string | null> {
    const cached = this.getCachedOrgId(jobId);

    try {
      const job = await this.queue.getJob(jobId);
      const orgId = (job?.data as { orgId?: unknown } | undefined)?.orgId;
      if (typeof orgId === "string" && orgId.length > 0) {
        this.setCachedOrgId(jobId, orgId);
        return orgId;
      }

      const type = (job?.data as { type?: unknown } | undefined)?.type;
      if (type === "evaluate") {
        const ruleId = (job?.data as { ruleId?: unknown } | undefined)?.ruleId;
        if (typeof ruleId === "string" && ruleId.length > 0) {
          const orgIdFromRule = await this.lookupOrgIdFromRuleId(ruleId);
          if (orgIdFromRule) {
            this.setCachedOrgId(jobId, orgIdFromRule);
            return orgIdFromRule;
          }
        }
      }

      if (type === "deliver") {
        const deliveryId = (job?.data as { deliveryId?: unknown } | undefined)?.deliveryId;
        if (typeof deliveryId === "string" && deliveryId.length > 0) {
          const orgIdFromDelivery = await this.lookupOrgIdFromDeliveryId(deliveryId);
          if (orgIdFromDelivery) {
            this.setCachedOrgId(jobId, orgIdFromDelivery);
            return orgIdFromDelivery;
          }
        }
      }
    } catch (error) {
      this.logger.debug({ jobId, error }, "Failed to resolve alerts queue orgId from job");
    }

    const inferred = this.inferOrgLookupFromJobId(jobId);
    if (inferred?.kind === "rule") {
      const orgIdFromRule = await this.lookupOrgIdFromRuleId(inferred.id);
      if (orgIdFromRule) {
        this.setCachedOrgId(jobId, orgIdFromRule);
        return orgIdFromRule;
      }
    }
    if (inferred?.kind === "delivery") {
      const orgIdFromDelivery = await this.lookupOrgIdFromDeliveryId(inferred.id);
      if (orgIdFromDelivery) {
        this.setCachedOrgId(jobId, orgIdFromDelivery);
        return orgIdFromDelivery;
      }
    }

    return cached;
  }

  private inferOrgLookupFromJobId(jobId: string): { kind: "rule" | "delivery"; id: string } | null {
    if (jobId === "scan-active-rules") {
      return null;
    }
    if (jobId.startsWith("deliver-")) {
      const id = jobId.slice(8);
      return id.length > 0 ? { kind: "delivery", id } : null;
    }
    if (jobId.startsWith("evaluate:")) {
      const parts = jobId.split(":");
      const id = parts[1]?.trim() ?? "";
      return id.length > 0 ? { kind: "rule", id } : null;
    }
    if (jobId.startsWith("evaluate-")) {
      const id = jobId.slice(9);
      return id.length > 0 ? { kind: "rule", id } : null;
    }
    return null;
  }

  private async lookupOrgIdFromRuleId(ruleId: string): Promise<string | null> {
    try {
      const rule = await this.prisma.alertRule.findUnique({
        where: { id: ruleId },
        select: { orgId: true }
      });
      return rule?.orgId ?? null;
    } catch (error) {
      this.logger.debug({ ruleId, error }, "Failed to resolve alerts orgId from rule");
      return null;
    }
  }

  private async lookupOrgIdFromDeliveryId(deliveryId: string): Promise<string | null> {
    try {
      const delivery = await this.prisma.alertDelivery.findUnique({
        where: { id: deliveryId },
        select: { event: { select: { rule: { select: { orgId: true } } } } }
      });
      return delivery?.event?.rule?.orgId ?? null;
    } catch (error) {
      this.logger.debug({ deliveryId, error }, "Failed to resolve alerts orgId from delivery");
      return null;
    }
  }

  private setCachedOrgId(jobId: string, orgId: string) {
    this.orgCache.set(jobId, { orgId, expiresAt: Date.now() + this.orgCacheTtlMs });
  }

  private getCachedOrgId(jobId: string): string | null {
    const cached = this.orgCache.get(jobId);
    if (!cached) {
      return null;
    }
    if (Date.now() >= cached.expiresAt) {
      this.orgCache.delete(jobId);
      return null;
    }
    return cached.orgId;
  }

  private async dispatchToListeners(orgId: string, payload: AlertsQueueEventPayload) {
    for (const listener of this.listeners) {
      try {
        await listener(orgId, payload);
      } catch (error) {
        this.logger.error({ orgId, error }, "Alerts queue event listener failed");
      }
    }
  }

  async onModuleDestroy() {
    this.events.off("active", this.handleActive);
    this.events.off("progress", this.handleProgress);
    this.events.off("completed", this.handleCompleted);
    this.events.off("failed", this.handleFailed);
    this.listeners.clear();
    this.orgCache.clear();
  }
}

