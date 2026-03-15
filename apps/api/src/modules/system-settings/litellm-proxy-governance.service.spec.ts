import { AxiosHeaders } from "axios";

import { LiteLlmProxyGovernanceService } from "./litellm-proxy-governance.service";

const mockAxiosPost = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
  post: mockAxiosPost,
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
    }));

    service = new LiteLlmProxyGovernanceService(
      prismaMock,
      cacheMock,
      envMock,
      securitySettingsMock,
      gatewaySettingsMock,
    );
    gatewaySettingsMock.getProfileSummary = jest
      .fn()
      .mockResolvedValue({
        id: "profile-1",
        name: "Primary LiteLLM",
        apiBase: "http://localhost:4001/v1",
        enabled: true,
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

  it("prefers the LiteLLM master key for test-time auth on the governed profile", async () => {
    persistedValue = {
      enabled: true,
      targetProfileId: "profile-1",
    };

    const resolved = await service.resolveTestingApiKey(
      "http://localhost:4001/v1/chat/completions",
      "profile-key",
      "profile-1",
    );

    expect(resolved).toBe("master-key");
  });
});
