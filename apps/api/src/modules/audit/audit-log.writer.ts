import type { Prisma } from "@prisma/client";
import { createLogger } from "@modular/utils";
import type { PrismaService } from "../config/prisma.service";

const logger = createLogger({ name: "audit-log" });

export async function writeAuditLogBestEffort(
  prisma: PrismaService,
  args: Prisma.AuditLogCreateArgs,
  context?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.auditLog.create(args);
  } catch (error) {
    logger.warn({ ...context, err: error }, "Failed to write audit log");
  }
}

