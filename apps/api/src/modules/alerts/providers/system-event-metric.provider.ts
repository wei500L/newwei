import { Injectable } from "@nestjs/common";
import { AlertMetricProvider, AlertRule, Prisma } from "@prisma/client";

import { PrismaService } from "../../config/prisma.service";

import { MetricEvaluation, MetricProvider } from "./metric-provider";

@Injectable()
export class SystemEventMetricProvider implements MetricProvider {
  readonly type = AlertMetricProvider.system_event;

  constructor(private readonly prisma: PrismaService) {}

  supports(rule: Pick<AlertRule, "metricProvider">) {
    return rule.metricProvider === this.type;
  }

  async fetch(
    rule: Pick<AlertRule, "metricSlug" | "operator" | "changeWindowMin" | "metadata" | "metricProvider" | "orgId">
  ): Promise<MetricEvaluation> {
    const windowMinutes = rule.changeWindowMin ?? 60;
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();
    const windowStart = new Date(now - windowMs);
    const previousWindowStart = new Date(now - 2 * windowMs);

    const resource = typeof rule.metadata?.resource === "string" ? rule.metadata.resource : rule.metricSlug;
    const action = typeof rule.metadata?.action === "string" ? rule.metadata.action : undefined;

    const baseWhere: Prisma.AuditLogWhereInput = {
      orgId: rule.orgId,
      resource,
      ...(action ? { action } : {})
    };

    const [latest, previous] = await Promise.all([
      this.prisma.auditLog.count({
        where: {
          ...baseWhere,
          createdAt: { gte: windowStart }
        }
      }),
      this.prisma.auditLog.count({
        where: {
          ...baseWhere,
          createdAt: { gte: previousWindowStart, lt: windowStart }
        }
      })
    ]);

    const changePercent = previous ? ((latest - previous) / previous) * 100 : null;

    return { latest, previous, changePercent, context: { windowMinutes, resource, action } };
  }
}
