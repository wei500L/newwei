import { AxiosError, AxiosHeaders } from "axios";

import {
  decodeSystemSettingsKey,
  encryptStringValueV1,
} from "../storage/storage-settings.crypto";
import { LiteLlmProxyGovernanceService } from "./litellm-proxy-governance.service";

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
  post: mockAxiosPost,
  get: mockAxiosGet,
}));

jest.mock("axios", () => ({
  ...jest.requireActual("axios"),
  create: (...args: unknown[]) => mockAxiosCreate(...args),
  AxiosError: jest.requireActual("axios").AxiosError,
}));

jest.mock("@modular/utils", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe("LiteLlmProxyGovernanceService", () => {
  const okResponse = (data: unknown = {}) => ({
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

  const notFoundResponse = (data: unknown = {}) =>
    new AxiosError("Not found", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 404,
      data,
      statusText: "Not Found",
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

  const prismaMock = {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  } as any;
  const cacheMock = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  } as any;
  const envMock = {
    liteLlmConfig: {
      apiBase: "http://localhost:4001/v1",
    },
    liteLlmMasterKey: "master-key",
    systemSettingsEncryptionKey: undefined,
  } as any;
  const securitySettingsMock = {
    encodeSecretForStorage: jest.fn(async (plain: string) => plain),
  } as any;
  const gatewaySettingsMock = {
    getProfileSummary: jest.fn(),
    getRuntimeBindingSnapshot: jest.fn(),
  } as any;

  let service: LiteLlmProxyGovernanceService;
  let cacheState: any;
  let persistedValue: any;

  beforeEach(() => {
    jest.resetAllMocks();
    cacheState = null;
    persistedValue = undefined;
    securitySettingsMock.encodeSecretForStorage = jest.fn(
      async (plain: string) => plain,
    );

    cacheMock.get = jest.fn(async () => cacheState);
    cacheMock.set = jest.fn(async (_key: string, value: unknown) => {
      cacheState = value;
    });
    cacheMock.del = jest.fn(async () => {
      cacheState = null;
    });

    prismaMock.systemSetting.findUnique = jest.fn(async () => {
      if (!persistedValue) {
        return null;
      }
      return { key: "litellm_proxy_governance", value: persistedValue };
    });
    prismaMock.systemSetting.upsert = jest.fn(async (args: any) => {
      persistedValue = args.create?.value ?? args.update?.value;
      return { key: "litellm_proxy_governance", value: persistedValue };
    });
    prismaMock.systemSetting.deleteMany = jest.fn().mockResolvedValue({
      count: persistedValue ? 1 : 0,
    });
    prismaMock.auditLog.create = jest.fn().mockResolvedValue(undefined);

    mockAxiosCreate.mockImplementation(() => ({
      post: mockAxiosPost,
      get: mockAxiosGet,
    }));
    mockAxiosGet.mockResolvedValue(okResponse());
    gatewaySettingsMock.getRuntimeBindingSnapshot = jest.fn().mockResolvedValue({
      completionProfileId: "profile-1",
      embeddingProfileId: "profile-1",
      rerankProfileId: "profile-1",
    });

    service = new LiteLlmProxyGovernanceService(
      prismaMock,
      cacheMock,
      envMock,
      securitySettingsMock,
      gatewaySettingsMock,
    );
    gatewaySettingsMock.getProfileSummary = jest
      .fn()
      .mockImplementation(async (profileId: string) => {
        if (profileId === "profile-1") {
          return {
            id: "profile-1",
            name: "Primary LiteLLM",
            apiBase: "http://localhost:4001/v1",
            enabled: true,
          };
        }
        if (profileId === "profile-2") {
          return {
            id: "profile-2",
            name: "Secondary LiteLLM",
            apiBase: "http://localhost:4002/v1",
            enabled: true,
          };
        }
        if (profileId === "profile-3") {
          return {
            id: "profile-3",
            name: "Shared LiteLLM",
            apiBase: "http://localhost:4001/v1",
            enabled: true,
          };
        }
        return null;
      });
  });

  it("syncs LiteLLM managed team/key and exposes the runtime key for the governed profile", async () => {
    mockAxiosPost
      .mockResolvedValueOnce({
        data: { team_id: "modular-runtime-123" },
        status: 200,
        statusText: "OK",
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      .mockResolvedValueOnce({
        data: {
          key: "runtime-key-1",
          key_alias: "modular-runtime-key",
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

    const result = await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      targetProfileId: "profile-1",
      dailyBudgetUsd: 12.5,
      monthlyBudgetUsd: 300,
      maxParallelRequests: 9,
    });

    expect(result.enabled).toBe(true);
    expect(result.hasManagedRuntimeKey).toBe(true);
    expect(result.apiBase).toBe("http://localhost:4001/v1");
    expect(result.targetProfileId).toBe("profile-1");
    expect(result.targetProfileName).toBe("Primary LiteLLM");
    expect(result.dailyBudgetUsd).toBe(12.5);
    expect(result.monthlyBudgetUsd).toBe(300);
    expect(result.maxParallelRequests).toBe(9);
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      1,
      "/team/update",
      expect.objectContaining({
        max_budget: 300,
        budget_duration: "30d",
      }),
    );
    expect(mockAxiosPost).toHaveBeenNthCalledWith(
      2,
      "/key/generate",
      expect.objectContaining({
        max_budget: 12.5,
        max_parallel_requests: 9,
        budget_duration: "1d",
      }),
    );

    const managedApiKey = await service.getManagedRuntimeApiKeyForProfile(
      "profile-1",
      "http://localhost:4001",
    );
    expect(managedApiKey).toBe("runtime-key-1");
  });

  it("resolves profile-key auth without replacing it with the LiteLLM master key", async () => {
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
    };

    const resolved = await service.resolveTestingApiKey(
      "http://localhost:4001/v1/chat/completions",
      "profile-key",
      "profile-1",
      "profile_key",
    );

    expect(resolved).toBe("profile-key");
  });

  it("requires the managed runtime key only for the exact governed target profile", async () => {
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
      managedRuntimeKey: "runtime-key-1",
    };

    await expect(
      service.resolveTestingApiKey(
        "https://attacker.example/v1/chat/completions",
        "profile-key",
        "profile-1",
        "managed_runtime_key",
      ),
    ).rejects.toThrow("Selected profile is not the active LiteLLM governance target");

    const resolved = await service.resolveTestingApiKey(
      "http://localhost:4001/v1/chat/completions",
      "profile-key",
      "profile-1",
      "managed_runtime_key",
    );

    expect(resolved).toBe("runtime-key-1");
  });

  it("fails closed when the managed runtime key is unreadable", async () => {
    envMock.systemSettingsEncryptionKey =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
      managedRuntimeKey: encryptStringValueV1(
        "runtime-key-1",
        decodeSystemSettingsKey(envMock.systemSettingsEncryptionKey),
      ),
    };
    envMock.systemSettingsEncryptionKey = undefined;

    await expect(
      service.getManagedRuntimeApiKeyForProfile(
        "profile-1",
        "http://localhost:4001/v1/chat/completions",
      ),
    ).rejects.toThrow(
      "LiteLLM governance is enabled but the managed runtime key is unreadable",
    );
  });

  it("uses exact target matching instead of governing sibling profiles on the same LiteLLM base", async () => {
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
      managedRuntimeKey: "runtime-key-1",
    };

    const resolved = await service.getManagedRuntimeApiKeyForProfile(
      "profile-3",
      "http://localhost:4001/v1/chat/completions",
    );

    expect(resolved).toBeNull();
  });

  it("does not disable managed resources when governance stays on the same LiteLLM instance", async () => {
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
      managedTeamId: "managed-team-1",
      managedRuntimeKey: "runtime-key-1",
      managedRuntimeKeyAlias: "runtime-key-alias-1",
      dailyBudgetUsd: 12.5,
      monthlyBudgetUsd: 300,
      maxParallelRequests: 9,
    };

    const sameProxyPost = jest
      .fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse());
    gatewaySettingsMock.getRuntimeBindingSnapshot.mockResolvedValueOnce({
      completionProfileId: "profile-3",
      embeddingProfileId: null,
      rerankProfileId: null,
    });

    mockAxiosCreate.mockImplementation(() => ({
      post: sameProxyPost,
      get: mockAxiosGet,
    }));

    const result = await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      targetProfileId: "profile-3",
      dailyBudgetUsd: 15,
      monthlyBudgetUsd: 350,
      maxParallelRequests: 7,
    });

    expect(result.targetProfileId).toBe("profile-3");
    expect(result.apiBase).toBe("http://localhost:4001/v1");
    expect(result.managedTeamId).toBe("managed-team-1");
    expect(result.managedRuntimeKeyAlias).toBe("runtime-key-alias-1");
    expect(mockAxiosCreate).toHaveBeenCalledTimes(2);
    expect(sameProxyPost).toHaveBeenCalledTimes(2);
    expect(sameProxyPost).toHaveBeenNthCalledWith(
      1,
      "/team/update",
      expect.objectContaining({
        team_id: "managed-team-1",
        max_budget: 350,
      }),
    );
    expect(sameProxyPost).toHaveBeenNthCalledWith(
      2,
      "/key/update",
      expect.objectContaining({
        key: "runtime-key-1",
        team_id: "managed-team-1",
        blocked: false,
        max_budget: 15,
        max_parallel_requests: 7,
      }),
    );
  });

  it("disables the previous managed key and team when governance moves to another LiteLLM instance", async () => {
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
      managedTeamId: "managed-team-1",
      managedRuntimeKey: "runtime-key-1",
      managedRuntimeKeyAlias: "runtime-key-alias-1",
      dailyBudgetUsd: 12.5,
      monthlyBudgetUsd: 300,
      maxParallelRequests: 9,
    };

    const newProxyPost = jest
      .fn()
      .mockResolvedValueOnce(okResponse({ team_id: "managed-team-1" }))
      .mockRejectedValueOnce(
        notFoundResponse({ detail: "managed runtime key not found" }),
      )
      .mockResolvedValueOnce(
        okResponse({
          key: "runtime-key-2",
          key_alias: "runtime-key-alias-2",
        }),
      );
    const oldProxyPost = jest
      .fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse());
    gatewaySettingsMock.getRuntimeBindingSnapshot.mockResolvedValueOnce({
      completionProfileId: "profile-2",
      embeddingProfileId: null,
      rerankProfileId: null,
    });

    mockAxiosCreate.mockImplementation((config: { baseURL?: string }) => {
      if (config.baseURL === "http://localhost:4002/v1") {
        return { post: newProxyPost, get: mockAxiosGet };
      }
      if (config.baseURL === "http://localhost:4001/v1") {
        return { post: oldProxyPost, get: mockAxiosGet };
      }
      return { post: jest.fn(), get: mockAxiosGet };
    });

    const result = await service.updateSettings("org-1", "actor-1", {
      enabled: true,
      targetProfileId: "profile-2",
      dailyBudgetUsd: 15,
      monthlyBudgetUsd: 350,
      maxParallelRequests: 7,
    });

    expect(result.targetProfileId).toBe("profile-2");
    expect(result.apiBase).toBe("http://localhost:4002/v1");
    expect(result.managedTeamId).toBe("managed-team-1");
    expect(result.managedRuntimeKeyAlias).toBe("runtime-key-alias-2");
    expect(mockAxiosCreate).toHaveBeenCalledTimes(3);
    expect(newProxyPost).toHaveBeenCalledTimes(3);
    expect(newProxyPost).toHaveBeenNthCalledWith(
      1,
      "/team/update",
      expect.objectContaining({
        team_id: "managed-team-1",
        max_budget: 350,
      }),
    );
    expect(newProxyPost).toHaveBeenNthCalledWith(
      2,
      "/key/update",
      expect.objectContaining({
        key: "runtime-key-1",
        key_alias: "runtime-key-alias-1",
        team_id: "managed-team-1",
        blocked: false,
      }),
    );
    expect(newProxyPost).toHaveBeenNthCalledWith(
      3,
      "/key/generate",
      expect.objectContaining({
        team_id: "managed-team-1",
        max_budget: 15,
        max_parallel_requests: 7,
      }),
    );
    expect(oldProxyPost).toHaveBeenCalledTimes(2);
    expect(oldProxyPost).toHaveBeenNthCalledWith(
      1,
      "/key/update",
      expect.objectContaining({
        key: "runtime-key-1",
        blocked: true,
        max_budget: 0,
      }),
    );
    expect(oldProxyPost).toHaveBeenNthCalledWith(
      2,
      "/team/update",
      expect.objectContaining({
        team_id: "managed-team-1",
        blocked: true,
        max_budget: 0,
      }),
    );
    expect(prismaMock.systemSetting.upsert).toHaveBeenCalledTimes(1);
    expect(cacheMock.del).toHaveBeenCalledTimes(1);
    expect(prismaMock.systemSetting.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      oldProxyPost.mock.invocationCallOrder[0],
    );
    expect(cacheMock.del.mock.invocationCallOrder[0]).toBeLessThan(
      oldProxyPost.mock.invocationCallOrder[0],
    );
  });

  it("does not disable the previous managed key and team when persistence fails during a cross-instance move", async () => {
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
      managedTeamId: "managed-team-1",
      managedRuntimeKey: "runtime-key-1",
      managedRuntimeKeyAlias: "runtime-key-alias-1",
      dailyBudgetUsd: 12.5,
      monthlyBudgetUsd: 300,
      maxParallelRequests: 9,
    };
    securitySettingsMock.encodeSecretForStorage = jest.fn(async () => {
      throw new Error("encode failed");
    });

    const newProxyPost = jest
      .fn()
      .mockResolvedValueOnce(okResponse({ team_id: "managed-team-1" }))
      .mockRejectedValueOnce(
        notFoundResponse({ detail: "managed runtime key not found" }),
      )
      .mockResolvedValueOnce(
        okResponse({
          key: "runtime-key-2",
          key_alias: "runtime-key-alias-2",
        }),
      );
    const oldProxyPost = jest.fn();
    gatewaySettingsMock.getRuntimeBindingSnapshot.mockResolvedValueOnce({
      completionProfileId: "profile-2",
      embeddingProfileId: null,
      rerankProfileId: null,
    });

    mockAxiosCreate.mockImplementation((config: { baseURL?: string }) => {
      if (config.baseURL === "http://localhost:4002/v1") {
        return { post: newProxyPost, get: mockAxiosGet };
      }
      if (config.baseURL === "http://localhost:4001/v1") {
        return { post: oldProxyPost, get: mockAxiosGet };
      }
      return { post: jest.fn(), get: mockAxiosGet };
    });

    await expect(
      service.updateSettings("org-1", "actor-1", {
        enabled: true,
        targetProfileId: "profile-2",
        dailyBudgetUsd: 15,
        monthlyBudgetUsd: 350,
        maxParallelRequests: 7,
      }),
    ).rejects.toThrow("encode failed");

    expect(newProxyPost).toHaveBeenCalledTimes(3);
    expect(oldProxyPost).not.toHaveBeenCalled();
    expect(prismaMock.systemSetting.upsert).not.toHaveBeenCalled();
    expect(cacheMock.del).not.toHaveBeenCalled();
    expect(persistedValue.targetProfileId).toBe("profile-1");
  });
});
