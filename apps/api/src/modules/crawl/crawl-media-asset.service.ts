import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import {
  CrawlImageStorageProvider as PrismaCrawlImageStorageProvider,
  Prisma
} from "@prisma/client";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { settleWithConcurrency } from "../../common/multi-tenant-scheduler";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { StorageSettingsService } from "../storage/storage-settings.service";
import { type CrawlImageStorageProvider } from "../storage/storage.constants";
import { StorageService } from "../storage/storage.service";

import type { CrawlStoredMediaAsset } from "./crawl.types";

const logger = createLogger({ name: "crawl-media-asset-service" });
const MIN_SIGNED_URL_TTL_SECONDS = 30;
const MAX_SIGNED_URL_TTL_SECONDS = 86_400;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const DEFAULT_BINARY_CONTENT_TYPE = "application/octet-stream";
const CRAWL_MEDIA_ASSET_SIGN_CONCURRENCY = 8;
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const CONTENT_TYPE_ALIASES = new Map<string, string>([
  ["image/jpg", "image/jpeg"],
  ["image/svg", "image/svg+xml"],
  ["audio/mp3", "audio/mpeg"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["svg", "image/svg+xml"],
  ["svg+xml", "image/svg+xml"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["ogg", "audio/ogg"],
  ["wav", "audio/wav"],
  ["mp3", "audio/mpeg"],
  ["mpeg", "audio/mpeg"],
  ["aac", "audio/aac"],
  ["flac", "audio/flac"]
]);
const INLINE_PREVIEW_IMAGE_CONTENT_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp"
]);
const INLINE_PREVIEW_VIDEO_CONTENT_TYPES = new Set<string>([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime"
]);
const INLINE_PREVIEW_AUDIO_CONTENT_TYPES = new Set<string>([
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/aac",
  "audio/flac"
]);

interface PersistCrawlMediaAssetInput {
  orgId: string;
  taskId: string;
  resultId: string;
  kind: string;
  sourceUrl: string;
  bytes: number;
  data: Buffer;
  contentType?: string;
  width?: number;
  height?: number;
  alt?: string;
  title?: string;
  desc?: string;
  poster?: string;
  format?: string;
  metadata?: Record<string, unknown>;
}

export type CrawlMediaAccessMode = "preview" | "download";

export interface CrawlMediaAccessScope {
  orgId: string;
  userId: string;
}

export interface CrawlMediaVerifyAccessInput {
  assetId: string;
  mode: CrawlMediaAccessMode;
  expiresAtMs: string | number | undefined;
  signature: string | undefined;
  orgId: string | undefined;
  userId: string | undefined;
}

export interface CrawlMediaVerifyAccessResult {
  ok: boolean;
  reason?: string;
}

export interface CrawlMediaDeliveryPayload {
  contentType: string;
  inlineSafe: boolean;
  bytes: number;
  fileName: string;
  redirectUrl?: string;
  data?: Buffer;
}

const CRAWL_MEDIA_ASSET_LIST_SELECT = {
  id: true,
  resultId: true,
  provider: true,
  kind: true,
  sourceUrl: true,
  bytes: true,
  contentType: true,
  storageKey: true,
  width: true,
  height: true,
  alt: true,
  title: true,
  desc: true,
  poster: true,
  format: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  orgId: true,
  taskId: true
} satisfies Prisma.CrawlMediaAssetSelect;

type CrawlMediaAssetRecord = Prisma.CrawlMediaAssetGetPayload<{
  select: typeof CRAWL_MEDIA_ASSET_LIST_SELECT;
}>;

