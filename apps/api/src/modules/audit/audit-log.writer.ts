import { createLogger } from "@modular/utils";
import { AuditLogOutboxStatus, type Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import type { PrismaService } from "../config/prisma.service";

const logger = createLogger({ name: "audit-log" });

interface AuditLogOutboxPayload {
  orgId: string;
  actorId: string | null;
  resource: string;
  action: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress: string | null;
  createdAt: string;
}

function createOutboxPayload(
  args: Prisma.AuditLogCreateArgs,
  createdAt: Date
): AuditLogOutboxPayload | null {
  const data = args.data as Record<string, unknown>;

  const orgId =
    typeof data.orgId === "string"
      ? data.orgId
      : typeof data.org === "object" && data.org && "connect" in data.org
        ? ((data.org as { connect?: { id?: unknown } }).connect?.id as string | undefined)
        : undefined;

  const actorId =
    typeof data.actorId === "string"
      ? data.actorId
      : data.actorId === null
        ? null
        : typeof data.actor === "object" && data.actor && "connect" in data.actor
          ? (((data.actor as { connect?: { id?: unknown } }).connect?.id as string | undefined) ??
            null)
          : null;

  const resource = typeof data.resource === "string" ? data.resource : "";
  const action = typeof data.action === "string" ? data.action : "";
  const ipAddress =
    data.ipAddress === null ? null : typeof data.ipAddress === "string" ? data.ipAddress : null;
  const metadata = "metadata" in data ? (data.metadata as Prisma.InputJsonValue) : undefined;

  if (typeof orgId !== "string" || !orgId.trim() || !resource.trim() || !action.trim()) {
    return null;
  }

  return {
    orgId,
    actorId,
    resource,
    action,
    metadata,
    ipAddress,
    createdAt: createdAt.toISOString()
  };
}

export async function writeAuditLogBestEffort(
  prisma: PrismaService | Prisma.TransactionClient,
  args: Prisma.AuditLogCreateArgs,
  context?: Record<string, unknown>
): Promise<void> {
  const now = new Date();
  const rawCreatedAt = (args.data as Record<string, unknown>)?.createdAt;
  const createdAt = rawCreatedAt instanceof Date ? rawCreatedAt : now;

  try {
    await prisma.auditLog.create({
      ...args,
      data: {
        ...(args.data as Prisma.AuditLogCreateArgs["data"]),
        createdAt
      }
    });
  } catch (error) {
    const payload = createOutboxPayload(args, createdAt);
    if (!payload) {
      logger.error(
        { ...context, err: error },
        "Failed to write audit log and could not build outbox payload"
      );
      throw error;
    }

    try {
      const outbox = await prisma.auditLogOutbox.create({
        data: {
          orgId: payload.orgId,
          payload: toPrismaJsonValue(payload),
          status: AuditLogOutboxStatus.pending,
          availableAt: now
        },
        select: { id: true }
      });
      logger.warn(
        { ...context, err: error, outboxId: outbox.id },
        "Failed to write audit log; enqueued for retry"
      );
    } catch (enqueueError) {
      logger.error(
        { ...context, err: error, enqueueErr: enqueueError },
        "Failed to write audit log and enqueue outbox"
      );
      throw error;
    }
  }
}
