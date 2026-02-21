import { CrawlResultContentModel, TaskLogModel } from "@modular/mongo";
import { Injectable } from "@nestjs/common";

import { PrismaService } from "../config/prisma.service";

export interface CrawlQualityMetricsSnapshot {
  orgId: string;
  from: string;
  to: string;
  taskCount: number;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  groupedBySource: Array<{
    sourceId: string;
    taskCount: number;
    lowSignalRatio: number;
    expansionSuccessRate: number;
    avgMarkdownChars: number;
  }>;
}

@Injectable()
export class CrawlQualityMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(orgId: string, lookbackHours = 24): Promise<CrawlQualityMetricsSnapshot> {
    const safeHours = Math.max(1, Math.min(24 * 14, Math.floor(lookbackHours)));
    const to = new Date();
    const from = new Date(to.getTime() - safeHours * 60 * 60 * 1000);

    const tasks = await this.prisma.crawlTask.findMany({
      where: {
        orgId,
        createdAt: { gte: from }
      },
      select: {
        id: true,
        displayName: true,
        config: true
      }
    });

    const taskIds = tasks.map((task) => task.id);
    if (taskIds.length === 0) {
      return {
        orgId,
        from: from.toISOString(),
        to: to.toISOString(),
        taskCount: 0,
        lowSignalRatio: 0,
        emptyMarkdownRate: 0,
        expansionTriggerRate: 0,
        expansionSuccessRate: 0,
        avgMarkdownChars: 0,
        groupedBySource: []
      };
    }

    const [expansionLogs, markdownDocs] = await Promise.all([
      TaskLogModel.find({
        orgId,
        queue: "crawl4ai",
        stage: "expansion",
        createdAt: { $gte: from }
      })
        .select({ jobId: 1, status: 1, data: 1 })
        .lean(),
      CrawlResultContentModel.find({
        taskId: { $in: taskIds },
        createdAt: { $gte: from }
      })
        .select({ taskId: 1, markdown: 1 })
        .lean()
    ]);

    const taskIdSet = new Set(taskIds);
    const expansionByTask = new Map<string, { triggered: boolean; improved: number }>();
    let lowSignalTasks = 0;

    for (const log of expansionLogs) {
      const taskId = typeof log.jobId === "string" ? log.jobId : "";
      if (!taskId || !taskIdSet.has(taskId)) {
        continue;
      }

      const data =
        log.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : {};
      const current = expansionByTask.get(taskId) ?? { triggered: false, improved: 0 };
      current.triggered = true;
      const improvedSuccesses =
        typeof data.improvedSuccesses === "number" && Number.isFinite(data.improvedSuccesses)
          ? Math.max(0, Math.round(data.improvedSuccesses))
          : 0;
      current.improved = Math.max(current.improved, improvedSuccesses);

      const lowSignalResults =
        typeof data.lowSignalResults === "number" && Number.isFinite(data.lowSignalResults)
          ? Math.max(0, Math.round(data.lowSignalResults))
          : 0;
      if (lowSignalResults > 0) {
        lowSignalTasks += 1;
      }

      expansionByTask.set(taskId, current);
    }

    const markdownByTask = new Map<string, { count: number; totalChars: number; emptyCount: number }>();
    for (const doc of markdownDocs) {
      const taskId = typeof doc.taskId === "string" ? doc.taskId : "";
      if (!taskId) {
        continue;
      }
      const markdown = typeof doc.markdown === "string" ? doc.markdown : "";
      const entry = markdownByTask.get(taskId) ?? { count: 0, totalChars: 0, emptyCount: 0 };
      entry.count += 1;
      entry.totalChars += markdown.length;
      if (markdown.trim().length === 0) {
        entry.emptyCount += 1;
      }
      markdownByTask.set(taskId, entry);
    }

    const taskCount = taskIds.length;
    const expansionTriggered = Array.from(expansionByTask.values()).filter((entry) => entry.triggered).length;
    const expansionImproved = Array.from(expansionByTask.values()).filter((entry) => entry.improved > 0).length;

    let markdownCount = 0;
    let markdownChars = 0;
    let emptyMarkdownCount = 0;
    for (const entry of markdownByTask.values()) {
      markdownCount += entry.count;
      markdownChars += entry.totalChars;
      emptyMarkdownCount += entry.emptyCount;
    }

    const groupedBySource = this.groupBySource(tasks, expansionByTask, markdownByTask);

