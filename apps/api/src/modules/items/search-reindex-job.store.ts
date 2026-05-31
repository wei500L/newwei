import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

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

@Injectable()
export class SearchReindexJobStore {
  private readonly jobs = new Map<string, SearchReindexJob>();

  create(orgId: string, now = new Date()): SearchReindexJob {
    this.prune(now.getTime());
    const timestamp = now.toISOString();
    const job: SearchReindexJob = {
      id: randomUUID(),
      orgId,
      status: "queued",
      indexed: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getForOrg(orgId: string, jobId: string): SearchReindexJob | null {
    this.prune();
    const job = this.jobs.get(jobId);
    if (!job || job.orgId !== orgId) {
      return null;
    }
    return job;
  }

  markRunning(jobId: string): SearchReindexJob | null {
    return this.update(jobId, {
      status: "running",
      updatedAt: new Date().toISOString(),
    });
  }

  markCompleted(jobId: string, indexed: number): SearchReindexJob | null {
    return this.update(jobId, {
      status: "completed",
      indexed,
      error: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  markFailed(jobId: string, error: string): SearchReindexJob | null {
    return this.update(jobId, {
      status: "failed",
      error,
      updatedAt: new Date().toISOString(),
    });
  }

  prune(now = Date.now()): void {
    for (const [jobId, job] of this.jobs.entries()) {
      const updatedAtMs = Date.parse(job.updatedAt);
      if (!Number.isFinite(updatedAtMs)) {
        this.jobs.delete(jobId);
        continue;
      }

      const ageMs = now - updatedAtMs;
      if (
        TERMINAL_STATUSES.has(job.status) &&
        ageMs >= SEARCH_REINDEX_TERMINAL_JOB_TTL_MS
      ) {
        this.jobs.delete(jobId);
        continue;
      }

      if (
        !TERMINAL_STATUSES.has(job.status) &&
        ageMs >= SEARCH_REINDEX_ACTIVE_JOB_MAX_AGE_MS
      ) {
        this.jobs.delete(jobId);
      }
    }

    this.evictExcessTerminalJobs();
  }

  private update(
    jobId: string,
    patch: Partial<Omit<SearchReindexJob, "id" | "orgId" | "createdAt">>,
  ): SearchReindexJob | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    Object.assign(job, patch);
    return job;
  }

  private evictExcessTerminalJobs(): void {
    const terminalJobs = Array.from(this.jobs.values())
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const excess = terminalJobs.length - SEARCH_REINDEX_MAX_RETAINED_JOBS;
    if (excess <= 0) {
      return;
    }

    for (const job of terminalJobs.slice(0, excess)) {
      this.jobs.delete(job.id);
    }
  }
}
