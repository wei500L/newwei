import {
  MapTransportObjectStateModel,
  MapTransportTrackPointModel,
  AnalysisResultModel,
  type AnalysisResultDocument,
} from "@modular/mongo";
import { NotificationPresentationKind , createLogger, ensureTraceId, getCurrentTraceId } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
// eslint-disable-next-line import/no-unresolved
import { NotificationType } from "@prisma/client";
import type { Queue } from "bullmq";
import type { PubSubEngine } from "graphql-subscriptions";
import { randomUUID } from "node:crypto";

import { EnvService } from "../config/config.service";
import {
  LiteLlmService,
  type LiteLlmMessage,
} from "../news-pipeline/litellm.service";
import { NotificationsService } from "../notifications/notifications.service";

import { AnalysisPromptService } from "./analysis-prompt.service";
import { ANALYSIS_QUEUE } from "./analysis.constants";
import {
  getPartialSummaryFromError,
  AnalysisStreamError,
} from "./analysis.errors";
import { ANALYSIS_PUBSUB } from "./analysis.pubsub";
import type {
  AnalysisJobPayload,
  AnomalyInput,
  CorrelationInput,
  GeoTransportInput,
} from "./analysis.types";

const logger = createLogger({ name: "analysis-service" });
const MAX_TRACK_POINTS_PER_OBJECT = 30;