    return {
      orgId,
      from: from.toISOString(),
      to: to.toISOString(),
      taskCount,
      lowSignalRatio: this.safeRatio(lowSignalTasks, taskCount),
      emptyMarkdownRate: this.safeRatio(emptyMarkdownCount, markdownCount),
      expansionTriggerRate: this.safeRatio(expansionTriggered, taskCount),
      expansionSuccessRate: this.safeRatio(expansionImproved, expansionTriggered),
      avgMarkdownChars: markdownCount > 0 ? Math.round(markdownChars / markdownCount) : 0,
      groupedBySource
    };
  }

  async getSourceSnapshot(orgId: string, sourceId: string, lookbackHours = 24): Promise<CrawlQualityMetricsSnapshot> {
    const snapshot = await this.getSnapshot(orgId, lookbackHours);
    const filtered = snapshot.groupedBySource.filter((entry) => entry.sourceId === sourceId);
    const entry = filtered[0];
    if (!entry) {
      return {
        ...snapshot,
        taskCount: 0,
        lowSignalRatio: 0,
        emptyMarkdownRate: 0,
        expansionTriggerRate: 0,
        expansionSuccessRate: 0,
        avgMarkdownChars: 0,
        groupedBySource: []
      };
    }
    return {
      ...snapshot,
      taskCount: entry.taskCount,
      lowSignalRatio: entry.lowSignalRatio,
      expansionSuccessRate: entry.expansionSuccessRate,
      avgMarkdownChars: entry.avgMarkdownChars,
      groupedBySource: filtered
    };
  }

  private groupBySource(
    tasks: Array<{ id: string; displayName: string | null; config: unknown }>,
    expansionByTask: Map<string, { triggered: boolean; improved: number }>,
    markdownByTask: Map<string, { count: number; totalChars: number; emptyCount: number }>
  ) {
    const bySource = new Map<
      string,
      {
        taskCount: number;
        lowSignalCount: number;
        expansionTriggered: number;
        expansionImproved: number;
        markdownCount: number;
        markdownChars: number;
      }
    >();

    for (const task of tasks) {
      const sourceId = this.extractSourceId(task.config, task.displayName) ?? "unknown";
      const current =
        bySource.get(sourceId) ??
        {
          taskCount: 0,
          lowSignalCount: 0,
          expansionTriggered: 0,
          expansionImproved: 0,
          markdownCount: 0,
          markdownChars: 0
        };

      current.taskCount += 1;
      const expansion = expansionByTask.get(task.id);
      if (expansion?.triggered) {
        current.lowSignalCount += 1;
        current.expansionTriggered += 1;
      }
      if ((expansion?.improved ?? 0) > 0) {
        current.expansionImproved += 1;
      }

      const markdown = markdownByTask.get(task.id);
      if (markdown) {
        current.markdownCount += markdown.count;
        current.markdownChars += markdown.totalChars;
      }

      bySource.set(sourceId, current);
    }

    return Array.from(bySource.entries())
      .map(([sourceId, value]) => ({
        sourceId,
        taskCount: value.taskCount,
        lowSignalRatio: this.safeRatio(value.lowSignalCount, value.taskCount),
        expansionSuccessRate: this.safeRatio(value.expansionImproved, value.expansionTriggered),
        avgMarkdownChars: value.markdownCount > 0 ? Math.round(value.markdownChars / value.markdownCount) : 0
      }))
      .sort((left, right) => right.taskCount - left.taskCount);
  }

  private extractSourceId(config: unknown, displayName: string | null): string | undefined {
    if (config && typeof config === "object" && !Array.isArray(config)) {
      const record = config as Record<string, unknown>;
      const itemPayload =
        record.itemPayload && typeof record.itemPayload === "object" && !Array.isArray(record.itemPayload)
          ? (record.itemPayload as Record<string, unknown>)
          : null;
      const metadata =
        itemPayload?.metadata && typeof itemPayload.metadata === "object" && !Array.isArray(itemPayload.metadata)
          ? (itemPayload.metadata as Record<string, unknown>)
          : null;
      const sourceId = typeof metadata?.sourceId === "string" ? metadata.sourceId.trim() : "";
      if (sourceId.length > 0) {
        return sourceId;
      }
    }

    if (typeof displayName === "string") {
      const match = /^NewsSource:([^:]+):/.exec(displayName);
      if (match?.[1]) {
        return match[1];
      }
    }

    return undefined;
  }

  private safeRatio(numerator: number, denominator: number): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return 0;
    }
    return Number((Math.max(0, numerator) / denominator).toFixed(4));
  }
}
