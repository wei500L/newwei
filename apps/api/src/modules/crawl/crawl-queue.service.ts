import { createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { Job, Queue } from "bullmq";

import { BULLMQ_FAILED_JOB_RETENTION } from "../../common/bullmq-retention";

import { CrawlActivityService } from "./crawl-activity.service";
import { CrawlSettingsService } from "./crawl-settings.service";
import {
  CRAWL_QUEUE_HOT,
  CRAWL_QUEUE_HOT_NAME,
  CRAWL_QUEUE_LEGACY,
  CRAWL_QUEUE_LLM_JUDGE,
  CRAWL_QUEUE_LLM_LEARN,
  CRAWL_QUEUE_NAME,
  CRAWL_QUEUE_NORMAL,
  CRAWL_QUEUE_NORMAL_NAME,
} from "./crawl.constants";
import type {
  CrawlFrontierLlmJudgeJobPayload,
  CrawlFrontierLlmLearnJobPayload,
  CrawlJobData,
  CrawlPriorityClass,
} from "./crawl.types";

const logger = createLogger({ name: "crawl-queue-service" });
const GLOBAL_CONCURRENCY_FALLBACK = 1;
const SOURCE_PRIORITY_MIN = -100;
const SOURCE_PRIORITY_MAX = 100;

type CrawlQueueClass = CrawlPriorityClass;

type QueueCounts = Record<string, number>;

export interface EnqueueCrawlTaskOptions {
  priorityClass?: CrawlQueueClass;
  sourcePriority?: number;
  sourceId?: string;
}

export interface EnqueueFrontierNodeOptions {
  taskId: string;
  orgId: string;
  frontierRunId: string;
  frontierNodeId: string;
  priorityClass?: CrawlQueueClass;
  sourcePriority?: number;
}

export interface EnqueueFrontierLlmJudgeOptions {
  taskId: string;
  orgId: string;
  runId: string;
  nodeId: string;
  payload: CrawlFrontierLlmJudgeJobPayload;
}

export interface EnqueueFrontierLlmLearnOptions {
  taskId: string;
  orgId: string;
  runId: string;
  payload: CrawlFrontierLlmLearnJobPayload;
}

export interface CrawlQueueClassRuntimeStats {
  queueName: string;
  pending: number;
  paused: boolean;
  counts: QueueCounts;
  effectiveConcurrency: number;
}

interface QueueWithGlobalConcurrencyApi {
  setGlobalConcurrency?: (concurrency: number) => Promise<void>;
  getGlobalConcurrency?: () => Promise<number | null>;
}

interface QueueEntry {
  queueClass: CrawlQueueClass;
  queueName: string;
  queue: Queue<CrawlJobData>;
}

function isJobLockedRemovalError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("locked by another worker")
  );
}

function toBullmqPriority(sourcePriority: unknown): number | undefined {
  if (typeof sourcePriority !== "number" || !Number.isFinite(sourcePriority)) {
    return undefined;
  }
  const normalized = Math.round(sourcePriority);
  const clamped = Math.max(
    SOURCE_PRIORITY_MIN,
    Math.min(SOURCE_PRIORITY_MAX, normalized),
  );
  return SOURCE_PRIORITY_MAX + 1 - clamped;
}

function normalizeQueueClass(
  value: CrawlQueueClass | undefined,
): CrawlQueueClass {
  return value === "hot" ? "hot" : "normal";
}

function sumPendingFromCounts(counts: QueueCounts): number {
  return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
}