@Injectable()
export class CrawlMediaAssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageSettings: StorageSettingsService,
    private readonly storage: StorageService,
    private readonly env: EnvService
  ) {}

  async storeAsset(input: PersistCrawlMediaAssetInput): Promise<void> {
    const provider = await this.storageSettings.getCrawlImageStorageProvider();
    const normalizedContentType = this.sanitizeStoredContentType(input.contentType);
    const normalizedInput: PersistCrawlMediaAssetInput = {
      ...input,
      contentType: normalizedContentType
    };
    const baseCreate = this.buildCreateData(normalizedInput, provider);

    if (provider === "s3") {
      const storageKey = this.buildStorageKey(normalizedInput);
      await this.storage.uploadObject({
        objectKey: storageKey,
        body: normalizedInput.data,
        contentType: normalizedContentType ?? DEFAULT_BINARY_CONTENT_TYPE,
        cacheControl: "public, max-age=31536000, immutable"
      });

      try {
        await this.prisma.crawlMediaAsset.create({
          data: {
            ...baseCreate,
            provider: "s3",
            storageKey,
            blobData: null
          }
        });
      } catch (error) {
        logger.error(
          {
            err: error,
            orgId: normalizedInput.orgId,
            taskId: normalizedInput.taskId,
            resultId: normalizedInput.resultId,
            sourceUrl: normalizedInput.sourceUrl,
            storageKey
          },
          "Failed to persist crawl media DB record after S3 upload"
        );
        try {
          await this.storage.deleteObject(storageKey);
        } catch (cleanupError) {
          logger.error(
            {
              err: cleanupError,
              orgId: normalizedInput.orgId,
              taskId: normalizedInput.taskId,
              resultId: normalizedInput.resultId,
              storageKey
            },
            "Failed to cleanup orphaned crawl media object in S3"
          );
        }
        throw error;
      }
      return;
    }

    try {
      await this.storeMysqlAsset(normalizedInput, baseCreate);
    } catch (error) {
      logger.error(
        {
          err: error,
          orgId: normalizedInput.orgId,
          taskId: normalizedInput.taskId,
          resultId: normalizedInput.resultId,
          sourceUrl: normalizedInput.sourceUrl
        },
        "Failed to persist crawl media blob to MySQL"
      );
      throw error;
    }
  }

  async listAssetsByResultIds(
    resultIds: string[],
    accessScope: CrawlMediaAccessScope
  ): Promise<Map<string, CrawlStoredMediaAsset[]>> {
    if (resultIds.length === 0) {
      return new Map();
    }

    const records = await this.prisma.crawlMediaAsset.findMany({
      where: { resultId: { in: resultIds } },
      orderBy: { createdAt: "asc" },
      select: CRAWL_MEDIA_ASSET_LIST_SELECT
    });

    if (records.length === 0) {
      return new Map();
    }

    const ttlSeconds = await this.getSignedUrlTtlSeconds();
    const entries = await settleWithConcurrency(
      records,
      CRAWL_MEDIA_ASSET_SIGN_CONCURRENCY,
      async (record) => ({
        resultId: record.resultId,
        asset: await this.toCrawlStoredAsset(record, ttlSeconds, accessScope)
      })
    );
    for (const result of entries) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    const fulfilledEntries = entries
      .filter((result): result is Extract<(typeof entries)[number], { status: "fulfilled" }> => result.status === "fulfilled")
      .map((result) => result.value);

    const grouped = new Map<string, CrawlStoredMediaAsset[]>();
    for (const entry of fulfilledEntries) {
      const existing = grouped.get(entry.resultId);
      if (existing) {
        existing.push(entry.asset);
      } else {
        grouped.set(entry.resultId, [entry.asset]);
      }
    }
    return grouped;
  }

  async deleteAssetsByResultId(resultId: string): Promise<void> {
    const records = await this.prisma.crawlMediaAsset.findMany({
      where: { resultId },
      select: {
        id: true,
        blobId: true,
        storageKey: true,
        provider: true,
        orgId: true,
        taskId: true
      }
    });

    for (const record of records) {
      if (record.provider !== "s3" || !record.storageKey) {
        continue;
      }
      try {
        await this.storage.deleteObject(record.storageKey);
      } catch (error) {
        logger.error(
          {
            err: error,
            resultId,
            assetId: record.id,
            orgId: record.orgId,
            taskId: record.taskId,
            storageKey: record.storageKey
          },
          "Failed to cleanup S3 crawl media asset during rollback"
        );
      }
    }

    const mysqlBlobRefCounts = new Map<string, number>();
    for (const record of records) {
      if (record.provider !== "mysql" || !record.blobId) {
        continue;
      }
      mysqlBlobRefCounts.set(
        record.blobId,
        (mysqlBlobRefCounts.get(record.blobId) ?? 0) + 1,
      );
    }

    await this.prisma.runInTransaction(async (tx) => {
      await tx.crawlMediaAsset.deleteMany({
        where: { resultId }
      });

      for (const [blobId, refCount] of mysqlBlobRefCounts.entries()) {
        const blob = await tx.crawlMediaBlob.findUnique({
          where: { id: blobId },
          select: { refCount: true }
        });
        if (!blob) {
          continue;
        }
        if (blob.refCount <= refCount) {
          await tx.crawlMediaBlob.delete({
            where: { id: blobId }
          });
          continue;
        }
        await tx.crawlMediaBlob.update({
          where: { id: blobId },
          data: {
            refCount: {
              decrement: refCount
            }
          }
        });
      }
    });
  }

  verifySignedAssetAccess(input: CrawlMediaVerifyAccessInput): CrawlMediaVerifyAccessResult {
    if (!input.signature) {
      return { ok: false, reason: "Missing signature" };
    }

    const orgId = this.normalizeAccessScopeValue(input.orgId);
    const userId = this.normalizeAccessScopeValue(input.userId);
    if (!orgId || !userId) {
      return { ok: false, reason: "Missing access scope" };
    }

    const expiresAtMs = this.parseExpiresAt(input.expiresAtMs);
    if (!expiresAtMs) {
      return { ok: false, reason: "Invalid expires timestamp" };
    }

    if (expiresAtMs <= Date.now()) {
      return { ok: false, reason: "Signature expired" };
    }

    const maxFutureWindowMs = MAX_SIGNED_URL_TTL_SECONDS * 1000;
    if (expiresAtMs - Date.now() > maxFutureWindowMs) {
      return { ok: false, reason: "Signature window too large" };
    }

    const expected = this.signAssetAccess(input.assetId, input.mode, expiresAtMs, {
      orgId,
      userId
    });
    if (!this.safeCompareSignatures(expected, input.signature)) {
      return { ok: false, reason: "Invalid signature" };
    }

    return { ok: true };
  }

  async getAssetDeliveryPayload(
    assetId: string,
    mode: CrawlMediaAccessMode,
    accessScope: Pick<CrawlMediaAccessScope, "orgId">
  ): Promise<CrawlMediaDeliveryPayload | null> {
    const record = await this.prisma.crawlMediaAsset.findFirst({
      where: {
        id: assetId,
        orgId: accessScope.orgId
      },
      include: {
        blob: {
          select: {
            blobData: true
          }
        }
      }
    });
    if (!record) {
      return null;
    }

    const contentType = this.resolveDeliveryContentType(record.contentType);
    const inlineSafe = this.isInlinePreviewContentType(contentType);
    const fileName = this.buildAssetFileName(
      record.kind,
      record.id,
      contentType,
      record.format ?? undefined
    );

    if (record.provider === "mysql") {
      const blob = record.blob?.blobData
        ? Buffer.from(record.blob.blobData)
        : record.blobData
          ? Buffer.from(record.blobData)
          : null;
      if (!blob || blob.length === 0) {
        logger.error(
          {
            assetId: record.id,
            resultId: record.resultId,
            taskId: record.taskId,
            orgId: record.orgId
          },
          "MySQL crawl media asset is missing blob content"
        );
        return null;
      }
      return {
        contentType,
        inlineSafe,
        bytes: blob.length,
        fileName,
        data: blob
      };
    }

    if (!record.storageKey) {
      logger.error(
        {
          assetId: record.id,
          resultId: record.resultId,
          taskId: record.taskId,
          orgId: record.orgId
        },
        "S3 crawl media asset is missing storage key"
      );
      return null;
    }

    const responseDisposition =
      mode === "preview" && inlineSafe
        ? this.buildContentDisposition("inline", fileName)
        : this.buildContentDisposition("attachment", fileName);
    const redirectUrl = await this.storage.createObjectReadUrl(record.storageKey, {
      responseContentType: contentType,
      responseContentDisposition: responseDisposition,
      responseCacheControl: "private, max-age=300"
    });
    return {
      contentType,
      inlineSafe,
      bytes: record.bytes,
      fileName,
      redirectUrl
    };
  }

  private async storeMysqlAsset(
    input: PersistCrawlMediaAssetInput,
    baseCreate: ReturnType<CrawlMediaAssetService["buildCreateData"]>,
  ) {
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    await this.prisma.runInTransaction(async (tx) => {
      let blobId: string | null = null;
      const existingBlob = await tx.crawlMediaBlob.findUnique({
        where: {
          orgId_sha256: {
            orgId: input.orgId,
            sha256
          }
        },
        select: {
          id: true
        }
      });

      if (existingBlob) {
        blobId = existingBlob.id;
        await tx.crawlMediaBlob.update({
          where: {
            id: existingBlob.id
          },
          data: {
            refCount: {
              increment: 1
            }
          }
        });
      } else {
        try {
          const createdBlob = await tx.crawlMediaBlob.create({
            data: {
              orgId: input.orgId,
              sha256,
              bytes: input.bytes,
              contentType: input.contentType,
              blobData: input.data,
              refCount: 1
            },
            select: {
              id: true
            }
          });
          blobId = createdBlob.id;
        } catch (error) {
          if (!this.isUniqueConstraintError(error)) {
            throw error;
          }
          const racedBlob = await tx.crawlMediaBlob.findUniqueOrThrow({
            where: {
              orgId_sha256: {
                orgId: input.orgId,
                sha256
              }
            },
            select: {
              id: true
            }
          });
          blobId = racedBlob.id;
          await tx.crawlMediaBlob.update({
            where: {
              id: racedBlob.id
            },
            data: {
              refCount: {
                increment: 1
              }
            }
          });
        }
      }

      await tx.crawlMediaAsset.create({
        data: {
          ...baseCreate,
          provider: "mysql",
          blobId,
          blobData: null,
          storageKey: null
        }
      });
    });
  }

  private isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }

  private buildCreateData(input: PersistCrawlMediaAssetInput, provider: CrawlImageStorageProvider) {
    return {
      resultId: input.resultId,
      orgId: input.orgId,
      taskId: input.taskId,
      provider,
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      bytes: input.bytes,
      contentType: input.contentType,
      width: input.width,
      height: input.height,
      alt: input.alt,
      title: input.title,
      desc: input.desc,
      poster: input.poster,
      format: input.format,
      metadata: toPrismaJsonValue(input.metadata ?? {})
    };
  }

  private buildStorageKey(input: PersistCrawlMediaAssetInput): string {
    const ext = this.pickExtension(input.contentType);
    const suffix = ext ? `.${ext}` : "";
    return [
      "crawl-media",
      input.orgId,
      input.taskId,
      input.resultId,
      `${Date.now()}-${randomUUID()}${suffix}`
    ].join("/");
  }

  private pickExtension(contentType?: string) {
    if (!contentType) {
      return undefined;
    }
    const normalized = contentType.toLowerCase();
    if (normalized.includes("jpeg")) {
      return "jpg";
    }
    if (normalized.includes("png")) {
      return "png";
    }
    if (normalized.includes("webp")) {
      return "webp";
    }
    if (normalized.includes("gif")) {
      return "gif";
    }
    if (normalized.includes("svg")) {
      return "svg";
    }
    if (normalized.includes("mp4")) {
      return "mp4";
    }
    if (normalized.includes("webm")) {
      return "webm";
    }
    if (normalized.includes("mpeg")) {
      return "mp3";
    }
    return undefined;
  }

  private async toCrawlStoredAsset(
    record: CrawlMediaAssetRecord,
    ttlSeconds: number,
    accessScope: CrawlMediaAccessScope
  ): Promise<CrawlStoredMediaAsset> {
    const storageProvider = record.provider as PrismaCrawlImageStorageProvider;
    const contentType = this.resolveDeliveryContentType(record.contentType);
    const inlineSafe = this.isInlinePreviewContentType(contentType);
    const fileName = this.buildAssetFileName(
      record.kind,
      record.id,
      contentType,
      record.format ?? undefined
    );
    let previewUrl: string | undefined;
    let downloadUrl: string | undefined;

    if (storageProvider === "s3") {
      if (record.storageKey) {
        try {
          if (inlineSafe) {
            previewUrl = await this.storage.createObjectReadUrl(record.storageKey, {
              expiresInSeconds: ttlSeconds,
              responseContentType: contentType,
              responseContentDisposition: this.buildContentDisposition("inline", fileName),
              responseCacheControl: "private, max-age=300"
            });
          }
        } catch (error) {
          logger.warn(
            {
              err: error,
              assetId: record.id,
              resultId: record.resultId,
              taskId: record.taskId,
              storageKey: record.storageKey,
              mode: "preview"
            },
            "Failed to sign S3 crawl media URL"
          );
        }
        try {
          downloadUrl = await this.storage.createObjectReadUrl(record.storageKey, {
            expiresInSeconds: ttlSeconds,
            responseContentType: contentType,
            responseContentDisposition: this.buildContentDisposition("attachment", fileName),
            responseCacheControl: "private, max-age=300"
          });
        } catch (error) {
          logger.warn(
            {
              err: error,
              assetId: record.id,
              resultId: record.resultId,
              taskId: record.taskId,
              storageKey: record.storageKey,
              mode: "download"
            },
            "Failed to sign S3 crawl media URL"
          );
        }
      }
    } else {
      const expiresAtMs = Date.now() + ttlSeconds * 1000;
      previewUrl = inlineSafe
        ? this.buildSignedAssetUrl(record.id, "preview", expiresAtMs, accessScope)
        : undefined;
      downloadUrl = this.buildSignedAssetUrl(record.id, "download", expiresAtMs, accessScope);
    }

    return {
      id: record.id,
      kind: record.kind,
      sourceUrl: record.sourceUrl,
      bytes: record.bytes,
      contentType,
      storageProvider,
      storageKey: record.storageKey ?? undefined,
      previewUrl,
      downloadUrl,
      width: record.width ?? undefined,
      height: record.height ?? undefined,
      alt: record.alt ?? undefined,
      title: record.title ?? undefined,
      desc: record.desc ?? undefined,
      poster: record.poster ?? undefined,
      format: record.format ?? undefined,
      metadata: this.toMetadata(record.metadata)
    };
  }

  private resolveDeliveryContentType(value: string | null | undefined): string {
    return this.sanitizeStoredContentType(value ?? undefined) ?? DEFAULT_BINARY_CONTENT_TYPE;
  }

  private sanitizeStoredContentType(value: string | undefined): string | undefined {
    const normalized = this.normalizeContentType(value);
    if (!normalized) {
      return undefined;
    }
    if (
      normalized.startsWith("image/") ||
      normalized.startsWith("video/") ||
      normalized.startsWith("audio/")
    ) {
      return normalized;
    }
    return undefined;
  }

  private normalizeContentType(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    const normalized = value.split(";")[0]?.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    const canonical = CONTENT_TYPE_ALIASES.get(normalized) ?? normalized;
    if (!CONTENT_TYPE_PATTERN.test(canonical)) {
      return undefined;
    }
    return canonical;
  }

  private isInlinePreviewContentType(contentType: string): boolean {
    const normalized = this.normalizeContentType(contentType);
    if (!normalized) {
      return false;
    }
    return (
      INLINE_PREVIEW_IMAGE_CONTENT_TYPES.has(normalized) ||
      INLINE_PREVIEW_VIDEO_CONTENT_TYPES.has(normalized) ||
      INLINE_PREVIEW_AUDIO_CONTENT_TYPES.has(normalized)
    );
  }

  private buildAssetFileName(
    kind: string,
    id: string,
    contentType: string | undefined,
    format: string | undefined
  ): string {
    const extension = this.pickExtension(contentType) ?? this.pickExtension(format);
    const suffix = extension ? `.${extension}` : "";
    return `${kind}-${id}${suffix}`;
  }

  private buildContentDisposition(disposition: "inline" | "attachment", fileName: string): string {
    const escapedFileName = fileName.replace(/[\\"]/g, "_");
    return `${disposition}; filename="${escapedFileName}"`;
  }

  private toMetadata(value: Prisma.JsonValue): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private parseExpiresAt(value: string | number | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    if (typeof value !== "string") {
      return null;
    }
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed;
  }

  private safeCompareSignatures(expected: string, actual: string): boolean {
    const normalized = actual.trim();
    if (!normalized || normalized.length !== expected.length) {
      return false;
    }
    const left = Buffer.from(expected);
    const right = Buffer.from(normalized);
    return timingSafeEqual(left, right);
  }

  private buildSignedAssetUrl(
    assetId: string,
    mode: CrawlMediaAccessMode,
    expiresAtMs: number,
    accessScope: CrawlMediaAccessScope
  ): string {
    const signature = this.signAssetAccess(assetId, mode, expiresAtMs, accessScope);
    const org = encodeURIComponent(accessScope.orgId);
    const user = encodeURIComponent(accessScope.userId);
    return `/api/crawl-media-assets/${assetId}/${mode}?exp=${expiresAtMs}&org=${org}&user=${user}&sig=${signature}`;
  }

  private signAssetAccess(
    assetId: string,
    mode: CrawlMediaAccessMode,
    expiresAtMs: number,
    accessScope: CrawlMediaAccessScope
  ): string {
    const payload = `${assetId}:${mode}:${expiresAtMs}:${accessScope.orgId}:${accessScope.userId}`;
    return createHmac("sha256", this.env.jwtConfig.secret).update(payload).digest("base64url");
  }

  private normalizeAccessScopeValue(value: string | undefined): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    if (!normalized || normalized.length > 191) {
      return null;
    }
    return normalized;
  }

  private async getSignedUrlTtlSeconds(): Promise<number> {
    try {
      const config = await this.storageSettings.getStorageConfig();
      return this.normalizeSignedUrlTtl(config.presignedUrlTtlSeconds);
    } catch (error) {
      logger.warn({ err: error }, "Failed to read signed media URL TTL, using default");
      return DEFAULT_SIGNED_URL_TTL_SECONDS;
    }
  }

  private normalizeSignedUrlTtl(value: number | undefined): number {
    const normalized =
      typeof value === "number" && Number.isFinite(value)
        ? value
        : DEFAULT_SIGNED_URL_TTL_SECONDS;
    return Math.min(
      MAX_SIGNED_URL_TTL_SECONDS,
      Math.max(MIN_SIGNED_URL_TTL_SECONDS, Math.floor(normalized))
    );
  }
}
