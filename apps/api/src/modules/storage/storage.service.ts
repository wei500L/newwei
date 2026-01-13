import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { StorageSettingsService } from "./storage-settings.service";

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

@Injectable()
export class StorageService {
  private s3: S3Client | null = null;
  private bucket = "";
  private publicBaseUrl = "";
  private presignedUrlTtlSeconds = 300;
  private configFingerprint = "";

  constructor(
    private readonly storageSettings: StorageSettingsService
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
}
