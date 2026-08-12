import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { REDIS_CLIENT } from "../cache/cache.tokens";

export type SearchReindexJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface SearchReindexJob {
  id: string;
  orgId: string;
  status: SearchReindexJobStatus;
  indexed: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const SEARCH_REINDEX_TERMINAL_JOB_TTL_MS = 60 * 60_000;
export const SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS = 12 * 60 * 60_000;
export const SEARCH_REINDEX_MAX_RETAINED_JOBS = 200;

const TERMINAL_STATUSES = new Set<SearchReindexJobStatus>([
  "completed",
  "failed",
]);

const JOB_TTL_SECONDS = Math.ceil(SEARCH_REINDEX_TERMINAL_JOB_TTL_MS / 1000);

/**
 * Reindex job state lives in Redis (not process memory) so that:
 * - API instances can poll each other's job status in a horizontally scaled
 *   deployment;
 * - an instance restart does not orphan the job state while the Redis-backed
 *   reindex lock still exists.
 */
@Injectable()
export class SearchReindexJobStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async create(orgId: string, now = new Date()): Promise<SearchReindexJob> {
    await this.prune(now.getTime());
    const timestamp = now.toISOString();
    const job: SearchReindexJob = {
      id: randomUUID(),
      orgId,
      status: "queued",
      indexed: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.redis.set(
      this.jobKey(job.id),
      JSON.stringify(job),
      "EX",
      JOB_TTL_SECONDS,
    );
    await this.redis.sadd(REINDEX_ORGS_SET, orgId);
    await this.redis.rpush(this.orgKey(orgId), job.id);
    await this.redis.expire(this.orgKey(orgId), JOB_TTL_SECONDS);
    return job;
  }

  async getForOrg(
    orgId: string,
    jobId: string,
  ): Promise<SearchReindexJob | null> {
    const raw = await this.redis.get(this.jobKey(jobId));
    if (!raw) {
      return null;
    }
    try {
      const job = JSON.parse(raw) as SearchReindexJob;
      if (job.orgId !== orgId) {
        return null;
      }
      return job;
    } catch {
      return null;
    }
  }

  async markRunning(jobId: string): Promise<SearchReindexJob | null> {
    return this.update(jobId, {
      status: "running",
      updatedAt: new Date().toISOString(),
    });
  }

  async markCompleted(
    jobId: string,
    indexed: number,
  ): Promise<SearchReindexJob | null> {
    return this.update(jobId, {
      status: "completed",
      indexed,
      error: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  async markFailed(
    jobId: string,
    error: string,
  ): Promise<SearchReindexJob | null> {
    return this.update(jobId, {
      status: "failed",
      error,
      updatedAt: new Date().toISOString(),
    });
  }

  async prune(now = Date.now()): Promise<void> {
    const orgIds = await this.redis.smembers(REINDEX_ORGS_SET);
    for (const orgId of orgIds) {
      const jobIds = await this.redis.lrange(this.orgKey(orgId), 0, -1);
      if (jobIds.length === 0) {
        await this.redis.srem(REINDEX_ORGS_SET, orgId);
        continue;
      }

      const staleIds: string[] = [];
      for (const jobId of jobIds) {
        const raw = await this.redis.get(this.jobKey(jobId));
        if (!raw) {
          staleIds.push(jobId);
          continue;
        }
        try {
          const job = JSON.parse(raw) as SearchReindexJob;
          const updatedAtMs = Date.parse(job.updatedAt);
          if (!Number.isFinite(updatedAtMs)) {
            staleIds.push(jobId);
            continue;
          }
          const ageMs = now - updatedAtMs;
          if (
            TERMINAL_STATUSES.has(job.status) &&
            ageMs >= SEARCH_REINDEX_TERMINAL_JOB_TTL_MS
          ) {
            staleIds.push(jobId);
            continue;
          }
          if (
            !TERMINAL_STATUSES.has(job.status) &&
            ageMs >= SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS
          ) {
            staleIds.push(jobId);
          }
        } catch {
          staleIds.push(jobId);
        }
      }

      // Keep the newest SEARCH_REINDEX_MAX_RETAINED_JOBS entries per org.
      const retained = jobIds.length - staleIds.length;
      if (retained > SEARCH_REINDEX_MAX_RETAINED_JOBS) {
        const excess = retained - SEARCH_REINDEX_MAX_RETAINED_JOBS;
        staleIds.push(...jobIds.slice(0, excess));
      }

      for (const jobId of staleIds) {
        await this.redis.del(this.jobKey(jobId));
        await this.redis.lrem(this.orgKey(orgId), 1, jobId);
      }
    }
  }

  private async update(
    jobId: string,
    patch: Partial<Omit<SearchReindexJob, "id" | "orgId" | "createdAt">>,
  ): Promise<SearchReindexJob | null> {
    const raw = await this.redis.get(this.jobKey(jobId));
    if (!raw) {
      return null;
    }
    try {
      const job = { ...(JSON.parse(raw) as SearchReindexJob), ...patch };
      await this.redis.set(
        this.jobKey(jobId),
        JSON.stringify(job),
        "EX",
        JOB_TTL_SECONDS,
      );
      return job;
    } catch {
      return null;
    }
  }

  private jobKey(jobId: string) {
    return `search:reindex:job:${jobId}`;
  }

  private orgKey(orgId: string) {
    return `search:reindex:org:${orgId}`;
  }
}

const REINDEX_ORGS_SET = "search:reindex:orgs";