@Injectable()
export class AnalysisService {
  constructor(
    private readonly llm: LiteLlmService,
    private readonly env: EnvService,
    private readonly prompts: AnalysisPromptService,
    @Inject(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJobPayload>,
    @Inject(ANALYSIS_PUBSUB) private readonly pubsub: PubSubEngine,
    private readonly notifications: NotificationsService,
  ) {}

  async submitCorrelation(
    orgId: string,
    input: CorrelationInput,
    triggeredById?: string,
  ) {
    const record = await AnalysisResultModel.create({
      orgId,
      type: "correlation",
      status: "pending",
      input,
      triggeredById,
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "correlation",
      { type: "correlation", analysisId: record.id, orgId, traceId },
      {
        jobId: `corr-${record.id}`,
        removeOnComplete: true,
        attempts: this.env.analysisConfig.maxRetries,
      },
    );
    return record;
  }

  async submitAnomaly(
    orgId: string,
    input: AnomalyInput,
    triggeredById?: string,
  ) {
    const record = await AnalysisResultModel.create({
      orgId,
      type: "anomaly",
      status: "pending",
      input,
      triggeredById,
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "anomaly",
      { type: "anomaly", analysisId: record.id, orgId, traceId },
      {
        jobId: `anomaly-${record.id}`,
        removeOnComplete: true,
        attempts: this.env.analysisConfig.maxRetries,
      },
    );
    return record;
  }

  async submitGeoTransport(
    orgId: string,
    input: GeoTransportInput,
    triggeredById?: string,
  ) {
    const record = await AnalysisResultModel.create({
      orgId,
      type: "geo_transport",
      status: "pending",
      input,
      triggeredById,
    });
    const traceId = ensureTraceId(getCurrentTraceId());
    await this.queue.add(
      "geo_transport",
      { type: "geo_transport", analysisId: record.id, orgId, traceId },
      {
        jobId: `geo-transport-${record.id}`,
        removeOnComplete: true,
        attempts: this.env.analysisConfig.maxRetries,
      },
    );
    return record;
  }

  async listResults(orgId: string, limit = 50) {
    // Clamp the limit: run records carry full input/output JSON documents and
    // an unbounded limit is a memory/response amplification vector.
    const cappedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    return AnalysisResultModel.find({ orgId })
      .sort({ createdAt: -1 })
      .limit(cappedLimit)
      .lean();
  }

  /**
   * Claims and executes one analysis job.
   *
   * runToken is the BullMQ lock token of this attempt. It is written to the
   * record as a fencing token: every terminal update is conditional on it, so
   * a worker that lost its lease cannot overwrite the result of a newer
   * attempt. A running record is claimable again because BullMQ stalled
   * recovery re-delivers the job after the crashed worker's lock expires
   * (GAP-ANALYSIS-001); only the worker that received the current job can reach
   * this method with the matching token.
   */
  async process(job: AnalysisJobPayload, runToken?: string) {
    const token =
      typeof runToken === "string" && runToken.trim().length > 0
        ? runToken
        : randomUUID();
    const record = await AnalysisResultModel.findOneAndUpdate(
      {
        _id: job.analysisId,
        type: job.type,
        ...(job.orgId ? { orgId: job.orgId } : {}),
        status: { $in: ["pending", "failed", "running"] },
      },
      {
        $set: { status: "running", runToken: token },
        $unset: { error: 1 },
      },
      { new: true },
    );
    if (!record) {
      logger.warn({ job }, "Analysis record not claimable");
      return;
    }
    // A legacy payload may omit orgId; when present it must identify the
    // record's organization. A mismatch must not touch or notify another
    // tenant's result.
    if (job.orgId && job.orgId !== record.orgId) {
      logger.warn(
        { jobId: job.analysisId, jobOrgId: job.orgId },
        "Analysis job org does not match the result record",
      );
      return;
    }
    const createdAt = record.createdAt
      ? new Date(record.createdAt)
      : new Date();
    await this.publish(
      record.orgId,
      record.id,
      record.type,
      record.status,
      undefined,
      createdAt,
    );

    try {
      let output: { summary: string };
      if (job.type === "correlation") {
        output = await this.runCorrelation(
          record.orgId,
          record.id,
          createdAt,
          record.input as CorrelationInput,
        );
      } else if (job.type === "anomaly") {
        output = await this.runAnomaly(
          record.orgId,
          record.id,
          createdAt,
          record.input as AnomalyInput,
        );
      } else {
        output = await this.runGeoTransport(
          record.orgId,
          record.id,
          createdAt,
          record.input as GeoTransportInput,
        );
      }
      const completed = await AnalysisResultModel.findOneAndUpdate(
        {
          _id: record._id,
          runToken: token,
          status: "running",
        },
        {
          $set: {
            status: "completed",
            output,
            summary: output.summary ?? "",
          },
          // A retried run may carry an error from an earlier failed attempt;
          // clear it so consumers never see "completed with an error".
          $unset: { error: 1 },
        },
        { new: true },
      );
      if (!completed) {
        // The lease was superseded (or another attempt completed the run).
        // Never publish a second terminal event or notify from a stale token.
        logger.warn(
          { jobId: job.analysisId },
          "Analysis completion ignored: run token no longer owns the record",
        );
        return;
      }
      await this.publish(
        completed.orgId,
        completed.id,
        completed.type,
        completed.status,
        completed.summary ?? undefined,
        createdAt,
      );
      await this.notifyResult(completed);
    } catch (error: unknown) {
      logger.error({ job, error }, "Analysis job failed");
      const message = error instanceof Error ? error.message : String(error);
      const partialSummary = getPartialSummaryFromError(error);
      const update: { status: "failed"; error: string; summary?: string } = {
        status: "failed",
        error: message,
      };
      if (partialSummary) {
        update.summary = partialSummary;
      }
      const failed = await AnalysisResultModel.findOneAndUpdate(
        {
          _id: record._id,
          runToken: token,
          status: "running",
        },
        { $set: update },
        { new: true },
      );
      if (!failed) {
        logger.warn(
          { jobId: job.analysisId },
          "Analysis failure ignored: run token no longer owns the record",
        );
        throw error;
      }
      await this.publish(
        failed.orgId,
        failed.id,
        failed.type,
        failed.status,
        failed.summary ?? undefined,
        createdAt,
        failed.error ?? undefined,
      );
      // Failure notifications are sent once by the worker's failed handler on
      // the final attempt only; notifying here would fire once per retry.
      throw error;
    }
  }

  /**
   * Advances the terminal state of a job that BullMQ finalized as unrecoverable
   * without calling process() again (stalled recovery exceeded the allowable
   * limit).
   *
   * The row is still running under the token of the crashed attempt. The
   * current job holds a fresh BullMQ lock, so this attempt may take the row
   * over: the update is conditional on status=running and writes the current
   * token, which fences any later write from the old attempt. A row that is
   * already failed only receives the single final notification; a completed row
   * is never touched.
   */
  async finalizeStalledFailure(
    job: AnalysisJobPayload,
    runToken: string | undefined,
    reason: string,
  ) {
    // Always install a fresh token: leaving the crashed attempt's token in
    // place would let its stale Mongo write still match the fencing filter.
    const token =
      typeof runToken === "string" && runToken.trim().length > 0
        ? runToken
        : randomUUID();
    const failedUpdate: {
      status: "failed";
      error: string;
      runToken: string;
    } = { status: "failed", error: reason, runToken: token };
    const record = await AnalysisResultModel.findOneAndUpdate(
      {
        _id: job.analysisId,
        type: job.type,
        ...(job.orgId ? { orgId: job.orgId } : {}),
        status: "running",
      },
      { $set: failedUpdate },
      { new: true },
    );
    if (record) {
      const createdAt = record.createdAt
        ? new Date(record.createdAt)
        : new Date();
      await this.publish(
        record.orgId,
        record.id,
        record.type,
        "failed",
        record.summary ?? undefined,
        createdAt,
        reason,
      );
      await this.notifyFinalFailure(job.analysisId);
      return;
    }
    const existing = await AnalysisResultModel.findById(job.analysisId)
      .select({ status: 1 })
      .lean();
    if (!existing || existing.status !== "failed") {
      return;
    }
    // The row was already failed by an earlier attempt. Refresh the fencing
    // token so that attempt's stale completion write cannot match either.
    await AnalysisResultModel.updateOne(
      { _id: job.analysisId, status: "failed" },
      { $set: { runToken: token } },
    );
    await this.notifyFinalFailure(job.analysisId);
  }

  /**
   * Sends the failure notification for a run that exhausted its retries.
   * Called by the processor's failed handler when attempts are used up, so a
   * transient failure is not announced multiple times.
   */
  async notifyFinalFailure(analysisId: string) {
    const record = await AnalysisResultModel.findById(analysisId).lean();
    if (!record) {
      return;
    }
    // With lease fencing a stale attempt can reach the worker's failed event
    // after a newer attempt has taken the record over. Only a record that is
    // actually failed may produce the one final user notification.
    if (record.status !== "failed") {
      return;
    }
    const status = "failed";
    const analysisRecord = {
      orgId: record.orgId,
      triggeredById: record.triggeredById,
      status,
      error: (record as { error?: unknown }).error ?? "Analysis job failed",
      type: record.type,
      summary: record.summary,
      id: (record as { id?: unknown }).id ?? analysisId,
    };
    if (!analysisRecord.triggeredById) {
      return;
    }
    try {
      await this.notifications.notify({
        orgId: analysisRecord.orgId,
        userId: analysisRecord.triggeredById,
        type: NotificationType.analysis_failed,
        title: `${analysisRecord.type} analysis failed`,
        body:
          typeof analysisRecord.error === "string"
            ? analysisRecord.error
            : "Analysis job failed",
        data: {
          analysisId,
          status,
          type: analysisRecord.type,
          presentation: {
            kind: NotificationPresentationKind.AnalysisFailed,
          },
        },
      });
    } catch (error) {
      logger.warn({ error, analysisId }, "Failed to send analysis failure notification");
    }
  }

  private async notifyResult(record: AnalysisResultDocument) {
    if (!record.triggeredById) {
      return;
    }
    const analysisId =
      (record.id as string | undefined) ?? record._id?.toString?.() ?? "";
    try {
      await this.notifications.notify({
        orgId: record.orgId,
        userId: record.triggeredById,
        type:
          record.status === "completed"
            ? NotificationType.analysis_completed
            : NotificationType.analysis_failed,
        title: `${record.type} analysis ${record.status}`,
        body:
          record.status === "completed"
            ? (record.summary ?? undefined)
            : (record.error ?? "Analysis job failed"),
        data: {
          analysisId,
          status: record.status,
          type: record.type,
          presentation: {
            kind:
              record.status === "completed"
                ? NotificationPresentationKind.AnalysisCompleted
                : NotificationPresentationKind.AnalysisFailed,
            params: {
              analysisId,
              analysisType: record.type,
              ...(record.status === "completed" && record.summary
                ? { summary: record.summary }
                : {}),
            },
            ...(record.status === "failed" && record.error
              ? { technicalDetail: record.error }
              : {}),
          },
        },
      });
    } catch (error) {
      logger.warn(
        { analysisId, error },
        "Failed to send analysis notification",
      );
    }
  }

  private async runCorrelation(
    orgId: string,
    analysisId: string,
    createdAt: Date,
    input: CorrelationInput,
  ) {
    const messages = this.prompts.buildCorrelationMessages(input);
    const { summary, raw } = await this.streamMessages(
      orgId,
      analysisId,
      "correlation",
      createdAt,
      messages,
    );
    return { summary, raw };
  }

  private async runAnomaly(
    orgId: string,
    analysisId: string,
    createdAt: Date,
    input: AnomalyInput,
  ) {
    const { messages, statisticalFindings, statsSummary } =
      this.prompts.buildAnomalyMessages(input);
    const prefix = statisticalFindings.length
      ? `统计检测：\n${statsSummary}\n\n`
      : "";
    const { summary: content, raw } = await this.streamMessages(
      orgId,
      analysisId,
      "anomaly",
      createdAt,
      messages,
      prefix,
    );
    return { summary: content, raw, statisticalFindings };
  }

  private async runGeoTransport(
    orgId: string,
    analysisId: string,
    createdAt: Date,
    input: GeoTransportInput,
  ) {
    const context = await this.buildGeoTransportContext(orgId, input);
    const { promptVersion, messages } = this.prompts.buildGeoTransportMessages(
      input,
      context,
    );
    const { summary, raw } = await this.streamMessages(
      orgId,
      analysisId,
      "geo_transport",
      createdAt,
      messages,
    );
    return {
      summary,
      raw,
      promptVersion,
      context,
    };
  }

  private async buildGeoTransportContext(
    orgId: string,
    input: GeoTransportInput,
  ) {
    const entityKinds = input.transportKinds.length > 0
      ? input.transportKinds
      : (["aircraft", "vessel"] as const);
    const bbox =
      Array.isArray(input.bbox) && input.bbox.length === 4
        ? input.bbox
        : undefined;
    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);
    const stateFilter: Record<string, unknown> = {
      orgId,
      entityKind: { $in: entityKinds },
      // Only consider objects observed inside the requested window: without
      // this, "latest position" can come from after the analysis window (or
      // from arbitrarily old data) and skew the LLM's conclusions.
      observedAt: { $gte: startDate, $lte: endDate },
    };
    if (bbox) {
      const [minLng, minLat, maxLng, maxLat] = bbox;
      stateFilter.lng = { $gte: minLng, $lte: maxLng };
      stateFilter.lat = { $gte: minLat, $lte: maxLat };
    }
    if (input.objectKeys && input.objectKeys.length > 0) {
      stateFilter.objectKey = { $in: input.objectKeys.slice(0, 20) };
    }

    const states = await MapTransportObjectStateModel.find(stateFilter)
      .sort({ observedAt: -1 })
      .limit(20)
      .lean();
    const objectKeys = Array.from(
      new Set(
        states
          .map((state) =>
            typeof state.objectKey === "string" ? state.objectKey.trim() : "",
          )
          .filter((objectKey) => objectKey.length > 0),
      ),
    );
    const trackPointsByObjectKey = await this.loadTrackPointsByObjectKeys(orgId, objectKeys, {
      endDate,
      startDate,
    });
    const missingObjectKeys = objectKeys.filter(
      (objectKey) => (trackPointsByObjectKey.get(objectKey)?.length ?? 0) === 0,
    );
    const fallbackTrackPointsByObjectKey =
      missingObjectKeys.length > 0
        ? await this.loadTrackPointsByObjectKeys(orgId, missingObjectKeys, {
            startDate,
            endDate,
          })
        : new Map<string, Record<string, unknown>[]>();

    const objects = states.map((state) => {
      const primaryPoints = trackPointsByObjectKey.get(state.objectKey);
      const points =
        primaryPoints && primaryPoints.length > 0
          ? primaryPoints
          : (fallbackTrackPointsByObjectKey.get(state.objectKey) ?? []);

      return {
        objectKey: state.objectKey,
        entityKind: state.entityKind,
        sourceScope: state.sourceScope,
        name:
          state.entityKind === "aircraft"
            ? state.callsign ?? state.registration ?? state.icao24 ?? state.objectKey
            : state.name ?? state.mmsi ?? state.objectKey,
        displayCategory: state.displayCategory ?? null,
        displayCategoryZh: state.displayCategoryZh ?? null,
        role: state.role ?? null,
        roleZh: state.roleZh ?? null,
        shipTypeLabel: state.shipTypeLabel ?? null,
        shipTypeLabelZh: state.shipTypeLabelZh ?? null,
        countryCode: state.countryCode ?? null,
        countryName: state.countryName ?? null,
        latestObservedAt:
          state.observedAt instanceof Date
            ? state.observedAt.toISOString()
            : new Date(state.observedAt).toISOString(),
        latestPosition: {
          lat: state.lat,
          lng: state.lng,
          heading: state.heading ?? null,
          course: state.course ?? null,
          speed: state.speed ?? null,
          altitudeFt: state.altitudeFt ?? null,
        },
        trackPoints: points.map((point) => ({
          trackPointId: point._id?.toString?.() ?? "",
          observedAt:
            point.observedAt instanceof Date
              ? point.observedAt.toISOString()
              : new Date(point.observedAt as string | number | Date).toISOString(),
          lat: Number(point.lat),
          lng: Number(point.lng),
          heading:
            typeof point.heading === "number" && Number.isFinite(point.heading)
              ? point.heading
              : null,
          course:
            typeof point.course === "number" && Number.isFinite(point.course)
              ? point.course
              : null,
          speed:
            typeof point.speed === "number" && Number.isFinite(point.speed)
              ? point.speed
              : null,
          altitudeFt:
            typeof point.altitudeFt === "number" && Number.isFinite(point.altitudeFt)
              ? point.altitudeFt
              : null,
          geoCell: typeof point.geoCell === "string" ? point.geoCell : null,
        })),
      };
    });

    const geoCellCounts = new Map<string, number>();
    const trackPointIds: string[] = [];
    for (const object of objects) {
      for (const point of object.trackPoints) {
        if (point.trackPointId) {
          trackPointIds.push(point.trackPointId);
        }
        if (point.geoCell) {
          geoCellCounts.set(
            point.geoCell,
            (geoCellCounts.get(point.geoCell) ?? 0) + 1,
          );
        }
      }
    }

    return {
      filters: {
        transportKinds: entityKinds,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(bbox ? { bbox } : {}),
        ...(input.objectKeys?.length ? { requestedObjectKeys: input.objectKeys } : {}),
      },
      objectKeys: objects.map((object) => object.objectKey),
      trackPointIds,
      hotspots: Array.from(geoCellCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 10)
        .map(([geoCell, count]) => ({ geoCell, count })),
      objects,
    };
  }

  private async loadTrackPointsByObjectKeys(
    orgId: string,
    objectKeys: string[],
    range?: {
      startDate: Date;
      endDate: Date;
    },
  ) {
    if (objectKeys.length === 0) {
      return new Map<string, Record<string, unknown>[]>();
    }

    const match: Record<string, unknown> = {
      orgId,
      objectKey: { $in: objectKeys },
    };
    if (range) {
      match.observedAt = {
        $gte: range.startDate,
        $lte: range.endDate,
      };
    }

    const rows = await MapTransportTrackPointModel.aggregate<{
      _id: string;
      points?: Record<string, unknown>[];
    }>([
      { $match: match },
      {
        $project: {
          _id: 1,
          objectKey: 1,
          observedAt: 1,
          lat: 1,
          lng: 1,
          heading: 1,
          course: 1,
          speed: 1,
          altitudeFt: 1,
          geoCell: 1,
        },
      },
      { $sort: { objectKey: 1, observedAt: -1 } },
      {
        $group: {
          _id: "$objectKey",
          points: { $push: "$$ROOT" },
        },
      },
      {
        $project: {
          points: { $slice: ["$points", MAX_TRACK_POINTS_PER_OBJECT] },
        },
      },
    ]);

    return new Map(
      rows.map((row) => [row._id, Array.isArray(row.points) ? row.points : []]),
    );
  }

  private async streamMessages(
    orgId: string,
    analysisId: string,
    type: string,
    createdAt: Date,
    messages: LiteLlmMessage[],
    initialChunk?: string,
  ): Promise<{ summary: string; raw: Record<string, unknown> }> {
    const flushChars = Math.max(
      1,
      Number(this.env.analysisConfig.streamFlushChars ?? 80),
    );
    const flushMs = Math.max(
      0,
      Number(this.env.analysisConfig.streamFlushMs ?? 250),
    );

    let buffer = "";
    let summary = "";
    let lastModel: string | undefined;
    let lastFlushAt = Date.now();

    const flush = async () => {
      if (!buffer) {
        return;
      }
      const chunk = buffer;
      buffer = "";
      summary += chunk;
      lastFlushAt = Date.now();
      await this.publish(orgId, analysisId, type, "running", chunk, createdAt);
    };

    try {
      if (initialChunk) {
        buffer += initialChunk;
        await flush();
      }
      for await (const chunk of this.llm.stream({
        orgId,
        messages,
        timeoutMs: this.env.analysisConfig.llmTimeoutMs,
      })) {
        if (typeof chunk.model === "string") {
          lastModel = chunk.model;
        }
        if (typeof chunk.delta !== "string" || chunk.delta.length === 0) {
          continue;
        }
        buffer += chunk.delta;
        const now = Date.now();
        if (buffer.length >= flushChars || now - lastFlushAt >= flushMs) {
          await flush();
        }
      }
      await flush();
      return { summary, raw: { stream: true, model: lastModel } };
    } catch (error: unknown) {
      try {
        await flush();
      } catch (flushError) {
        logger.warn(
          { flushError },
          "Failed to flush partial summary after stream error",
        );
      }
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      const streamError = new AnalysisStreamError(normalized.message, summary, {
        cause: normalized,
      });
      streamError.stack = normalized.stack;
      throw streamError;
    }
  }

  private async publish(
    orgId: string,
    id: string,
    type: string,
    status: string,
    summary?: string,
    createdAt?: Date,
    error?: string,
  ) {
    await this.pubsub.publish("analysisEvents", {
      orgId,
      result: {
        id,
        type,
        status,
        summary,
        error,
        createdAt: (createdAt ?? new Date()).toISOString(),
      },
    });
  }
}
