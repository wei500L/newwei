import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../config/prisma.service";
import { StorageSettingsService } from "./storage-settings.service";
import { type CrawlImageStorageProvider } from "./storage.constants";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"]
]);

export interface AvatarUploadRequest {
  userId: string;
  orgId: string;
  contentType: string;
  contentLength: number;
}

export interface AvatarUploadResponse {
  uploadUrl: string;
  publicUrl: string;
  objectKey: string;
}

export interface StorageConnectionCheck {
  ok: boolean;
  error?: string;
  httpStatusCode?: number;
  requestId?: string;
}

export interface StorageConnectionTestResult {
  ok: boolean;
  mode?: CrawlImageStorageProvider;
  error?: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
  presignedUrlTtlSeconds?: number;
  checks?: {
    mysql?: StorageConnectionCheck;
    headBucket?: StorageConnectionCheck;
    putObject?: StorageConnectionCheck;
    deleteObject?: StorageConnectionCheck;
  };
}

export interface ObjectReadUrlOptions {
  expiresInSeconds?: number;
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
}

@Injectable()
export class StorageService {
  private s3: S3Client | null = null;
  private bucket = "";
  private publicBaseUrl = "";
  private presignedUrlTtlSeconds = 300;
  private configFingerprint = "";

  constructor(
    private readonly storageSettings: StorageSettingsService,
    private readonly prisma: PrismaService
  ) {}

  async createAvatarUploadUrl(request: AvatarUploadRequest): Promise<AvatarUploadResponse> {
    const { userId, orgId, contentType, contentLength } = request;
    await this.refreshClient();
    const extension = ALLOWED_CONTENT_TYPES.get(contentType);
    if (!extension) {
      throw new BadRequestException("Unsupported avatar content type");
    }
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      throw new BadRequestException("Invalid avatar size");
    }
    if (contentLength > MAX_AVATAR_BYTES) {
      throw new BadRequestException("Avatar exceeds 2MB size limit");
    }

