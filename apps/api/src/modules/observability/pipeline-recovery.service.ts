import { ProcessedItemModel, RawItemModel, TaskLogModel } from "@modular/mongo";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";

import { ItemStatus } from "../../common/pipeline-status";
import { PrismaService } from "../config/prisma.service";
import { ITEM_PIPELINE_QUEUE_NAME } from "../queue/queue.constants";
import { QueueService } from "../queue/queue.service";

export interface PipelineRunStageSummary {
  stage: string;
  status: "pending" | "processing" | "completed" | "failed";
  at: string;
  error?: { name?: string; message?: string } | null;
}

export interface PipelineRunSummary {
  jobId: string;
  rawItemId: string;
  processedItemId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  stages: PipelineRunStageSummary[];
}

export interface PipelineRunsResponse {
  itemMetaId: string;
  itemStatus: string;
  mongoRef: string;
  runs: PipelineRunSummary[];
}

@Injectable()
export class PipelineRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async getRuns(orgId: string, itemMetaId: string, limit?: number): Promise<PipelineRunsResponse> {
    const normalizedLimitRaw =
      typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : 5;
    const normalizedLimit = Math.min(Math.max(normalizedLimitRaw, 1), 20);
    const itemMeta = await this.prisma.itemMeta.findFirst({
      where: { id: itemMetaId, orgId },
      select: { id: true, status: true, mongoRef: true },
    });
    if (!itemMeta) {
      throw new NotFoundException("Item not found");
    }

    const processed = await ProcessedItemModel.find(
      { orgId, itemMetaId },
      { rawItemId: 1, status: 1, createdAt: 1, updatedAt: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(normalizedLimit)
      .lean();

    const runs = processed.map((record) => {
      const rawItemId = record.rawItemId?.toString?.() ?? "";
      const processedItemId = (record as { _id?: unknown })._id?.toString?.() ?? "";
      const jobId = rawItemId ? `${itemMetaId}:${rawItemId}` : "";
      return {
        jobId,
        rawItemId,
        processedItemId,
        status: String((record as { status?: unknown }).status ?? "unknown"),
        createdAt: (record as { createdAt?: Date }).createdAt?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: (record as { updatedAt?: Date }).updatedAt?.toISOString?.() ?? new Date().toISOString(),
      };
    });

    const jobIds = runs.map((run) => run.jobId).filter((jobId) => jobId.length > 0);
    const logs = jobIds.length
      ? await TaskLogModel.find(
          { orgId, queue: ITEM_PIPELINE_QUEUE_NAME, jobId: { $in: jobIds } },
          { jobId: 1, stage: 1, status: 1, error: 1, createdAt: 1 },
        )
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const logsByJob = new Map<string, typeof logs>();
    for (const log of logs) {
      const jobId = typeof log.jobId === "string" ? log.jobId : "";
      if (!jobId) {
        continue;
      }
      const bucket = logsByJob.get(jobId) ?? [];
      bucket.push(log);
      logsByJob.set(jobId, bucket);
    }

    const summarizedRuns: PipelineRunSummary[] = runs.map((run) => {
      const jobLogs = logsByJob.get(run.jobId) ?? [];
      const latestByStage = new Map<string, (typeof jobLogs)[number]>();
      for (const log of jobLogs) {
        const stage = typeof log.stage === "string" ? log.stage : "unknown";
        latestByStage.set(stage, log);
      }
      const stages = Array.from(latestByStage.entries())
        .map(([stage, log]) => ({
          stage,
          status: String(log.status ?? "pending") as PipelineRunStageSummary["status"],
          at: (log.createdAt as Date | undefined)?.toISOString?.() ?? new Date().toISOString(),
          error: log.error
            ? {
                name:
                  typeof (log.error as { name?: unknown }).name === "string"
                    ? String((log.error as { name?: unknown }).name)
                    : undefined,
                message:
                  typeof (log.error as { message?: unknown }).message === "string"
                    ? String((log.error as { message?: unknown }).message)
                    : undefined,
              }
            : null,
        }))
        .sort((a, b) => a.stage.localeCompare(b.stage));

      return { ...run, stages };
    });

    return {
      itemMetaId: itemMeta.id,
      itemStatus: itemMeta.status,
      mongoRef: itemMeta.mongoRef,
      runs: summarizedRuns,
    };
  }

  async replay(orgId: string, itemMetaId: string, rawItemId?: string) {
    const itemMeta = await this.prisma.itemMeta.findFirst({
      where: { id: itemMetaId, orgId },
      select: { id: true, status: true, mongoRef: true },
    });
    if (!itemMeta) {
      throw new NotFoundException("Item not found");
    }
    if (itemMeta.status === ItemStatus.Duplicate) {
      throw new BadRequestException("Cannot replay duplicate item");
    }

    const sourceRawId = rawItemId?.trim() || itemMeta.mongoRef;
    if (!Types.ObjectId.isValid(sourceRawId)) {
      throw new BadRequestException("Invalid rawItemId");
    }
    const raw = await RawItemModel.findById(sourceRawId).lean();
    if (!raw) {
      throw new NotFoundException("Raw item not found");
    }
    if (raw.itemMetaId !== itemMetaId) {
      throw new BadRequestException("rawItemId does not belong to item");
    }

    const cloned = await RawItemModel.create({
      itemMetaId,
      payload: raw.payload,
      source: "replay",
    });
    const clonedId = cloned._id.toString();

    await this.prisma.itemMeta.update({
      where: { id: itemMetaId },
      data: {
        mongoRef: clonedId,
        status: ItemStatus.Pending,
      },
    });

    const job = await this.queueService.enqueueItem(orgId, itemMetaId, clonedId);

    return {
      itemMetaId,
      rawItemId: clonedId,
      queueJobId: job.id ? String(job.id) : undefined,
    };
  }

  async rollback(orgId: string, itemMetaId: string, rawItemId?: string) {
    const itemMeta = await this.prisma.itemMeta.findFirst({
      where: { id: itemMetaId, orgId },
      select: { id: true, status: true, mongoRef: true },
    });
    if (!itemMeta) {
      throw new NotFoundException("Item not found");
    }
    if (itemMeta.status === ItemStatus.Duplicate) {
      throw new BadRequestException("Cannot rollback duplicate item");
    }

    const sourceRawId = rawItemId?.trim() || itemMeta.mongoRef;
    if (!Types.ObjectId.isValid(sourceRawId)) {
      throw new BadRequestException("Invalid rawItemId");
    }
    const raw = await RawItemModel.findById(sourceRawId).lean();
    if (!raw) {
      throw new NotFoundException("Raw item not found");
    }
    if (raw.itemMetaId !== itemMetaId) {
      throw new BadRequestException("rawItemId does not belong to item");
    }

    await this.prisma.itemMeta.update({
      where: { id: itemMetaId },
      data: { status: ItemStatus.Pending },
    });

    const processedItemId = new Types.ObjectId();
    await ProcessedItemModel.updateOne(
      { _id: processedItemId },
      {
        $set: {
          rawItemId: new Types.ObjectId(sourceRawId),
          itemMetaId,
          orgId,
          status: "pending",
          updatedAt: new Date(),
        },
        $setOnInsert: {
          _id: processedItemId,
          createdAt: new Date(),
          tags: [],
        },
      },
      { upsert: true },
    );

    return {
      itemMetaId,
      rawItemId: sourceRawId,
      processedItemId: processedItemId.toHexString(),
    };
  }
}
