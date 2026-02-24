import { ConflictException } from "@nestjs/common";

import { decodeSystemSettingsKey, encryptStringValueV1 } from "../storage/storage-settings.crypto";

import { NewsSourceRuntimeSecretsService } from "./news-source-runtime-secrets.service";

describe("NewsSourceRuntimeSecretsService", () => {
  let storedValue: unknown = null;

  const prisma = {
    systemSetting: {
      findUnique: jest.fn(async () => (storedValue === null ? null : { value: storedValue })),
      upsert: jest.fn(async (args: any) => {
        storedValue = args.create?.value ?? args.update?.value ?? null;
      }),
      deleteMany: jest.fn(async () => {
        storedValue = null;
        return { count: 1 };
      }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    auditLogOutbox: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  } as any;

  const env = {
    systemSettingsEncryptionKey: undefined,
  } as any;

  const securitySettings = {
    encodeSecretForStorage: jest.fn(async (value: string) => value),
  } as any;

  let service: NewsSourceRuntimeSecretsService;

  beforeEach(() => {
    storedValue = null;
    jest.resetAllMocks();
    prisma.systemSetting.findUnique = jest.fn(async () =>
      storedValue === null ? null : { value: storedValue }
    );
    prisma.systemSetting.upsert = jest.fn(async (args: any) => {
      storedValue = args.create?.value ?? args.update?.value ?? null;
    });
    prisma.systemSetting.deleteMany = jest.fn(async () => {
      storedValue = null;
      return { count: 1 };
    });
    prisma.auditLog.create = jest.fn().mockResolvedValue(undefined);
    prisma.auditLogOutbox.create = jest.fn().mockResolvedValue(undefined);
    securitySettings.encodeSecretForStorage = jest.fn(async (value: string) => value);

    service = new NewsSourceRuntimeSecretsService(prisma, env, securitySettings);
  });

  it("returns empty settings when db record does not exist", async () => {
    const settings = await service.getPublicSettings();
    expect(settings).toEqual({
      source: "none",
      entries: [],
    });
  });

  it("updates and removes runtime secrets", async () => {
    await service.updateSettings("org-1", "actor-1", {
      upserts: [
        { sourceId: "weibo", key: "cookie", value: "abc" },
        { sourceId: "producthunt", key: "token", value: "xyz" },
      ],
    });

    let settings = await service.getPublicSettings();
    expect(settings.source).toBe("db");
    expect(settings.entries).toHaveLength(2);
    expect(prisma.systemSetting.upsert).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalled();

    await service.updateSettings("org-1", "actor-1", {
      removes: [
        { sourceId: "weibo", key: "cookie" },
        { sourceId: "producthunt", key: "token" },
      ],
    });

    settings = await service.getPublicSettings();
    expect(settings).toEqual({
      source: "none",
      entries: [],
    });
    expect(prisma.systemSetting.deleteMany).toHaveBeenCalled();
  });

  it("returns merged runtime secrets with override source taking precedence", async () => {
    storedValue = {
      version: 1,
      entries: [
        {
          sourceId: "wallstreetcn",
          key: "token",
          value: "parent-token",
          fingerprint: "p1",
          updatedAt: new Date().toISOString(),
        },
        {
          sourceId: "wallstreetcn",
          key: "cookie",
          value: "parent-cookie",
          fingerprint: "p2",
          updatedAt: new Date().toISOString(),
        },
        {
          sourceId: "wallstreetcn-quick",
          key: "token",
          value: "child-token",
          fingerprint: "c1",
          updatedAt: new Date().toISOString(),
        },
      ],
    };

    const secrets = await service.getSecretsForSource("wallstreetcn", "wallstreetcn-quick");
    expect(secrets).toEqual({
      token: "child-token",
      cookie: "parent-cookie",
    });
  });

  it("reads encrypted runtime secrets when encryption key is configured", async () => {
    const rawKey = Buffer.alloc(32, 7).toString("base64");
    const key = decodeSystemSettingsKey(rawKey);
    env.systemSettingsEncryptionKey = rawKey;
    securitySettings.encodeSecretForStorage = jest.fn(async (value: string) =>
      encryptStringValueV1(value, key)
    );

    await service.updateSettings("org-1", "actor-1", {
      upserts: [{ sourceId: "weibo", key: "cookie", value: "secure-cookie" }],
    });

    const secrets = await service.getSecretsForSource("weibo");
    expect(secrets).toEqual({
      cookie: "secure-cookie",
    });
  });

  it("throws conflict when persisted settings are invalid", async () => {
    storedValue = "invalid";

    try {
      await service.getPublicSettings();
      throw new Error("expected getPublicSettings to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: "NEWS_SOURCE_RUNTIME_SECRETS_INVALID",
      });
    }
  });
});
