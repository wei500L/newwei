import { ConflictException, Injectable } from "@nestjs/common";

import { CacheService, type CacheLockLease } from "../cache/cache.service";

import { ItemsElasticsearchService } from "./items-elasticsearch.service";
import {
  SearchReindexJobStore,
  type SearchReindexJob,
} from "./search-reindex-job.store";

const SEARCH_REINDEX_LOCK_TTL_MS = 5 * 60_000;
const SEARCH_REINDEX_LOCK_CONFLICT = {
  code: "SEARCH_REINDEX_IN_PROGRESS",
  message: "Search reindex is already running for this organization.",
};

@Injectable()
export class SearchReindexService {
  constructor(
    private readonly elasticsearch: ItemsElasticsearchService,
    private readonly cache: CacheService,
    private readonly jobs: SearchReindexJobStore,
  ) {}

  async startReindex(orgId: string): Promise<SearchReindexJob> {
    const lease = await this.cache.tryAcquireLock(
      this.lockKey(orgId),
      SEARCH_REINDEX_LOCK_TTL_MS,
    );
    if (!lease) {
      throw new ConflictException(SEARCH_REINDEX_LOCK_CONFLICT);
    }

    let job: SearchReindexJob;
    try {
      job = await this.jobs.create(orgId);
    } catch (error) {
      await lease.release();
      throw error;
    }

    void this.runReindex(job.id, orgId, lease);
    return job;
  }

  async getReindexJob(
    orgId: string,
    jobId: string,
  ): Promise<SearchReindexJob | null> {
    return this.jobs.getForOrg(orgId, jobId);
  }

  private async runReindex(
    jobId: string,
    orgId: string,
    lease: CacheLockLease,
  ): Promise<void> {
    const stopRenew = lease.startAutoRenew();
    await this.jobs.markRunning(jobId);

    try {
      const result = await this.elasticsearch.reindexOrg(orgId);
      await this.jobs.markCompleted(jobId, result.indexed);
    } catch (error) {
      await this.jobs.markFailed(
        jobId,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      stopRenew();
      try {
        await lease.release();
      } catch {
        // best-effort
      }
      await this.jobs.prune();
    }
  }

  private lockKey(orgId: string): string {
    return `search:reindex:org:${orgId}`;
  }
}
