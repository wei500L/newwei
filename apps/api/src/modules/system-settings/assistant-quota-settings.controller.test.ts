import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { AssistantQuotaSettingsController } from "./assistant-quota-settings.controller";
import { AssistantQuotaSettingsService } from "./assistant-quota-settings.service";
import { UpdateAssistantQuotaSettingsDto } from "./dto/assistant-quota-settings.dto";

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id: "user-1",
    orgId: "org-a",
    permissions: ["settings.manage"],
    ...overrides,
  }) as AuthenticatedUser;

const body = (): UpdateAssistantQuotaSettingsDto =>
  ({
    enabled: true,
    submitLimitPerHour: 30,
    maxInFlightPerOrg: 2,
    monthlyTokenBudget: 2_000_000,
  }) as UpdateAssistantQuotaSettingsDto;

const setup = (opts: { isPlatformAdmin: boolean }) => {
  const settings = {
    updateSettings: vi.fn().mockResolvedValue({ source: "db" }),
    resetToEnv: vi.fn().mockResolvedValue({ source: "env" }),
    getPublicSettings: vi.fn().mockResolvedValue({ source: "env" }),
  };
  const platformAccess = {
    assertPlatformAdmin: vi.fn().mockImplementation(async () => {
      if (!opts.isPlatformAdmin) {
        throw new ForbiddenException("Platform admin access required");
      }
      return undefined;
    }),
    isPlatformAdmin: vi.fn().mockResolvedValue(opts.isPlatformAdmin),
  };
  const controller = new AssistantQuotaSettingsController(
    settings as unknown as AssistantQuotaSettingsService,
    platformAccess as unknown as PlatformAccessService,
  );
  return { controller, settings, platformAccess };
};

// SEC-05 回归：`assistant_quota` 是全局单例键，小时提交上限、并发上限与月
// token 预算对所有租户生效。普通组织管理员不得改写，也不得整行重置。
describe("AssistantQuotaSettingsController (SEC-05)", () => {
  it("rejects an org admin with settings.manage who is not a platform admin (PUT → 403)", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: false });

    await expect(controller.updateSettings(user(), body())).rejects.toThrow(
      ForbiddenException,
    );

    expect(settings.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a settings.manage holder on DELETE (reset) with 403", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: false });

    await expect(controller.reset(user())).rejects.toThrow(ForbiddenException);

    expect(settings.resetToEnv).not.toHaveBeenCalled();
  });

  it("allows a platform admin to update the global assistant quota", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    const result = await controller.updateSettings(user(), body());

    expect(settings.updateSettings).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      body(),
    );
    expect(result).toEqual({ source: "db" });
  });

  it("allows a platform admin to reset the global assistant quota", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    await controller.reset(user());

    expect(settings.resetToEnv).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("keeps the read endpoint on settings.manage only (no platform gate on GET)", async () => {
    const { controller, settings, platformAccess } = setup({
      isPlatformAdmin: false,
    });

    await controller.getSettings(user());

    expect(settings.getPublicSettings).toHaveBeenCalledWith("org-a");
    expect(platformAccess.assertPlatformAdmin).not.toHaveBeenCalled();
  });
});
