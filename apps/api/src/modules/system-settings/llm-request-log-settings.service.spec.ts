const mockCollection = {
  indexes: jest.fn(),
  dropIndex: jest.fn(),
  createIndex: jest.fn(),
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("@modular/mongo", () => ({
  DEFAULT_LLM_REQUEST_LOG_RETENTION_DAYS: 30,
  MIN_LLM_REQUEST_LOG_RETENTION_DAYS: 1,
  MAX_LLM_REQUEST_LOG_RETENTION_DAYS: 3650,
  LLM_REQUEST_LOG_TTL_INDEX_NAME: "llm_request_log_created_at_ttl",
  LlmRequestLogModel: {
    collection: mockCollection,
  },
}));

jest.mock("@modular/utils", () => ({
  createLogger: () => mockLogger,
}));

jest.mock("node:timers/promises", () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../audit/audit-log.writer", () => ({
  writeAuditLogBestEffort: jest.fn().mockResolvedValue(undefined),
}));

import { setTimeout as sleep } from "node:timers/promises";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";

import {
  DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
  DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
  LlmRequestLogSettingsService,
} from "./llm-request-log-settings.service";

describe("LlmRequestLogSettingsService", () => {
  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    auditLogOutbox: {
      create: jest.fn(),
    },
  } as any;

  let service: LlmRequestLogSettingsService;
  let indexState: Array<Record<string, unknown>>;

  const setIndexState = (next: Array<Record<string, unknown>>) => {
    indexState = next.map((index) => ({
      ...index,
      key:
        index.key && typeof index.key === "object"
          ? { ...(index.key as Record<string, unknown>) }
          : index.key,
    }));
  };

  beforeEach(() => {
    jest.resetAllMocks();
    setIndexState([{ name: "_id_", key: { _id: 1 } }]);

    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue(null);
    prismaMock.systemSetting.upsert = jest.fn().mockResolvedValue({ key: "llm_request_log_settings" });
    prismaMock.systemSetting.deleteMany = jest.fn().mockResolvedValue({ count: 1 });

    mockCollection.indexes.mockImplementation(async () =>
      indexState.map((index) => ({
        ...index,
        key:
          index.key && typeof index.key === "object"
            ? { ...(index.key as Record<string, unknown>) }
            : index.key,
      })),
    );

    mockCollection.dropIndex.mockImplementation(async (indexName: string) => {
      const exists = indexState.some((index) => index.name === indexName);
      if (!exists) {
        const error = new Error("index not found") as Error & {
          code?: number;
          codeName?: string;
        };
        error.code = 27;
        error.codeName = "IndexNotFound";
        throw error;
      }
      setIndexState(indexState.filter((index) => index.name !== indexName));
      return { ok: 1 };
    });

    mockCollection.createIndex.mockImplementation(
      async (
        key: Record<string, unknown>,
        options: { name?: string; expireAfterSeconds?: number },
      ) => {
        const isCreatedAtOnly =
          Object.keys(key).length === 1 &&
          Object.prototype.hasOwnProperty.call(key, "createdAt") &&
          key.createdAt === 1;

        if (!isCreatedAtOnly) {
          return options.name ?? "unknown_index";
        }

        const existing = indexState.find(
          (index) =>
            index.key &&
            typeof index.key === "object" &&
            Object.keys(index.key as Record<string, unknown>).length === 1 &&
            (index.key as Record<string, unknown>).createdAt === 1,
        );

        const nextName = options.name ?? "createdAt_1";
        const nextTtl =
          typeof options.expireAfterSeconds === "number"
            ? Math.trunc(options.expireAfterSeconds)
            : null;

        if (existing) {
          const existingName =
            typeof existing.name === "string" ? existing.name : "createdAt_1";
          const existingTtl =
            typeof existing.expireAfterSeconds === "number"
              ? Math.trunc(existing.expireAfterSeconds)
              : null;

          if (existingName === nextName && existingTtl === nextTtl) {
            return nextName;
          }

          const error = new Error("Index options conflict") as Error & {
            code?: number;
            codeName?: string;
          };
          error.code = 85;
          error.codeName = "IndexOptionsConflict";
          throw error;
        }

        setIndexState([
          ...indexState,
          {
            name: nextName,
            key: { createdAt: 1 },
            ...(nextTtl !== null ? { expireAfterSeconds: nextTtl } : {}),
          },
        ]);

        return nextName;
      },
    );

    service = new LlmRequestLogSettingsService(prismaMock);
  });

  it("applies default TTL index on startup when no db setting exists", async () => {
    await service.onModuleInit();

    const ttlIndex = indexState.find(
      (index) => index.name === "llm_request_log_created_at_ttl",
    );
    expect(ttlIndex).toBeTruthy();
    expect(ttlIndex?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  it("reconciles TTL after startup fallback once settings refresh succeeds", async () => {
    prismaMock.systemSetting.findUnique = jest
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({
        value: {
          retentionDays: 45,
          metadataAllowedTopLevelKeys: ["traceid"],
          metadataAllowedTopLevelPrefixes: ["x_"],
        },
      });

    await service.onModuleInit();

    const ttlIndexAfterStartup = indexState.find(
      (index) => index.name === "llm_request_log_created_at_ttl",
    );
    expect(ttlIndexAfterStartup?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);

    (service as unknown as { cacheExpiresAt: number }).cacheExpiresAt = 0;
    const refreshed = await service.getSettings();

    expect(refreshed).toMatchObject({
      source: "db",
      retentionDays: 45,
    });

    const ttlIndexAfterRefresh = indexState.find(
      (index) => index.name === "llm_request_log_created_at_ttl",
    );
    expect(ttlIndexAfterRefresh?.expireAfterSeconds).toBe(45 * 24 * 60 * 60);
  });

  it("updates settings and synchronizes TTL index", async () => {
    setIndexState([
      { name: "_id_", key: { _id: 1 } },
      {
        name: "llm_request_log_created_at_ttl",
        key: { createdAt: 1 },
        expireAfterSeconds: 30 * 24 * 60 * 60,
      },
    ]);

    const result = await service.updateSettings("org-1", "actor-1", {
      retentionDays: 45,
    });

    expect(result).toMatchObject({
      source: "db",
      retentionDays: 45,
    });
    expect(result.metadataAllowedTopLevelKeys.length).toBeGreaterThan(0);
    expect(result.metadataAllowedTopLevelPrefixes.length).toBeGreaterThan(0);
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalled();
    expect(writeAuditLogBestEffort).toHaveBeenCalled();

    const ttlIndex = indexState.find(
      (index) => index.name === "llm_request_log_created_at_ttl",
    );
    expect(ttlIndex?.expireAfterSeconds).toBe(45 * 24 * 60 * 60);
  });

  it("falls back to default brief alert thresholds when db record does not contain them", async () => {
    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: {
        retentionDays: 45,
        metadataAllowedTopLevelKeys: ["traceid"],
        metadataAllowedTopLevelPrefixes: ["x_"],
      },
    });
    await service.onModuleInit();
    (service as unknown as { cacheExpiresAt: number }).cacheExpiresAt = 0;

    const settings = await service.getSettings();

    expect(settings).toMatchObject({
      source: "db",
      retentionDays: 45,
      briefErrorRateThreshold: 0.1,
      briefInvalidJsonRatioThreshold: 0.3,
      briefConsecutiveDaysThreshold: 3,
    });
  });

  it("does not drop non-TTL createdAt indexes and fails fast with clear error", async () => {
    setIndexState([
      { name: "_id_", key: { _id: 1 } },
      {
        name: "createdAt_1",
        key: { createdAt: 1 },
      },
    ]);

    await expect(
      service.updateSettings("org-1", "actor-1", {
        retentionDays: 60,
      }),
    ).rejects.toThrow("existing non-TTL createdAt index");

    expect(mockCollection.dropIndex).not.toHaveBeenCalledWith("createdAt_1");
    expect(prismaMock.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("retries transient index conflicts and succeeds", async () => {
    setIndexState([
      { name: "_id_", key: { _id: 1 } },
      {
        name: "llm_request_log_created_at_ttl",
        key: { createdAt: 1 },
        expireAfterSeconds: 30 * 24 * 60 * 60,
      },
    ]);

    const originalCreateImpl = mockCollection.createIndex.getMockImplementation();
    let injectedError = true;
    mockCollection.createIndex.mockImplementation(async (...args: any[]) => {
      if (injectedError) {
        injectedError = false;
        const error = new Error("index build in progress") as Error & {
          code?: number;
          codeName?: string;
        };
        error.code = 12586;
        error.codeName = "BackgroundOperationInProgressForNamespace";
        throw error;
      }
      if (!originalCreateImpl) {
        throw new Error("missing createIndex implementation");
      }
      return originalCreateImpl(...args);
    });

    await service.updateSettings("org-1", "actor-1", {
      retentionDays: 90,
    });

    expect(mockCollection.createIndex).toHaveBeenCalledTimes(2);
    expect((sleep as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it("updates metadata allowlist through system settings", async () => {
    setIndexState([
      { name: "_id_", key: { _id: 1 } },
      {
        name: "llm_request_log_created_at_ttl",
        key: { createdAt: 1 },
        expireAfterSeconds: 30 * 24 * 60 * 60,
      },
    ]);

    const result = await service.updateSettings("org-1", "actor-1", {
      metadataAllowedTopLevelKeys: ["traceId", "custom_key"],
      metadataAllowedTopLevelPrefixes: ["x_", "allow_"],
    });

    expect(result).toMatchObject({
      source: "db",
      retentionDays: 30,
      metadataAllowedTopLevelKeys: ["traceid", "custom_key"],
      metadataAllowedTopLevelPrefixes: ["x_", "allow_"],
    });
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          value: expect.objectContaining({
            metadataAllowedTopLevelKeys: ["traceid", "custom_key"],
            metadataAllowedTopLevelPrefixes: ["x_", "allow_"],
          }),
        }),
      }),
    );
  });

  it("skips TTL reconciliation when only metadata allowlist changes", async () => {
    setIndexState([
      { name: "_id_", key: { _id: 1 } },
      {
        name: "llm_request_log_created_at_ttl",
        key: { createdAt: 1 },
        expireAfterSeconds: 30 * 24 * 60 * 60,
      },
    ]);

    await service.updateSettings("org-1", "actor-1", {
      metadataAllowedTopLevelKeys: ["traceid"],
      metadataAllowedTopLevelPrefixes: ["x_"],
    });

    expect(mockCollection.indexes).not.toHaveBeenCalled();
    expect(mockCollection.dropIndex).not.toHaveBeenCalled();
    expect(mockCollection.createIndex).not.toHaveBeenCalled();
  });

  it("resets metadata allowlist without changing retention days", async () => {
    setIndexState([
      { name: "_id_", key: { _id: 1 } },
      {
        name: "llm_request_log_created_at_ttl",
        key: { createdAt: 1 },
        expireAfterSeconds: 45 * 24 * 60 * 60,
      },
    ]);

    prismaMock.systemSetting.findUnique = jest.fn().mockResolvedValue({
      value: {
        retentionDays: 45,
        metadataAllowedTopLevelKeys: ["custom_key"],
        metadataAllowedTopLevelPrefixes: ["allow_"],
      },
    });

    const result = await service.resetMetadataPolicy("org-1", "actor-1");

    expect(result.retentionDays).toBe(45);
    expect(result.metadataAllowedTopLevelKeys).toEqual([
      ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
    ]);
    expect(result.metadataAllowedTopLevelPrefixes).toEqual([
      ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
    ]);
  });

  it("resets settings to default and applies default TTL", async () => {
    setIndexState([
      { name: "_id_", key: { _id: 1 } },
      {
        name: "llm_request_log_created_at_ttl",
        key: { createdAt: 1 },
        expireAfterSeconds: 120 * 24 * 60 * 60,
      },
    ]);

    const result = await service.resetToDefault("org-1", "actor-1");

    expect(result).toEqual({
      source: "default",
      retentionDays: 30,
      metadataAllowedTopLevelKeys: [
        ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
      ],
      metadataAllowedTopLevelPrefixes: [
        ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
      ],
      briefErrorRateThreshold: 0.1,
      briefInvalidJsonRatioThreshold: 0.3,
      briefConsecutiveDaysThreshold: 3,
    });
    expect(prismaMock.systemSetting.deleteMany).toHaveBeenCalled();

    const ttlIndex = indexState.find(
      (index) => index.name === "llm_request_log_created_at_ttl",
    );
    expect(ttlIndex?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  it("updates configurable brief alert thresholds", async () => {
    const result = await service.updateSettings("org-1", "actor-1", {
      briefErrorRateThreshold: 0.12,
      briefInvalidJsonRatioThreshold: 0.45,
      briefConsecutiveDaysThreshold: 5,
    });

    expect(result).toMatchObject({
      source: "db",
      briefErrorRateThreshold: 0.12,
      briefInvalidJsonRatioThreshold: 0.45,
      briefConsecutiveDaysThreshold: 5,
    });
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          value: expect.objectContaining({
            briefErrorRateThreshold: 0.12,
            briefInvalidJsonRatioThreshold: 0.45,
            briefConsecutiveDaysThreshold: 5,
          }),
        }),
      }),
    );
  });

  it("rejects invalid brief alert thresholds", async () => {
    await expect(
      service.updateSettings("org-1", "actor-1", {
        briefErrorRateThreshold: 1.5,
      }),
    ).rejects.toThrow("briefErrorRateThreshold");

    await expect(
      service.updateSettings("org-1", "actor-1", {
        briefConsecutiveDaysThreshold: 0,
      }),
    ).rejects.toThrow("briefConsecutiveDaysThreshold");
  });
});
