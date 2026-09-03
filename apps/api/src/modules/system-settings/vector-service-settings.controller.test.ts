import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";
import { VectorClientService } from "../vector/vector-client.service";

import { UpdateVectorServiceSettingsDto } from "./dto/vector-service-settings.dto";
import { VectorServiceSettingsController } from "./vector-service-settings.controller";
import { VectorServiceSettingsService } from "./vector-service-settings.service";

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id: "user-1",
    orgId: "org-a",
    permissions: ["settings.manage"],
    ...overrides,
  }) as AuthenticatedUser;

const body = (): UpdateVectorServiceSettingsDto =>
  ({
    enabled: true,
    fallbackToMongo: false,
    baseUrl: "http://attacker.example",
    timeoutMs: 5000,
    maxRetries: 2,
  }) as UpdateVectorServiceSettingsDto;

const setup = (opts: { isPlatformAdmin: boolean }) => {
  const settings = {
    updateSettings: vi.fn().mockResolvedValue({ source: "db" }),
    resetToEnv: vi.fn().mockResolvedValue({ source: "env" }),
    getPublicSettings: vi.fn().mockResolvedValue({ source: "env" }),
  };
  const vectorClient = {
    getDiagnostics: vi.fn().mockResolvedValue({ snapshotAt: "x" }),
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
  const controller = new VectorServiceSettingsController(
    settings as unknown as VectorServiceSettingsService,
    vectorClient as unknown as VectorClientService,
    platformAccess as unknown as PlatformAccessService,
  );
  return { controller, settings, vectorClient, platformAccess };
};

// SEC-01 回归：vector 服务配置是全局单例且携带内部 token 的出口地址，
// 变更面必须限定平台管理员（复用 audit-log/email/task-log 的
// assertPlatformAdmin 模式）。settings.manage 只是必要条件，不是充分条件。
describe("VectorServiceSettingsController (SEC-01)", () => {
  it("rejects an org admin with settings.manage who is not a platform admin (PUT → 403)", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: false });

    // org 管理员：权限守卫层已通过（permissions 含 settings.manage），
    // 只差平台管理员身份——正是 SEC-01 的攻击者画像。
    await expect(
      controller.updateSettings(user(), body()),
    ).rejects.toThrow(ForbiddenException);

    expect(settings.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a settings.manage holder on DELETE (reset) with 403", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: false });

    await expect(controller.reset(user())).rejects.toThrow(ForbiddenException);

    expect(settings.resetToEnv).not.toHaveBeenCalled();
  });

  it("allows a platform admin to update global vector settings", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    const result = await controller.updateSettings(user(), body());

    expect(settings.updateSettings).toHaveBeenCalledWith("org-a", "user-1", body());
    expect(result).toEqual({ source: "db" });
  });

  it("allows a platform admin to reset global vector settings", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    await controller.reset(user());

    expect(settings.resetToEnv).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("keeps read endpoints on settings.manage only (no platform gate on GET)", async () => {
    const { controller, settings, vectorClient, platformAccess } = setup({
      isPlatformAdmin: false,
    });

    await controller.getSettings();
    await controller.getDiagnostics();

    // 读取与诊断沿用原有权限语义：合法 settings.manage 持有者可读。
    expect(settings.getPublicSettings).toHaveBeenCalled();
    expect(vectorClient.getDiagnostics).toHaveBeenCalled();
    expect(platformAccess.assertPlatformAdmin).not.toHaveBeenCalled();
  });

  it("checks platform admin on the acting user id", async () => {
    const { controller, platformAccess } = setup({ isPlatformAdmin: true });

    await controller.updateSettings(user({ id: "actor-9" }), body());

    expect(platformAccess.assertPlatformAdmin).toHaveBeenCalledWith("actor-9");
  });
});
