import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { createLogger } from "@modular/utils";
import { TaskLogModel } from "@modular/mongo";
import { PrismaService } from "../config/prisma.service";
import { EnvService } from "../config/config.service";
import { CacheService } from "../cache/cache.service";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import { CrawlQueueService } from "./crawl-queue.service";

const logger = createLogger({ name: "crawl-task-janitor" });

type StaleTaskRow = {
  id: string;
  orgId: string;
  lastRunAt: Date | null;
  updatedAt: Date;
};

@Injectable()
export class CrawlTaskJanitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly queueService: CrawlQueueService,
    private readonly cache: CacheService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupCron() {
    const config = this.env.crawlTaskJanitorConfig;
    if (!config.enabled) {
      return;
    }
    await this.cache.withLock("cron:crawl-task-janitor", config.lockTtlMs, async () =>
      this.cleanupStaleTasks(new Date())
    );
  }

  async cleanupStaleTasks(now: Date): Promise<{ staleRunning: number; staleQueued: number }> {
    const config = this.env.crawlTaskJanitorConfig;
    const staleRunningBefore = new Date(now.getTime() - config.runningTimeoutMs);
    const staleQueuedBefore = new Date(now.getTime() - config.queuedTimeoutMs);

    const [running, queued] = await Promise.all([
      this.findStaleRunningTasks(staleRunningBefore, config.batchSize),
      this.findStaleQueuedTasks(staleQueuedBefore, config.batchSize)
    ]);

    const queuedWithoutJobs = await this.filterQueuedTasksWithoutPendingJobs(
      queued,
      config.queueScanLimit
    );

    if (running.length === 0 && queued.length === 0) {
      return { staleRunning: 0, staleQueued: 0 };
    }

    if (running.length > 0) {
      await this.failTasks(
        "running",
        running,
        `stale crawl task timed out (running > ${config.runningTimeoutMs}ms)`
      );
    }

    if (queuedWithoutJobs.length > 0) {
      await this.failTasks(
        "queued",
        queuedWithoutJobs,
        `stale crawl task timed out (queued > ${config.queuedTimeoutMs}ms)`
      );
    }

    return { staleRunning: running.length, staleQueued: queuedWithoutJobs.length };
  }

  private async findStaleRunningTasks(cutoff: Date, take: number): Promise<StaleTaskRow[]> {
    const tasks = await this.prisma.crawlTask.findMany({
      where: {
        status: "running",
        OR: [
          { lastRunAt: { lt: cutoff } },
          { lastRunAt: null, updatedAt: { lt: cutoff } }
        ]
      },
      orderBy: { updatedAt: "asc" },
      take,
      select: {
        id: true,
        orgId: true,
        lastRunAt: true,
        updatedAt: true
      }
    });
    return tasks;
  }

  private async findStaleQueuedTasks(cutoff: Date, take: number): Promise<StaleTaskRow[]> {
    const tasks = await this.prisma.crawlTask.findMany({
      where: {
        status: "queued",
        updatedAt: { lt: cutoff }
      },
      orderBy: { updatedAt: "asc" },
      take,
      select: {
        id: true,
        orgId: true,
        lastRunAt: true,
        updatedAt: true
      }
    });
    return tasks;
  }

  private async failTasks(kind: "running" | "queued", tasks: StaleTaskRow[], message: string) {
    const taskIds = tasks.map((task) => task.id);
    const updated = await this.prisma.crawlTask.updateMany({
      where: {
        id: { in: taskIds },
        status: kind
      },
      data: {
        status: "failed",
        lastError: message
      }
    });

    if (updated.count === 0) {
      return;
    }

    await this.writeAuditLogs(tasks, kind, message);
    await this.writeTaskLogs(tasks, kind, message);

    logger.warn(
      { kind, count: updated.count, sampleTaskIds: taskIds.slice(0, 5) },
      "Marked stale crawl tasks as failed"
    );
  }

  private async filterQueuedTasksWithoutPendingJobs(
    tasks: StaleTaskRow[],
    scanLimit: number
  ): Promise<StaleTaskRow[]> {
    if (tasks.length === 0) {
      return [];
    }

    try {
      const pendingCount = await this.queueService.getPendingJobCount();
      if (pendingCount > scanLimit) {
        logger.warn(
          { pendingCount, scanLimit, queuedCandidates: tasks.length },
          "Skipping queued-task cleanup because crawl queue is too large to scan safely"
        );
        return [];
      }

      const effectiveScanLimit = Math.max(0, Math.min(scanLimit, pendingCount));
      const pendingTaskIds =
        effectiveScanLimit === 0
          ? new Set<string>()
          : await this.queueService.listPendingTaskIds(effectiveScanLimit);
      return tasks.filter((task) => !pendingTaskIds.has(task.id));
    } catch (error) {
      logger.warn({ err: error }, "Failed to scan queue for queued-task cleanup");
      return [];
    }
  }

  private async writeAuditLogs(tasks: StaleTaskRow[], kind: "running" | "queued", message: string) {
    const byOrg = tasks.reduce<Record<string, string[]>>((acc, task) => {
      acc[task.orgId] ??= [];
      acc[task.orgId].push(task.id);
      return acc;
    }, {});

    await Promise.all(
      Object.entries(byOrg).map(async ([orgId, ids]) => {
        try {
          await writeAuditLogBestEffort(
            this.prisma,
            {
              data: {
                orgId,
                actorId: null,
                resource: "crawlTask",
                action: "auto_fail_stale",
                metadata: {
                  kind,
                  message,
                  taskIds: ids
                }
              }
            },
            { orgId, resource: "crawlTask", action: "auto_fail_stale" }
          );
        } catch (error) {
          logger.warn({ orgId, err: error }, "Failed to write crawl stale-task audit log");
        }
      })
    );
  }

  private async writeTaskLogs(tasks: StaleTaskRow[], kind: "running" | "queued", message: string) {
    await Promise.all(
      tasks.map(async (task) => {
        try {
          await TaskLogModel.create({
            queue: CRAWL_QUEUE_NAME,
            jobId: task.id,
            orgId: task.orgId,
            stage: "cleanup",
            status: "failed",
            message,
            data: {
              kind,
              lastRunAt: task.lastRunAt?.toISOString() ?? null,
              updatedAt: task.updatedAt.toISOString()
            }
          });
        } catch (error) {
          logger.warn({ taskId: task.id, err: error }, "Failed to write stale crawl task log");
        }
      })
    );
  }
}
