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

  let controller: SituationMonitorSettingsController;

  beforeEach(() => {
    jest.resetAllMocks();
    settings.updateSettings.mockResolvedValue({
      telegramEnabled: false,
      telegramPollIntervalMs: 60_000,
      hasTelegramSession: false,
    });
    settings.resetToEnv.mockResolvedValue({
      telegramEnabled: false,
      telegramPollIntervalMs: 60_000,
      hasTelegramSession: false,
    });
    controller = new SituationMonitorSettingsController(
      settings as any,
      telegramAuth as any,
      { redisConfig: {} } as any,
      signals as any,
      akshareService as any,
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
  });

  it("re-syncs economic data jobs after reset", async () => {
    await controller.reset(user);

    expect(settings.resetToEnv).toHaveBeenCalledWith("org-1", "user-1");
    expect(
      (controller as unknown as { syncEconomicDataScheduleBestEffort: jest.Mock })
        .syncEconomicDataScheduleBestEffort,
    ).toHaveBeenCalledTimes(1);
  });
});
