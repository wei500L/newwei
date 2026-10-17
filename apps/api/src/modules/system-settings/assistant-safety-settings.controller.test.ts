import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { AssistantSafetyDiagnosticsService } from "./assistant-safety-diagnostics.service";
import { AssistantSafetyMetricsService } from "./assistant-safety-metrics.service";
import { AssistantSafetySettingsController } from "./assistant-safety-settings.controller";
import { AssistantSafetySettingsService } from "./assistant-safety-settings.service";
import { UpdateAssistantSafetySettingsDto } from "./dto/assistant-safety-settings.dto";

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id: "user-1",
    orgId: "org-a",
    permissions: ["settings.manage"],
    ...overrides,
  }) as AuthenticatedUser;

const body = (): UpdateAssistantSafetySettingsDto =>
  ({
    enabled: true,
    outputModerationEnabled: true,
  }) as UpdateAssistantSafetySettingsDto;

const setup = (opts: { isPlatformAdmin: boolean }) => {
  const settings = {
    updateSettings: vi.fn().mockResolvedValue({ source: "db" }),
    resetToEnv: vi.fn().mockResolvedValue({ source: "env" }),
    getPublicSettings: vi.fn().mockResolvedValue({ source: "env" }),
  };
  const diagnostics = { run: vi.fn().mockResolvedValue({ ok: true }) };
  const metrics = {
    getDailyMetrics: vi.fn().mockResolvedValue([]),
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
  const controller = new AssistantSafetySettingsController(
    settings as unknown as AssistantSafetySettingsService,
    diagnostics as unknown as AssistantSafetyDiagnosticsService,
    metrics as unknown as AssistantSafetyMetricsService,
    platformAccess as unknown as PlatformAccessService,
  );
  return { controller, settings, diagnostics, metrics, platformAccess };
};

// SEC-05 回归：`assistant_safety` 是全局单例键——普通组织管理员一旦能写，
// 就能关闭全平台的 LiteLLM 内容审核护栏。写接口必须限定平台管理员。
describe("AssistantSafetySettingsController (SEC-05)", () => {
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

  it("allows a platform admin to update the global guardrails", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    const result = await controller.updateSettings(user(), body());

    expect(settings.updateSettings).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      body(),
    );
    expect(result).toEqual({ source: "db" });
  });

  it("allows a platform admin to reset the global guardrails", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    await controller.reset(user());

    expect(settings.resetToEnv).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("keeps GET, diagnostics and metrics on settings.manage only (no platform gate)", async () => {
    const { controller, settings, diagnostics, metrics, platformAccess } =
      setup({ isPlatformAdmin: false });

    await controller.getSettings();
    await controller.runDiagnostics();
    await controller.getMetrics(user(), "7");

    expect(settings.getPublicSettings).toHaveBeenCalled();
    expect(diagnostics.run).toHaveBeenCalled();
    expect(metrics.getDailyMetrics).toHaveBeenCalledWith("org-a", 7);
    expect(platformAccess.assertPlatformAdmin).not.toHaveBeenCalled();
  });
});
