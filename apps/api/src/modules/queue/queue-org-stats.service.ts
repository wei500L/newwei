import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";

import { REDIS_CLIENT } from "../cache/cache.tokens";

import { ITEM_PIPELINE_QUEUE_NAME } from "./queue.constants";

export type TrackedJobStatus = "waiting" | "active" | "completed" | "failed" | "delayed";

interface JobMeta {
  orgId: string;
  status: TrackedJobStatus;
  keepCompleted: "0" | "1";
  keepFailed: "0" | "1";
}

const TRACKED_STATUSES: readonly TrackedJobStatus[] = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
];

const META_TTL_SECONDS = 60 * 60 * 24 * 7;
const COUNTS_TTL_SECONDS = 60 * 60 * 24 * 30;

function isTrackedStatus(status: unknown): status is TrackedJobStatus {
  return typeof status === "string" && (TRACKED_STATUSES as readonly string[]).includes(status);
}

@Injectable()
export class QueueOrgStatsService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async getCounts(orgId: string): Promise<Record<TrackedJobStatus, number>> {
    const key = this.countsKey(orgId);
    const raw = await this.redis.hmget(key, ...TRACKED_STATUSES);
    const parsed = raw.map((value) => {
      const num = value ? Number(value) : 0;
      return Number.isFinite(num) ? Math.max(0, num) : 0;
    });
    return {
      waiting: parsed[0] ?? 0,
      active: parsed[1] ?? 0,
      completed: parsed[2] ?? 0,
      failed: parsed[3] ?? 0,
      delayed: parsed[4] ?? 0,
    };
  }

  async getJobMeta(jobId: string): Promise<JobMeta | null> {
    const [orgId, status, keepCompleted, keepFailed] = await this.redis.hmget(
      this.metaKey(jobId),
      "orgId",
      "status",
      "keepCompleted",
      "keepFailed",
    );
    if (!orgId || !isTrackedStatus(status)) {
      return null;
    }
    return {
      orgId,
      status,
      keepCompleted: keepCompleted === "1" ? "1" : "0",
      keepFailed: keepFailed === "1" ? "1" : "0",
    };
  }

  async upsertJobMetaAndCount(params: {
    jobId: string;
    orgId: string;
    status: TrackedJobStatus;
    keepCompleted: boolean;
    keepFailed: boolean;
  }) {
    const keepCompleted = params.keepCompleted ? "1" : "0";
    const keepFailed = params.keepFailed ? "1" : "0";
    await this.redis.eval(
      UPSERT_AND_TRANSITION_LUA,
      2,
      this.metaKey(params.jobId),
      this.countsKey(params.orgId),
      params.status,
      params.orgId,
      keepCompleted,
      keepFailed,
      String(META_TTL_SECONDS),
      String(COUNTS_TTL_SECONDS),
    );
  }

  async transitionJob(jobMeta: JobMeta, jobId: string, newStatus: TrackedJobStatus) {
    if (jobMeta.status === newStatus) {
      return;
    }

    if (
      (newStatus === "completed" && jobMeta.keepCompleted !== "1") ||
      (newStatus === "failed" && jobMeta.keepFailed !== "1")
    ) {
      // Terminal status without retention: still record the +1 for the
      // terminal count (dashboards show completed/failed as counters), then
      // drop the job metadata so the counts stay accurate without leaking
      // per-job rows. Previously this path only decremented the old status,
      // so the completed counter was permanently 0 for default jobs.
      await this.redis.eval(
        TERMINAL_AND_REMOVE_LUA,
        2,
        this.metaKey(jobId),
        this.countsKey(jobMeta.orgId),
        newStatus,
        String(COUNTS_TTL_SECONDS),
      );
      return;
    }

    await this.redis.eval(
      UPSERT_AND_TRANSITION_LUA,
      2,
      this.metaKey(jobId),
      this.countsKey(jobMeta.orgId),
      newStatus,
      jobMeta.orgId,
      jobMeta.keepCompleted,
      jobMeta.keepFailed,
      String(META_TTL_SECONDS),
      String(COUNTS_TTL_SECONDS),
    );
  }

  async removeJob(orgId: string, jobId: string) {
    await this.redis.eval(
      REMOVE_JOB_LUA,
      2,
      this.metaKey(jobId),
      this.countsKey(orgId),
      String(COUNTS_TTL_SECONDS),
    );
  }

  private countsKey(orgId: string) {
    return `queue:${ITEM_PIPELINE_QUEUE_NAME}:org:${orgId}:counts`;
  }

  private metaKey(jobId: string) {
    return `queue:${ITEM_PIPELINE_QUEUE_NAME}:job:${jobId}:meta`;
  }
}

const UPSERT_AND_TRANSITION_LUA = `
  local metaKey = KEYS[1]
  local countsKey = KEYS[2]

  local newStatus = ARGV[1]
  local orgId = ARGV[2]
  local keepCompleted = ARGV[3]
  local keepFailed = ARGV[4]
  local metaTtl = tonumber(ARGV[5])
  local countsTtl = tonumber(ARGV[6])

  local oldStatus = redis.call('HGET', metaKey, 'status')

  if oldStatus ~= false and oldStatus == newStatus then
    redis.call('HSET', metaKey, 'orgId', orgId, 'keepCompleted', keepCompleted, 'keepFailed', keepFailed)
    redis.call('EXPIRE', metaKey, metaTtl)
    redis.call('EXPIRE', countsKey, countsTtl)
    return oldStatus
  end

  if oldStatus ~= false then
    redis.call('HINCRBY', countsKey, oldStatus, -1)
  end

  redis.call('HINCRBY', countsKey, newStatus, 1)
  redis.call('HSET', metaKey, 'orgId', orgId, 'status', newStatus, 'keepCompleted', keepCompleted, 'keepFailed', keepFailed)
  redis.call('EXPIRE', metaKey, metaTtl)
  redis.call('EXPIRE', countsKey, countsTtl)

  return oldStatus
`;

const REMOVE_JOB_LUA = `
  local metaKey = KEYS[1]
  local countsKey = KEYS[2]
  local countsTtl = tonumber(ARGV[1])

  local oldStatus = redis.call('HGET', metaKey, 'status')
  if oldStatus ~= false then
    redis.call('HINCRBY', countsKey, oldStatus, -1)
  end

  redis.call('DEL', metaKey)
  redis.call('EXPIRE', countsKey, countsTtl)
  return oldStatus
`;

const TERMINAL_AND_REMOVE_LUA = `
  local metaKey = KEYS[1]
  local countsKey = KEYS[2]
  local newStatus = ARGV[1]
  local countsTtl = tonumber(ARGV[2])

  local oldStatus = redis.call('HGET', metaKey, 'status')
  if oldStatus ~= false and oldStatus == newStatus then
    redis.call('DEL', metaKey)
    redis.call('EXPIRE', countsKey, countsTtl)
    return oldStatus
  end

  if oldStatus ~= false then
    redis.call('HINCRBY', countsKey, oldStatus, -1)
  end

  redis.call('HINCRBY', countsKey, newStatus, 1)
  redis.call('DEL', metaKey)
  redis.call('EXPIRE', countsKey, countsTtl)
  return oldStatus
`;
