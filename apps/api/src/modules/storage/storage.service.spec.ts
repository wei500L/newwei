import { DeleteObjectCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import type { StorageConfig } from "../config/config.service";
import type { PrismaService } from "../config/prisma.service";

import type { StorageSettingsService } from "./storage-settings.service";
import { StorageService } from "./storage.service";

let sendMock: jest.Mock;

jest.mock("@aws-sdk/client-s3", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn(() => ({
      send: (...args: unknown[]) => sendMock(...args),
    })),
  };
});

describe("StorageService", () => {
  const storageConfig: StorageConfig = {
    accessKeyId: "access",
    secretAccessKey: "secret",
    region: "us-east-1",
    bucket: "test-bucket",
    endpoint: "http://localhost:9000",
    publicBaseUrl: "http://localhost:9000/test-bucket",
    forcePathStyle: true,
    presignedUrlTtlSeconds: 300,
  };

  let storageSettings: Pick<StorageSettingsService, "getStorageConfig" | "getCrawlImageStorageProvider">;
  let prisma: Pick<PrismaService, "$queryRaw">;

  beforeEach(() => {
    sendMock = jest.fn();
    storageSettings = {
      getStorageConfig: jest.fn().mockResolvedValue(storageConfig),
      getCrawlImageStorageProvider: jest.fn().mockResolvedValue("s3")
    };
    prisma = {
      $queryRaw: jest.fn()
    };
  });

  it("returns ok=true when bucket is reachable", async () => {
    sendMock.mockResolvedValue({});
    const service = new StorageService(storageSettings as StorageSettingsService, prisma as PrismaService);

    const result = await service.testConnection();

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("s3");
    expect(result.bucket).toBe(storageConfig.bucket);
    expect(result.publicBaseUrl).toBe(storageConfig.publicBaseUrl);
    expect(result.checks?.putObject.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(sendMock.mock.calls[1]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(sendMock.mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("returns ok=false and formats AWS errors", async () => {
    const putError = new Error("NoSuchBucket");
    (putError as unknown as { name: string }).name = "NoSuchBucket";
    (putError as unknown as { $metadata: Record<string, unknown> }).$metadata = {
      httpStatusCode: 404,
      requestId: "req-123",
    };

    sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(putError)
      .mockResolvedValueOnce({});

    const service = new StorageService(storageSettings as StorageSettingsService, prisma as PrismaService);

    const result = await service.testConnection();

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("s3");
    expect(result.checks?.putObject.ok).toBe(false);
    expect(result.checks?.putObject.httpStatusCode).toBe(404);
    expect(result.checks?.putObject.requestId).toBe("req-123");
    expect(result.checks?.putObject.error).toContain("NoSuchBucket");
  });

  it("short-circuits connection test when crawl image storage mode is mysql", async () => {
    storageSettings.getCrawlImageStorageProvider = jest.fn().mockResolvedValue("mysql");
    prisma.$queryRaw = jest.fn().mockResolvedValue([{ ok: 1 }]);
    const service = new StorageService(storageSettings as StorageSettingsService, prisma as PrismaService);

    const result = await service.testConnection();

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("mysql");
    expect(result.checks?.mysql?.ok).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
