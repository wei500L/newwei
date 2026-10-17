import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { UpdateLlmRequestLogSettingsDto } from "./dto/llm-request-log-settings.dto";
import { LlmRequestLogSettingsController } from "./llm-request-log-settings.controller";
import { LlmRequestLogSettingsService } from "./llm-request-log-settings.service";

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id: "user-1",
    orgId: "org-a",
    permissions: ["settings.manage"],
    ...overrides,
  }) as AuthenticatedUser;

const body = (): UpdateLlmRequestLogSettingsDto =>
  ({ retentionDays: 45 }) as UpdateLlmRequestLogSettingsDto;

const setup = (opts: { isPlatformAdmin: boolean }) => {
  const settings = {
    updateSettings: vi.fn().mockResolvedValue({ source: "db" }),
    resetToDefault: vi.fn().mockResolvedValue({ source: "default" }),
    resetMetadataPolicy: vi.fn().mockResolvedValue({ source: "db" }),
    getSettings: vi.fn().mockResolvedValue({ source: "default" }),
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
  const controller = new LlmRequestLogSettingsController(
    settings as unknown as LlmRequestLogSettingsService,
    platformAccess as unknown as PlatformAccessService,
  );
  return { controller, settings, platformAccess };
};

// SEC-05 回归：`llm_request_log_settings` 是全局单例键，并驱动 llmrequestlogs
// 上的 Mongo TTL 索引。普通组织管理员一旦能写，就能把保留期改成 1 天，让
// 所有租户的请求日志被 TTL 删除。
describe("LlmRequestLogSettingsController (SEC-05)", () => {
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

    expect(settings.resetToDefault).not.toHaveBeenCalled();
  });

  it("rejects a settings.manage holder on POST metadata-policy/reset with 403", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: false });

    await expect(controller.resetMetadataPolicy(user())).rejects.toThrow(
      ForbiddenException,
    );

    expect(settings.resetMetadataPolicy).not.toHaveBeenCalled();
  });

  it("allows a platform admin to update the global llm request log settings", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    const result = await controller.updateSettings(user(), body());

    expect(settings.updateSettings).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      body(),
    );
    expect(result).toEqual({ source: "db" });
  });

  it("allows a platform admin to reset and to reset the metadata policy", async () => {
    const { controller, settings } = setup({ isPlatformAdmin: true });

    await controller.reset(user());
    await controller.resetMetadataPolicy(user());

    expect(settings.resetToDefault).toHaveBeenCalledWith("org-a", "user-1");
    expect(settings.resetMetadataPolicy).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("keeps the read endpoint on settings.manage only (no platform gate on GET)", async () => {
    const { controller, settings, platformAccess } = setup({
      isPlatformAdmin: false,
    });

    await controller.getSettings();

    expect(settings.getSettings).toHaveBeenCalled();
    expect(platformAccess.assertPlatformAdmin).not.toHaveBeenCalled();
  });
});