function mergeCounts(left: QueueCounts, right: QueueCounts): QueueCounts {
  const merged: QueueCounts = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

@Injectable()
export class CrawlQueueService {
  constructor(
    @Inject(CRAWL_QUEUE_HOT) private readonly hotQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_NORMAL)
    private readonly normalQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_LLM_JUDGE)
    private readonly llmJudgeQueue: Queue<CrawlJobData>,
    @Inject(CRAWL_QUEUE_LLM_LEARN)
    private readonly llmLearnQueue: Queue<CrawlJobData>,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly activity: CrawlActivityService,
    @Optional()
    @Inject(CRAWL_QUEUE_LEGACY)
    private readonly legacyQueue?: Queue<CrawlJobData>,
  ) {}

  private queueEntries(includeLegacy = false): QueueEntry[] {
    const entries: QueueEntry[] = [
      {
        queueClass: "hot",
        queueName: CRAWL_QUEUE_HOT_NAME,
        queue: this.hotQueue,
      },
      {
        queueClass: "normal",
        queueName: CRAWL_QUEUE_NORMAL_NAME,
        queue: this.normalQueue,
      },
    ];
    if (includeLegacy && this.legacyQueue) {
      entries.push({
        queueClass: "normal",
        queueName: CRAWL_QUEUE_NAME,
        queue: this.legacyQueue,
      });
    }
    return entries;
  }

  private getQueueEntry(queueClass: CrawlQueueClass): QueueEntry {
    return queueClass === "hot"
      ? {
          queueClass: "hot",
          queueName: CRAWL_QUEUE_HOT_NAME,
          queue: this.hotQueue,
        }
      : {
          queueClass: "normal",
          queueName: CRAWL_QUEUE_NORMAL_NAME,
          queue: this.normalQueue,
        };
  }

  private getQueueEntriesForClass(queueClass: CrawlQueueClass): QueueEntry[] {
    if (queueClass === "hot") {
      return [this.getQueueEntry("hot")];
    }
    return this.queueEntries(true).filter((entry) => entry.queueClass === "normal");
  }

  private getLegacyQueueEntry(): QueueEntry | null {
    if (!this.legacyQueue) {
      return null;
    }
    return {
      queueClass: "normal",
      queueName: CRAWL_QUEUE_NAME,
      queue: this.legacyQueue,
    };
  }

  private asQueueWithGlobalConcurrencyApi(queue: Queue<CrawlJobData>) {
    return queue as Queue<CrawlJobData> & QueueWithGlobalConcurrencyApi;
  }

  private sanitizeConcurrency(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.max(GLOBAL_CONCURRENCY_FALLBACK, Math.round(value));
    }
    return Math.max(GLOBAL_CONCURRENCY_FALLBACK, Math.round(fallback));
  }

  async enqueueTask(
    taskId: string,
    orgId: string,
    triggeredById?: string,
    options?: EnqueueCrawlTaskOptions,
  ) {
    const settings = await this.crawlSettings.getSettings();
    const attempts = Math.max(1, settings.maxRetries);
    const traceId = ensureTraceId(getCurrentTraceId());
    const queueClass = normalizeQueueClass(options?.priorityClass);
    const queueEntry = this.getQueueEntry(queueClass);
    const deduplicationId = `crawl-task:${taskId}:${queueClass}`;
    const jobPriority = toBullmqPriority(options?.sourcePriority);

    await queueEntry.queue.add(
      "crawl-task",
      {
        taskId,
        orgId,
        sourceId: options?.sourceId,
        triggeredById,
        traceId,
        memoryPressureRequeues: 0,
        priorityClass: queueClass,
        sourcePriority: options?.sourcePriority,
      },
      {
        jobId: `${taskId}-${Date.now()}-${queueClass}`,
        deduplication: {
          id: deduplicationId,
        },
        removeOnComplete: true,
        removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
        attempts,
        backoff: settings.retryBackoffMs
          ? {
              type: "exponential",
              delay: settings.retryBackoffMs,
            }
          : undefined,
        priority: jobPriority,
      },
    );
    await this.activity.markTaskQueued();
  }

  async enqueueFrontierNode(options: EnqueueFrontierNodeOptions) {
    const settings = await this.crawlSettings.getSettings();
    const attempts = Math.max(1, settings.maxRetries);
    const traceId = ensureTraceId(getCurrentTraceId());
    const queueClass = normalizeQueueClass(options.priorityClass);
    const queueEntry = this.getQueueEntry(queueClass);
    const deduplicationId = `crawl-frontier-node:${options.frontierNodeId}:${queueClass}`;
    const jobPriority = toBullmqPriority(options.sourcePriority);

    await queueEntry.queue.add(
      "crawl-frontier-node",
      {
        taskId: options.taskId,
        orgId: options.orgId,
        traceId,
        memoryPressureRequeues: 0,
        priorityClass: queueClass,
        sourcePriority: options.sourcePriority,
        jobKind: "frontier_node",
        frontierRunId: options.frontierRunId,
        frontierNodeId: options.frontierNodeId,
      },
      {
        jobId: `${options.frontierNodeId}-${Date.now()}-${queueClass}`,
        deduplication: {
          id: deduplicationId,
        },
        removeOnComplete: true,
        removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
        attempts,
        backoff: settings.retryBackoffMs
          ? {
              type: "exponential",
              delay: settings.retryBackoffMs,
            }
          : undefined,
        priority: jobPriority,
      },
    );
  }

  async enqueueFrontierLlmJudge(options: EnqueueFrontierLlmJudgeOptions) {
    const settings = await this.crawlSettings.getSettings();
    const traceId = ensureTraceId(getCurrentTraceId());

    await this.llmJudgeQueue.add(
      "crawl-frontier-llm-judge",
      {
        taskId: options.taskId,
        orgId: options.orgId,
        traceId,
        jobKind: "frontier_llm_judge",
        frontierRunId: options.runId,
        frontierNodeId: options.nodeId,
        frontierLlmJudge: options.payload,
      },
      {
        jobId: `llm-judge:${options.nodeId}:${options.payload.mode}:${Date.now()}`,
        deduplication: {
          id: `crawl-frontier-llm-judge:${options.nodeId}:${options.payload.mode}`,
        },
        removeOnComplete: true,
        removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
        attempts: 1,
        backoff: settings.retryBackoffMs
          ? {
              type: "exponential",
              delay: settings.retryBackoffMs,
            }
          : undefined,
      },
    );
  }

  async enqueueFrontierLlmLearn(options: EnqueueFrontierLlmLearnOptions) {
    const settings = await this.crawlSettings.getSettings();
    const traceId = ensureTraceId(getCurrentTraceId());

    await this.llmLearnQueue.add(
      "crawl-frontier-llm-learn",
      {
        taskId: options.taskId,
        orgId: options.orgId,
        traceId,
        jobKind: "frontier_llm_learn",
        frontierRunId: options.runId,
        frontierLlmLearn: options.payload,
      },
      {
        jobId: `llm-learn:${options.runId}:${Date.now()}`,
        deduplication: {
          id: `crawl-frontier-llm-learn:${options.runId}`,
        },
        removeOnComplete: true,
        removeOnFail: BULLMQ_FAILED_JOB_RETENTION,
        attempts: 1,
        backoff: settings.retryBackoffMs
          ? {
              type: "exponential",
              delay: settings.retryBackoffMs,
            }
          : undefined,
      },
    );
  }

  async removeQueuedJobs(taskId: string) {
    const states = ["waiting", "delayed", "failed", "paused"] as const;
    const scanLimit = 5_000;
    const pageSize = 200;

    for (const entry of this.queueEntries(true)) {
      for (let start = 0; start < scanLimit; start += pageSize) {
        const end = Math.min(scanLimit - 1, start + pageSize - 1);
        const jobs = await entry.queue.getJobs([...states], start, end);
        const matching = jobs.filter((job) => job.data?.taskId === taskId);
        await Promise.all(
          matching.map(async (job: Job) => {
            try {
              await job.remove();
            } catch (error) {
              if (isJobLockedRemovalError(error)) {
                return;
              }

              let state: string | undefined;
              try {
                state = await job.getState();
              } catch {
                state = undefined;
              }

              logger.warn(
                {
                  taskId,
                  queue: entry.queueName,
                  jobId: job.id,
                  state,
                  err: error,
                },
                "Failed to remove queued crawl job",
              );
            }
          }),
        );

        if (jobs.length < pageSize) {
          break;
        }
      }
    }
  }

  async getPendingJobCount(): Promise<number> {
    const entries = await Promise.all(
      this.queueEntries(true).map(async (entry) => {
        const counts = (await entry.queue.getJobCounts(
          "waiting",
          "delayed",
          "active",
        )) as QueueCounts;
        return sumPendingFromCounts(counts);
      }),
    );
    return entries.reduce((sum, value) => sum + value, 0);
  }

  async listPendingTaskIds(scanLimit = 5_000): Promise<Set<string>> {
    const states = ["waiting", "delayed", "active"] as const;
    const pageSize = 500;
    const taskIds = new Set<string>();

    for (const entry of this.queueEntries(true)) {
      for (let start = 0; start < scanLimit; start += pageSize) {
        const end = Math.min(scanLimit - 1, start + pageSize - 1);
        const jobs = await entry.queue.getJobs([...states], start, end);
        for (const job of jobs) {
          const taskId = job.data?.taskId;
          if (typeof taskId === "string" && taskId.length > 0) {
            taskIds.add(taskId);
          }
        }
        if (jobs.length < pageSize) {
          break;
        }
      }
    }

    return taskIds;
  }

  async listQueuedTaskIds(scanLimit = 5_000): Promise<Set<string>> {
    const states = ["waiting", "delayed", "failed", "paused"] as const;
    const pageSize = 500;
    const taskIds = new Set<string>();

    for (const entry of this.queueEntries(true)) {
      for (let start = 0; start < scanLimit; start += pageSize) {
        const end = Math.min(scanLimit - 1, start + pageSize - 1);
        const jobs = await entry.queue.getJobs([...states], start, end);
        for (const job of jobs) {
          const taskId = job.data?.taskId;
          if (typeof taskId === "string" && taskId.length > 0) {
            taskIds.add(taskId);
          }
        }
        if (jobs.length < pageSize) {
          break;
        }
      }
    }

    return taskIds;
  }

  async removeQueuedJobsForTasks(taskIds: Set<string>, scanLimit = 5_000) {
    if (taskIds.size === 0) {
      return { scanned: 0, removed: 0, removedTaskIds: [] as string[] };
    }

    const states = ["waiting", "delayed", "failed", "paused"] as const;
    const pageSize = 200;
    let scanned = 0;
    let removed = 0;
    const removedTaskIds = new Set<string>();

    for (const entry of this.queueEntries(true)) {
      for (let start = 0; start < scanLimit; start += pageSize) {
        const end = Math.min(scanLimit - 1, start + pageSize - 1);
        const jobs = await entry.queue.getJobs([...states], start, end);
        scanned += jobs.length;

        const matching = jobs.filter((job) => taskIds.has(job.data?.taskId));
        await Promise.all(
          matching.map(async (job: Job) => {
            try {
              const taskId = job.data?.taskId;
              await job.remove();
              removed += 1;
              if (typeof taskId === "string" && taskId.length > 0) {
                removedTaskIds.add(taskId);
              }
            } catch (error) {
              if (isJobLockedRemovalError(error)) {
                return;
              }

              let state: string | undefined;
              try {
                state = await job.getState();
              } catch {
                state = undefined;
              }

              logger.warn(
                { queue: entry.queueName, jobId: job.id, state, err: error },
                "Failed to remove queued crawl job",
              );
            }
          }),
        );

        if (jobs.length < pageSize) {
          break;
        }
      }
    }

    return { scanned, removed, removedTaskIds: Array.from(removedTaskIds) };
  }

  async getJobCounts(): Promise<QueueCounts> {
    const [byQueue, legacyCounts] = await Promise.all([
      this.getJobCountsByQueue(),
      this.getLegacyJobCounts(),
    ]);
    const mergedPrimary = mergeCounts(byQueue.hot, byQueue.normal);
    return legacyCounts ? mergeCounts(mergedPrimary, legacyCounts) : mergedPrimary;
  }

  async getJobCountsByQueue(): Promise<Record<CrawlQueueClass, QueueCounts>> {
    const [hot, normal] = await Promise.all([
      this.hotQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "paused",
      ),
      this.normalQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "paused",
      ),
    ]);
    return {
      hot: hot as QueueCounts,
      normal: normal as QueueCounts,
    };
  }

  async pauseQueue(queueClass?: CrawlQueueClass) {
    if (queueClass) {
      await Promise.all(
        this.getQueueEntriesForClass(queueClass).map((entry) => entry.queue.pause()),
      );
      return;
    }
    await Promise.all(this.queueEntries(true).map((entry) => entry.queue.pause()));
  }

  async resumeQueue(queueClass?: CrawlQueueClass) {
    if (queueClass) {
      await Promise.all(
        this.getQueueEntriesForClass(queueClass).map((entry) => entry.queue.resume()),
      );
      return;
    }
    await Promise.all(this.queueEntries(true).map((entry) => entry.queue.resume()));
  }

  async isPaused(queueClass?: CrawlQueueClass) {
    if (queueClass) {
      const states = await Promise.all(
        this.getQueueEntriesForClass(queueClass).map((entry) => entry.queue.isPaused()),
      );
      return states.every(Boolean);
    }
    const all = await Promise.all(
      this.queueEntries(true).map((entry) => entry.queue.isPaused()),
    );
    return all.every(Boolean);
  }

  async getPausedByQueue(): Promise<Record<CrawlQueueClass, boolean>> {
    const [hot, normal] = await Promise.all([
      this.hotQueue.isPaused(),
      this.normalQueue.isPaused(),
    ]);
    return { hot, normal };
  }

  async setGlobalConcurrency(
    maxConcurrency: number,
    queueClass?: CrawlQueueClass,
  ) {
    const concurrency = this.sanitizeConcurrency(
      maxConcurrency,
      GLOBAL_CONCURRENCY_FALLBACK,
    );

    if (queueClass) {
      await Promise.all(
        this.getQueueEntriesForClass(queueClass).map(async (entry) => {
          const queueWithApi = this.asQueueWithGlobalConcurrencyApi(entry.queue);
          if (typeof queueWithApi.setGlobalConcurrency === "function") {
            await queueWithApi.setGlobalConcurrency(concurrency);
          }
        }),
      );
      return;
    }

    await Promise.all(
      this.queueEntries(true).map(async (entry) => {
        const queueWithApi = this.asQueueWithGlobalConcurrencyApi(entry.queue);
        if (typeof queueWithApi.setGlobalConcurrency === "function") {
          await queueWithApi.setGlobalConcurrency(concurrency);
        }
      }),
    );
  }

  async getGlobalConcurrency(queueClass?: CrawlQueueClass) {
    if (queueClass) {
      const queueWithApi = this.asQueueWithGlobalConcurrencyApi(
        this.getQueueEntry(queueClass).queue,
      );
      if (typeof queueWithApi.getGlobalConcurrency !== "function") {
        return null;
      }
      return queueWithApi.getGlobalConcurrency();
    }

    const values = Object.values(
      await this.getGlobalConcurrencyByQueue(),
    ).filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );
    if (values.length === 0) {
      return null;
    }
    return Math.max(...values);
  }

  async getGlobalConcurrencyByQueue(): Promise<
    Record<CrawlQueueClass, number | null>
  > {
    const [hot, normal] = await Promise.all([
      this.getGlobalConcurrency("hot"),
      this.getGlobalConcurrency("normal"),
    ]);
    return { hot, normal };
  }

  async getEffectiveConcurrency(queueClass?: CrawlQueueClass) {
    const settings = await this.crawlSettings.getSettings();
    if (queueClass) {
      const globalConcurrency = await this.getGlobalConcurrency(queueClass);
      return this.sanitizeConcurrency(
        globalConcurrency,
        settings.maxConcurrency,
      );
    }
    return this.sanitizeConcurrency(
      settings.maxConcurrency,
      settings.maxConcurrency,
    );
  }

  async getEffectiveConcurrencyByQueue(): Promise<
    Record<CrawlQueueClass, number>
  > {
    const settings = await this.crawlSettings.getSettings();
    const [hotGlobal, normalGlobal] = await Promise.all([
      this.getGlobalConcurrency("hot"),
      this.getGlobalConcurrency("normal"),
    ]);
    return {
      hot: this.sanitizeConcurrency(hotGlobal, settings.maxConcurrency),
      normal: this.sanitizeConcurrency(normalGlobal, settings.maxConcurrency),
    };
  }

  async getRuntimeStatsByQueue(): Promise<
    Record<CrawlQueueClass, CrawlQueueClassRuntimeStats>
  > {
    const [countsByQueue, pausedByQueue, effectiveByQueue] = await Promise.all([
      this.getJobCountsByQueue(),
      this.getPausedByQueue(),
      this.getEffectiveConcurrencyByQueue(),
    ]);

    return {
      hot: {
        queueName: CRAWL_QUEUE_HOT_NAME,
        counts: countsByQueue.hot,
        pending: sumPendingFromCounts(countsByQueue.hot),
        paused: pausedByQueue.hot,
        effectiveConcurrency: effectiveByQueue.hot,
      },
      normal: {
        queueName: CRAWL_QUEUE_NORMAL_NAME,
        counts: countsByQueue.normal,
        pending: sumPendingFromCounts(countsByQueue.normal),
        paused: pausedByQueue.normal,
        effectiveConcurrency: effectiveByQueue.normal,
      },
    };
  }

  async getLegacyJobCounts(): Promise<QueueCounts | null> {
    const entry = this.getLegacyQueueEntry();
    if (!entry) {
      return null;
    }
    const counts = await entry.queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "paused",
    );
    return counts as QueueCounts;
  }

  async getLegacyRuntimeStats(): Promise<CrawlQueueClassRuntimeStats | null> {
    const entry = this.getLegacyQueueEntry();
    if (!entry) {
      return null;
    }
    const [counts, paused, effectiveConcurrency] = await Promise.all([
      this.getLegacyJobCounts(),
      entry.queue.isPaused(),
      this.getEffectiveConcurrency("normal"),
    ]);
    if (!counts) {
      return null;
    }
    return {
      queueName: entry.queueName,
      counts,
      pending: sumPendingFromCounts(counts),
      paused,
      effectiveConcurrency,
    };
  }
}
