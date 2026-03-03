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
    const metricSlug =
      typeof rule.metricSlug === "string" ? rule.metricSlug.trim() : "";
    const windowMinutes = rule.changeWindowMin ?? 60;
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();
    const windowStart = new Date(now - windowMs);
    const previousWindowStart = new Date(now - 2 * windowMs);

    const metadata =
      rule.metadata && typeof rule.metadata === "object" && !Array.isArray(rule.metadata)
        ? (rule.metadata as Record<string, unknown>)
        : null;
    const resource =
      typeof metadata?.resource === "string" && metadata.resource.trim().length > 0
        ? metadata.resource.trim()
        : metricSlug;
    if (!resource) {
      return {
        latest: null,
        previous: null,
        changePercent: null,
        context: { error: "metric_slug_missing" }
      };
    }
    const action =
      typeof metadata?.action === "string" && metadata.action.trim().length > 0
        ? metadata.action.trim()
        : undefined;

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