    const key = `avatars/${orgId}/${userId}/${Date.now()}-${randomUUID()}.${extension}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable"
    });
    const uploadUrl = await getSignedUrl(this.s3 as S3Client, command, {
      expiresIn: this.presignedUrlTtlSeconds
    });

    return {
      uploadUrl,
      publicUrl: `${this.publicBaseUrl}/${key}`,
      objectKey: key
    };
  }

  async isPublicUrl(value: string): Promise<boolean> {
    await this.refreshClient();
    return value.startsWith(`${this.publicBaseUrl}/`);
  }

  async testConnection(): Promise<StorageConnectionTestResult> {
    const mode = await this.storageSettings.getCrawlImageStorageProvider();
    if (mode === "mysql") {
      const mysql = await this.safeMySqlCall(async () => this.prisma.$queryRaw`SELECT 1`);
      return {
        ok: mysql.ok,
        mode,
        error: mysql.ok ? undefined : mysql.error,
        checks: {
          mysql
        }
      };
    }

    try {
      await this.refreshClient();
    } catch (error) {
      const formatted = this.formatAwsError(error);
      return { ok: false, mode, error: formatted.error };
    }

    const config = await this.storageSettings.getStorageConfig();
    const s3 = this.s3 as S3Client;
    const testKey = "__healthcheck__/storage-connection.txt";

    const headBucket = await this.safeAwsCall(async () =>
      s3.send(new HeadBucketCommand({ Bucket: this.bucket }))
    );

    const putObject = await this.safeAwsCall(async () =>
      s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: testKey,
          Body: `ok:${Date.now()}`,
          ContentType: "text/plain",
          CacheControl: "no-store"
        })
      )
    );

    const deleteObject = await this.safeAwsCall(async () =>
      s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: testKey }))
    );

    const ok = headBucket.ok && putObject.ok && deleteObject.ok;
    return {
      ok,
      mode,
      error: ok
        ? undefined
        : headBucket.error ?? putObject.error ?? deleteObject.error ?? "Storage connection test failed",
      bucket: this.bucket,
      region: config.region,
      endpoint: config.endpoint,
      publicBaseUrl: this.publicBaseUrl,
      forcePathStyle: config.forcePathStyle,
      presignedUrlTtlSeconds: config.presignedUrlTtlSeconds,
      checks: {
        headBucket,
        putObject,
        deleteObject
      }
    };
  }

  async uploadObject(params: {
    objectKey: string;
    body: Uint8Array | Buffer | string;
    contentType?: string;
    cacheControl?: string;
  }) {
    await this.refreshClient();
    await (this.s3 as S3Client).send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.objectKey,
        Body: params.body,
        ContentType: params.contentType,
        CacheControl: params.cacheControl
      })
    );
    return {
      objectKey: params.objectKey,
      publicUrl: `${this.publicBaseUrl}/${params.objectKey}`
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.refreshClient();
    await (this.s3 as S3Client).send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey
      })
    );
  }

  async createObjectReadUrl(objectKey: string, options?: ObjectReadUrlOptions): Promise<string> {
    await this.refreshClient();
    const expiresInSeconds = options?.expiresInSeconds;
    const ttl =
      typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? Math.max(30, Math.floor(expiresInSeconds))
        : this.presignedUrlTtlSeconds;
    return getSignedUrl(
      this.s3 as S3Client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ResponseContentType: options?.responseContentType,
        ResponseContentDisposition: options?.responseContentDisposition,
        ResponseCacheControl: options?.responseCacheControl
      }),
      { expiresIn: ttl }
    );
  }

  private async refreshClient() {
    const config = await this.storageSettings.getStorageConfig();
    if (!config.accessKeyId || !config.secretAccessKey || !config.bucket || !config.publicBaseUrl) {
      throw new BadRequestException("Storage configuration is incomplete");
    }
    const nextFingerprint = JSON.stringify({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      bucket: config.bucket,
      endpoint: config.endpoint,
      publicBaseUrl: config.publicBaseUrl,
      forcePathStyle: config.forcePathStyle,
      presignedUrlTtlSeconds: config.presignedUrlTtlSeconds
    });

    if (this.s3 && this.configFingerprint === nextFingerprint) {
      return;
    }

    this.bucket = config.bucket;
    this.publicBaseUrl = config.publicBaseUrl.replace(/\/$/, "");
    this.presignedUrlTtlSeconds = config.presignedUrlTtlSeconds;
    this.s3 = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      },
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle
    });
    this.configFingerprint = nextFingerprint;
  }

  private async safeAwsCall(operation: () => Promise<unknown>): Promise<StorageConnectionCheck> {
    try {
      await operation();
      return { ok: true };
    } catch (error) {
      const formatted = this.formatAwsError(error);
      return { ok: false, ...formatted };
    }
  }

  private async safeMySqlCall(operation: () => Promise<unknown>): Promise<StorageConnectionCheck> {
    try {
      await operation();
      return { ok: true };
    } catch (error) {
      return { ok: false, ...this.formatDatabaseError(error) };
    }
  }

  private formatAwsError(error: unknown): Omit<StorageConnectionCheck, "ok"> {
    if (!error || typeof error !== "object") {
      return { error: String(error) };
    }

    const record = error as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Error";
    const message = typeof record.message === "string" ? record.message : "Unknown error";
    const metadata = record.$metadata as Record<string, unknown> | undefined;
    const httpStatusCode =
      typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
    const requestId = typeof metadata?.requestId === "string" ? metadata.requestId : undefined;
    return {
      error: `${name}: ${message}`,
      httpStatusCode,
      requestId
    };
  }

  private formatDatabaseError(error: unknown): Omit<StorageConnectionCheck, "ok"> {
    if (error instanceof Error) {
      return {
        error: `${error.name}: ${error.message}`
      };
    }
    return { error: String(error) };
  }
}
