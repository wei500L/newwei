import type { AuthenticatedUser } from "../auth/auth.service";

import { SituationMonitorSettingsController } from "./situation-monitor-settings.controller";

describe("SituationMonitorSettingsController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    email: "demo@example.com",
    orgId: "org-1",
    roleIds: ["role-1"],
    permissions: ["settings.manage"],
    firstName: "Demo",
    lastName: "User",
  };

  const settings = {
    getPublicSettings: jest.fn(),
    updateSettings: jest.fn(),
    resetToEnv: jest.fn(),
  } as const;
  const telegramAuth = {
    startAuth: jest.fn(),
    completeAuth: jest.fn(),
  } as const;
  const signals = {
    clearTelegramState: jest.fn(),
  } as const;
  const akshareService = {
    ensureRepeatableJobs: jest.fn(),
  } as const;
  const externalSnapshots = {
    getStatusSummary: jest.fn(),
    forceRefresh: jest.fn(),
  } as const;

  let controller: SituationMonitorSettingsController;

  beforeEach(() => {
    jest.resetAllMocks();
    settings.updateSettings.mockResolvedValue({
      telegramEnabled: false,
      telegramPollIntervalMs: 60_000,
      hasTelegramSession: false,
    });
    settings.getPublicSettings.mockResolvedValue({
      source: "env",
    });
    settings.resetToEnv.mockResolvedValue({
      telegramEnabled: false,
      telegramPollIntervalMs: 60_000,
      hasTelegramSession: false,
    });
    externalSnapshots.getStatusSummary.mockResolvedValue({
      enabled: true,
      intervalMinutes: 15,
      historyRetentionDays: 7,
      status: "idle",
      stale: false,
      partial: false,
      generatedAt: null,
      expiresAt: null,
      lastFullSuccessAt: null,
      lastNonSuccessAt: null,
      nextScheduledAt: "2026-03-28T00:15:00.000Z",
      warningCount: 0,
      availableCategoryCount: 0,
      rolling24hSuccessRate: null,
      rolling24hRateLimitedCount: 0,
      rolling24hAverageAvailableCategoryCount: null,
      warnings: [],
    });
    externalSnapshots.forceRefresh.mockResolvedValue({
      enabled: true,
      intervalMinutes: 15,
      historyRetentionDays: 7,
      status: "completed",
      stale: false,
      partial: false,
      generatedAt: "2026-03-28T00:00:00.000Z",
      expiresAt: "2026-03-28T00:20:00.000Z",
      lastFullSuccessAt: "2026-03-28T00:00:00.000Z",
      lastNonSuccessAt: null,
      nextScheduledAt: "2026-03-28T00:15:00.000Z",
      warningCount: 0,
      availableCategoryCount: 6,
      rolling24hSuccessRate: 100,
      rolling24hRateLimitedCount: 0,
      rolling24hAverageAvailableCategoryCount: 6,
      warnings: [],
    });
    controller = new SituationMonitorSettingsController(
      settings as any,
      telegramAuth as any,
      { redisConfig: {} } as any,
      signals as any,
      akshareService as any,
      externalSnapshots as any,
    );
    jest
      .spyOn(controller as never, "syncTelegramScheduleBestEffort" as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(controller as never, "syncEconomicDataScheduleBestEffort" as never)
      .mockResolvedValue(undefined as never);
  });

  it("re-syncs economic data jobs after provider settings update", async () => {
    await controller.updateSettings(user, { finnhubApiKey: "demo-key" } as never);

    expect(settings.updateSettings).toHaveBeenCalledWith("org-1", "user-1", {
      finnhubApiKey: "demo-key",
    });
    expect(
      (controller as unknown as { syncEconomicDataScheduleBestEffort: jest.Mock })
        .syncEconomicDataScheduleBestEffort,
    ).toHaveBeenCalledTimes(1);
    expect(externalSnapshots.getStatusSummary).toHaveBeenCalledTimes(1);
  });

  it("re-syncs economic data jobs after reset", async () => {
    await controller.reset(user);

    expect(settings.resetToEnv).toHaveBeenCalledWith("org-1", "user-1");
    expect(
      (controller as unknown as { syncEconomicDataScheduleBestEffort: jest.Mock })
        .syncEconomicDataScheduleBestEffort,
    ).toHaveBeenCalledTimes(1);
    expect(externalSnapshots.getStatusSummary).toHaveBeenCalledTimes(1);
  });

  it("returns snapshot status alongside the public settings payload", async () => {
    const result = await controller.getSettings();

    expect(settings.getPublicSettings).toHaveBeenCalledTimes(1);
    expect(externalSnapshots.getStatusSummary).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        source: "env",
        externalSnapshotStatus: expect.objectContaining({
          intervalMinutes: 15,
          status: "idle",
          nextScheduledAt: "2026-03-28T00:15:00.000Z",
        }),
      }),
    );
  });

  it("exposes a force refresh endpoint for the external snapshot", async () => {
    const result = await controller.forceExternalSnapshotRefresh();

    expect(externalSnapshots.forceRefresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        status: "completed",
        availableCategoryCount: 6,
        rolling24hSuccessRate: 100,
      }),
    );
  });
});
