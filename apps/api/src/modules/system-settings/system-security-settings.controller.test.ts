import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { UpdateSystemSecuritySettingsDto } from "./dto/system-security-settings.dto";
import { SystemSecuritySettingsController } from "./system-security-settings.controller";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id: "user-1",
    orgId: "org-a",
    permissions: ["settings.manage"],
    ...overrides,
  }) as AuthenticatedUser;

const body = (): UpdateSystemSecuritySettingsDto =>
  ({
    secretEncryptionEnabled: true,
    mfaPolicy: "admins_only",
  }) as UpdateSystemSecuritySettingsDto;

const setup = (opts: { isPlatformAdmin: boolean }) => {
  const securitySettings = {
    updateSettings: vi.fn().mockResolvedValue({ mfaPolicy: "admins_only" }),
    getPublicSettings: vi.fn().mockResolvedValue({ mfaPolicy: "off" }),
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
  const controller = new SystemSecuritySettingsController(
    securitySettings as unknown as SystemSecuritySettingsService,
    platformAccess as unknown as PlatformAccessService,
  );
  return { controller, securitySettings, platformAccess };
};

// SEC-05 回归：`system_security` 是全局单例键（无 org 维度），其中 mfaPolicy
// 是全平台 MFA 策略。settings.manage 只是必要条件，不是充分条件——写接口
// 必须复用 task-log / vector-service 的 assertPlatformAdmin 模式。
describe("SystemSecuritySettingsController (SEC-05)", () => {
  it("rejects an org admin with settings.manage who is not a platform admin (PUT → 403)", async () => {
    const { controller, securitySettings } = setup({ isPlatformAdmin: false });

    await expect(controller.updateSettings(user(), body())).rejects.toThrow(
      ForbiddenException,
    );

    expect(securitySettings.updateSettings).not.toHaveBeenCalled();
  });

  it("allows a platform admin to update the global security settings", async () => {
    const { controller, securitySettings } = setup({ isPlatformAdmin: true });

    const result = await controller.updateSettings(user(), body());

    expect(securitySettings.updateSettings).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      body(),
    );
    expect(result).toEqual({ mfaPolicy: "admins_only" });
  });

  it("checks platform admin on the acting user id", async () => {
    const { controller, platformAccess } = setup({ isPlatformAdmin: true });

    await controller.updateSettings(user({ id: "actor-9" }), body());

    expect(platformAccess.assertPlatformAdmin).toHaveBeenCalledWith("actor-9");
  });

  it("keeps the read endpoint on settings.manage only (no platform gate on GET)", async () => {
    const { controller, securitySettings, platformAccess } = setup({
      isPlatformAdmin: false,
    });

    await controller.getSettings();

    expect(securitySettings.getPublicSettings).toHaveBeenCalled();
    expect(platformAccess.assertPlatformAdmin).not.toHaveBeenCalled();
  });
});
