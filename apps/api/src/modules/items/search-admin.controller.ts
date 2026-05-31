import { Controller, Get, Param, Post } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { ItemsElasticsearchService } from "./items-elasticsearch.service";

interface SearchReindexJob {
  id: string;
  orgId: string;
  status: "queued" | "running" | "completed" | "failed";
  indexed: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const reindexJobs = new Map<string, SearchReindexJob>();

@Controller("admin/search")
export class SearchAdminController {
  constructor(private readonly elasticsearch: ItemsElasticsearchService) {}

  @Post("reindex")
  @Permissions("settings.manage")
  async reindex(@CurrentUser() user: AuthenticatedUser): Promise<SearchReindexJob> {
    const now = new Date().toISOString();
    const job: SearchReindexJob = {
      id: randomUUID(),
      orgId: user.orgId,
      status: "queued",
      indexed: 0,
      createdAt: now,
      updatedAt: now,
    };
    reindexJobs.set(job.id, job);
    void this.runReindex(job.id, user.orgId);
    return job;
  }

  @Get("reindex/:jobId")
  @Permissions("settings.manage")
  async getReindexJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param("jobId") jobId: string,
  ): Promise<SearchReindexJob | null> {
    const job = reindexJobs.get(jobId);
    if (!job || job.orgId !== user.orgId) {
      return null;
    }
    return job;
  }

  private async runReindex(jobId: string, orgId: string): Promise<void> {
    const job = reindexJobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    try {
      const result = await this.elasticsearch.reindexOrg(orgId);
      job.status = "completed";
      job.indexed = result.indexed;
      job.updatedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
    }
  }
}
