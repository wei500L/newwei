import { Injectable } from "@nestjs/common";
import { PipelineJobStatus } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

export interface NewsSourceQualitySummary {
  windowHours: number;
  totals: {
    total: number;
    active: number;
    failing: number;
    circuitOpen: number;
  };
  topFailingSources: Array<{
    sourceId: string;
    name: string;
    url: string;
    failedJobs: number;
    consecutiveFailures: number;
    lastFailureAt: string | null;
    circuitOpenUntil: string | null;
    nextRunAt: string | null;
  }>;
}

@Injectable()
export class NewsSourceQualityService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(orgId: string, windowHours = 24): Promise<NewsSourceQualitySummary> {
    const normalizedWindow = Math.max(1, Math.min(24 * 14, Math.floor(windowHours)));
    const now = new Date();
    const since = new Date(now.getTime() - normalizedWindow * 60 * 60 * 1000);

    const [total, active, failing, circuitOpen, failures] = await Promise.all([
      this.prisma.newsSource.count({ where: { orgId } }),
      this.prisma.newsSource.count({ where: { orgId, isActive: true } }),
      this.prisma.newsSource.count({ where: { orgId, consecutiveFailures: { gt: 0 } } }),
      this.prisma.newsSource.count({
        where: { orgId, isActive: true, circuitOpenUntil: { gt: now } },
      }),
      this.prisma.pipelineJob.groupBy({
        by: ["sourceId"],
        where: {
          orgId,
          status: PipelineJobStatus.failed,
          sourceId: { not: null },
          createdAt: { gte: since },
        },
        _count: { _all: true },
        orderBy: { _count: { _all: "desc" } },
        take: 10,
      }),
    ]);

    const sourceIds = failures
      .map((entry) => entry.sourceId)
      .filter((sourceId): sourceId is string => Boolean(sourceId));

    const sources = sourceIds.length
      ? await this.prisma.newsSource.findMany({
          where: { orgId, id: { in: sourceIds } },
          select: {
            id: true,
            name: true,
            url: true,
            consecutiveFailures: true,
            lastFailureAt: true,
            circuitOpenUntil: true,
            nextRunAt: true,
          },
        })
      : [];

    const sourceMap = new Map<string, (typeof sources)[number]>();
    sources.forEach((source) => sourceMap.set(source.id, source));

    const topFailingSources = failures
      .map((entry) => {
        const sourceId = entry.sourceId;
        if (!sourceId) {
          return null;
        }
        const source = sourceMap.get(sourceId);
        if (!source) {
          return null;
        }
        return {
          sourceId,
          name: source.name,
          url: source.url,
          failedJobs: entry._count._all,
          consecutiveFailures: source.consecutiveFailures,
          lastFailureAt: source.lastFailureAt ? source.lastFailureAt.toISOString() : null,
          circuitOpenUntil: source.circuitOpenUntil ? source.circuitOpenUntil.toISOString() : null,
          nextRunAt: source.nextRunAt ? source.nextRunAt.toISOString() : null,
        };
      })
      .filter(
        (entry): entry is NewsSourceQualitySummary["topFailingSources"][number] => Boolean(entry),
      );

    return {
      windowHours: normalizedWindow,
      totals: {
        total,
        active,
        failing,
        circuitOpen,
      },
      topFailingSources,
    };
  }
}

