import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

const get = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    status: "authenticated",
    data: { accessToken: "token", user: { id: "user-1" } },
  }),
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: () => ({
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
    delete: (...args: unknown[]) => del(...args),
  }),
}));

vi.mock("@/lib/client-telemetry", () => ({
  captureClientError: vi.fn(),
}));

const SETTINGS = {
  source: "db",
  enabled: true,
  requestTimeoutMs: 12000,
  maxRetries: 2,
  acledApiEnabled: false,
  acledApiDisabledReason: undefined,
  openskyEnabled: true,
  openskyIntervalSec: 900,
  openskyDailyCreditBudget: 4000,
  openskyDayIntervalSec: 600,
  openskyNightIntervalSec: 1800,
  openskyDayStartHourHkt: 8,
  openskyNightStartHourHkt: 22,
  openskyWarningRemainingPct: 20,
  openskyCriticalRemainingPct: 10,
  aisEnabled: true,
  aisIntervalSec: 600,
  unrestEnabled: true,
  unrestIntervalSec: 600,
  outagesEnabled: true,
  outagesIntervalSec: 600,
  keywordSpikeEnabled: true,
  keywordSpikeIntervalSec: 600,
  pizzintEnabled: true,
  pizzintIntervalSec: 600,
  gdeltTensionEnabled: true,
  gdeltTensionIntervalSec: 600,
  polymarketLeadsEnabled: true,
  polymarketLeadsIntervalSec: 600,
  keywordSpikeMinCount: 5,
  keywordSpikeMultiplier: 3,
  predictionShiftThreshold: 5,
  predictionNewsActivityThreshold: 3,
  openskyBaseUrl: "https://opensky-network.org/api",
  openskyTokenUrl: "https://auth.example/token",
  aisRelayBaseUrl: "",
  polymarketProxyUrl: "",
  openskyClientId: "client-id-from-server",
  openskyClientIdSource: "stored",
  hasAisRelaySharedSecret: true,
  aisRelaySharedSecretSource: "stored",
  hasOpenskyClientSecret: false,
  openskyClientSecretSource: "none",
  hasAcledAccessToken: false,
  acledAccessTokenSource: "none",
  acledAccessTokenStatus: "missing",
  acledAccessTokenExpiresAt: undefined,
  acledAccessTokenRefreshedAt: undefined,
  acledAccessTokenLastAttemptAt: undefined,
  acledAccessTokenLastError: undefined,
  acledOauthUsername: "",
  acledOauthUsernameSource: "none",
  hasAcledOauthPassword: false,
  acledOauthPasswordSource: "none",
  acledOauthClientId: "acled",
  acledOauthClientIdSource: "none",
  hasCloudflareApiToken: false,
  cloudflareApiTokenSource: "none",
  hasWingbitsApiKey: false,
  wingbitsApiKeySource: "none",
};

const DIAGNOSTICS = {
  checkedAt: "2026-09-06T00:00:00.000Z",
  settingsSource: "db",
  runtimeEnabled: true,
  insight: {
    keywordSpikes: [],
    predictionLeads: [],
    tensions: [],
  },
  markerReadiness: {
    windowHours: 24,
    recentProcessedArticles: 0,
    recentProcessedArticlesWithLocation: 0,
    recentMongoProcessedItems: 0,
    recentMongoProcessedItemsWithLocation: 0,
    newsMarkersReady: true,
  },
  sources: [],
};

describe("RealtimeSignalsSettingsPanel", () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    del.mockReset();
  });

  it("blocks the form when the initial settings GET fails and recovers via Retry", async () => {
    const user = userEvent.setup();
    get.mockImplementation((url: string) => {
      if (url === "system-settings/realtime-signals") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ data: DIAGNOSTICS });
    });
    const { RealtimeSignalsSettingsPanel } = await import(
      "./realtime-signals-settings-panel"
    );
    renderWithProviders(<RealtimeSignalsSettingsPanel />);

    expect(
      await screen.findByText("Failed to load realtime signals settings"),
    ).toBeInTheDocument();

    // settings 加载失败：不出现可提交表单（无 Save/Reset 按钮）
    expect(
      screen.queryByRole("button", { name: "Save changes" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reset to env" })
    ).not.toBeInTheDocument();

    // Retry 前把 mock 切为成功——Retry 必须用真实响应进入 ready 状态
    get.mockImplementation((url: string) => {
      if (url === "system-settings/realtime-signals") {
        return Promise.resolve({ data: SETTINGS });
      }
      return Promise.resolve({ data: DIAGNOSTICS });
    });

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save changes" })
      ).toBeInTheDocument();
    });
    expect(get).toHaveBeenCalledWith("system-settings/realtime-signals");
  });

  it("keeps the settings form when diagnostics fail, applies secret omit semantics, and a repeated submit only sends one PUT", async () => {
    const user = userEvent.setup();
    get.mockImplementation((url: string) => {
      if (url === "system-settings/realtime-signals") {
        return Promise.resolve({ data: SETTINGS });
      }
      return Promise.reject(new Error("diagnostics down"));
    });
    let resolvePut!: (value: { data: unknown }) => void;
    put.mockImplementation(
      () =>
        new Promise<{ data: unknown }>((resolve) => {
          resolvePut = resolve;
        }),
    );

    const { RealtimeSignalsSettingsPanel } = await import(
      "./realtime-signals-settings-panel"
    );
    renderWithProviders(<RealtimeSignalsSettingsPanel />);

    // settings 加载成功：真实服务器 clientId 出现（而不是默认值伪装）
    await screen.findByText("client-id-from-server");

    // diagnostics 失败：设置表单仍然存在
    await waitFor(() => {
      expect(
        screen.getByText("Failed to load runtime diagnostics.")
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "Save changes" })
    ).toBeInTheDocument();

    // secret：触碰后清空 → payload 中应发送 null；未触碰字段应被省略。
    // 5 个 secret 输入共用同一 placeholder，按渲染顺序取第 2 个（openskyClientSecret）。
    const secretInputs = await screen.findAllByPlaceholderText(
      "Leave empty to keep current value"
    );
    const openskySecret = secretInputs[1]!;
    await user.type(openskySecret, "x");
    await user.clear(openskySecret);

    // 第一次经按钮提交；随后表单 submit 事件路径（Enter/编程式，不经过按钮
    // disabled——FE-RT-02 门禁必须在 handler 层拦截）在挂起 PUT 期间重复触发
    const saveButton = screen.getByRole("button", {
      name: "Save changes",
    });
    await user.click(saveButton);
    await waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1);
    });
    const form = document.querySelector("form");
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    // 等待两次 submit 的验证/onFinish 链落定：门禁必须拦截（仍只有 1 次 PUT）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(put).toHaveBeenCalledTimes(1);

    expect(put).toHaveBeenCalledWith(
      "system-settings/realtime-signals",
      expect.objectContaining({
        openskyClientSecret: null,
      })
    );
    const payload = put.mock.calls[0]![1] as Record<string, unknown>;
    // 未触碰的 secret 字段不出现在 payload（保留服务器/环境值）
    expect(payload).not.toHaveProperty("aisRelaySharedSecret");
    expect(payload).not.toHaveProperty("acledOauthPassword");
    expect(payload).not.toHaveProperty("cloudflareApiToken");
    expect(payload).not.toHaveProperty("wingbitsApiKey");

    resolvePut({ data: SETTINGS });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(put).toHaveBeenCalledTimes(1);
  });
});
