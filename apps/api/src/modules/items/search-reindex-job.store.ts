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

// Active jobs keep the long retention; a job that reached a terminal state
// switches to the short one. The organization list always keeps the active
// window so it can never expire before a job that may still be queried.
const ACTIVE_JOB_TTL_SECONDS = Math.ceil(
  SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS / 1000,
);
const TERMINAL_JOB_TTL_SECONDS = Math.ceil(
  SEARCH_REINDEX_TERMINAL_JOB_TTL_MS / 1000,
);

/**
 * Reindex job state lives in Redis (not process memory) so that:
 * - API instances can poll each other's job status in a horizontally scaled
 *   deployment;
 * - an instance restart does not orphan the job state while the Redis-backed
 *   reindex lock still exists.
 *
 * The key layout is shared with the Go searchreindex package:
 * `search:reindex:job:<jobId>`, `search:reindex:org:<orgId>` and
 * `search:reindex:orgs`.
 */
@Injectable()
export class SearchReindexJobStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async create(orgId: string, now = new Date()): Promise<SearchReindexJob> {
    await this.prune(orgId, now.getTime());
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
      ACTIVE_JOB_TTL_SECONDS,
    );
    await this.redis.sadd(REINDEX_ORGS_SET, orgId);
    await this.redis.rpush(this.orgKey(orgId), job.id);
    await this.redis.expire(this.orgKey(orgId), ACTIVE_JOB_TTL_SECONDS);
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

  /**
   * Persist the batch progress: a polling GET observes the real indexed count
   * while the rebuild runs instead of a final jump. The active TTL is refreshed
   * on every batch.
   */
  async updateProgress(
    jobId: string,
    indexed: number,
  ): Promise<SearchReindexJob | null> {
    return this.update(jobId, {
      indexed,
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

  /**
   * Move the job to failed while keeping every document that was actually
   * written: `indexed` is the running total, including the successful documents
   * of the batch that reported the failure.
   */
  async markFailed(
    jobId: string,
    error: string,
    indexed: number,
  ): Promise<SearchReindexJob | null> {
    return this.update(jobId, {
      status: "failed",
      indexed,
      error,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Clean the history of one organization only.
   *
   * The organization list is read once, the job payloads are batch loaded with
   * MGET, and a single pass classifies every id as expired, missing, over the
   * retention limit or valid. The over-limit budget is computed from the
   * filtered valid list and only terminal jobs are trimmed, so the current
   * queued/running job is never removed by history retention. Deletions use DEL
   * plus LREM, so a concurrent RPUSH append is preserved instead of being lost
   * by rewriting the list.
   */
  async prune(orgId: string, now = Date.now()): Promise<void> {
    const orgKey = this.orgKey(orgId);
    const jobIds = await this.redis.lrange(orgKey, 0, -1);
    if (jobIds.length === 0) {
      await this.redis.srem(REINDEX_ORGS_SET, orgId);
      return;
    }

    const payloads = await this.redis.mget(
      jobIds.map((jobId) => this.jobKey(jobId)),
    );
    const staleIds: string[] = [];
    const terminalIds: string[] = [];
    let validCount = 0;

    for (let index = 0; index < jobIds.length; index += 1) {
      const jobId = jobIds[index]!;
      const raw = payloads[index];
      if (typeof raw !== "string" || raw.length === 0) {
        staleIds.push(jobId);
        continue;
      }
      let job: SearchReindexJob;
      try {
        job = JSON.parse(raw) as SearchReindexJob;
      } catch {
        staleIds.push(jobId);
        continue;
      }
      const updatedAtMs = Date.parse(job.updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        staleIds.push(jobId);
        continue;
      }
      const ageMs = now - updatedAtMs;
      if (TERMINAL_STATUSES.has(job.status)) {
        if (ageMs >= SEARCH_REINDEX_TERMINAL_JOB_TTL_MS) {
          staleIds.push(jobId);
          continue;
        }
        terminalIds.push(jobId);
        validCount += 1;
        continue;
      }
      if (ageMs >= SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS) {
        staleIds.push(jobId);
        continue;
      }
      validCount += 1;
    }

    // jobIds is oldest first, so the leading terminal entries are the oldest
    // history records to drop.
    let excess = validCount - SEARCH_REINDEX_MAX_RETAINED_JOBS;
    for (
      let index = 0;
      excess > 0 && index < terminalIds.length;
      index += 1
    ) {
      staleIds.push(terminalIds[index]!);
      excess -= 1;
    }

    if (staleIds.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const jobId of staleIds) {
      pipeline.del(this.jobKey(jobId));
      pipeline.lrem(orgKey, 1, jobId);
    }
    await pipeline.exec();

    if (staleIds.length < jobIds.length) {
      return;
    }
    const remaining = await this.redis.llen(orgKey);
    if (remaining === 0) {
      await this.redis.srem(REINDEX_ORGS_SET, orgId);
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
        TERMINAL_STATUSES.has(job.status)
          ? TERMINAL_JOB_TTL_SECONDS
          : ACTIVE_JOB_TTL_SECONDS,
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
