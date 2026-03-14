import type { AuthenticatedUser } from "../auth/auth.service";

import { SituationMonitorController } from "./situation-monitor.controller";

describe("SituationMonitorController", () => {
  const monitorMock = {
    getInsights: jest.fn(),
  };
  const monitorsMock = {
    augmentInsights: jest.fn(),
    augmentTelegramFeed: jest.fn(),
    augmentOrefAlerts: jest.fn(),
    augmentOrefHistory: jest.fn(),
    listMonitors: jest.fn(),
    previewMonitor: jest.fn(),
    createMonitor: jest.fn(),
    updateMonitor: jest.fn(),
    deleteMonitor: jest.fn(),
  };
  const feedbackMock = {
    recordFeedback: jest.fn(),
  };
  const translationMock = {
    applyZhTranslationsBestEffort: jest.fn(),
  };
  const signalsMock = {
    getTelegramFeed: jest.fn(),
    getOrefAlerts: jest.fn(),
    getOrefHistory: jest.fn(),
  };
  const settingsMock = {
    getLiveHlsProxyRuntimeConfig: jest.fn(),
  };

  const user: AuthenticatedUser = {
    id: "user-1",
    email: "demo@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: ["items.read"],
    firstName: "Demo",
    lastName: "User",
  };

  let controller: SituationMonitorController;

  beforeEach(() => {
    jest.resetAllMocks();
    settingsMock.getLiveHlsProxyRuntimeConfig.mockResolvedValue({
      channel: "cnn",
      configured: true,
      upstreamUrl: "https://media.example.net/live/cnn/master.m3u8",
      referer: "https://example.com",
      allowedHosts: ["media.example.net"],
    });

    controller = new SituationMonitorController(
      monitorMock as any,
      monitorsMock as any,
      feedbackMock as any,
      translationMock as any,
      signalsMock as any,
      settingsMock as any,
    );
  });

  it("returns unconfigured payload for invalid proxy channel", async () => {
    const result = await controller.liveHlsProxyConfig(user, "invalid");

    expect(result).toEqual({
      channel: "invalid",
      configured: false,
      upstreamUrl: null,
      referer: null,
      allowedHosts: [],
    });
    expect(settingsMock.getLiveHlsProxyRuntimeConfig).not.toHaveBeenCalled();
  });

  it("normalizes channel and delegates to settings service", async () => {
    await controller.liveHlsProxyConfig(user, " CNN ");

    expect(settingsMock.getLiveHlsProxyRuntimeConfig).toHaveBeenCalledWith("cnn");
  });
});
