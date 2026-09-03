import { describe, expect, it, vi } from "vitest";

import { UpdateOnboardingUiSettingsDto } from "./dto/onboarding-ui-settings.dto";
import { UserSettingsService } from "./user-settings.service";
import { UserUiSettingsController } from "./user-ui-settings.controller";

const user = () =>
  ({
    id: "user-1",
    orgId: "org-a",
    permissions: ["items.read"],
  }) as Parameters<UserUiSettingsController["updateOnboardingUiSettings"]>[0];

const setup = () => {
  const service = {
    getOnboardingUiSettings: vi.fn().mockResolvedValue({
      version: 1,
      updatedAt: { settings: "2026-09-03T00:00:00.000Z" },
      settings: {
        completed: true,
        dismissed: false,
        checklist: { today: true, events: true, map: true, finance: true },
        completedTours: { today: true },
      },
    }),
    updateOnboardingUiSettings: vi
      .fn()
      .mockImplementation(
        async (orgId: string, userId: string, input: { settings?: unknown }) => {
          // 与真实 service 一致：input.settings 未传时为 no-op 写。
          if (input.settings === undefined) {
            return service.getOnboardingUiSettings(orgId, userId);
          }
          return service.getOnboardingUiSettings(orgId, userId);
        },
      ),
  };
  const controller = new UserUiSettingsController(
    service as unknown as UserSettingsService,
  );
  return { controller, service };
};

// API-01 静态闭环回归：onboarding GET/PUT 依赖 @Permissions("items.read")
// 元数据通过全局 PermissionsGuard（fail-closed）。本测试锚定 controller →
// service 的调用契约（orgId/userId 来源与请求体字段名），防止再次出现
// 「前端调用但后端 403 PERMISSION_METADATA_MISSING」的死路由。
// 注意：guard 层的 403 语义由鉴权矩阵（tools/generate-auth-matrix.ts）
// 覆盖，这里只锚定 handler 本身。
describe("UserUiSettingsController onboarding (API-01)", () => {
  it("GET passes current user's orgId and userId to the service", async () => {
    const { controller, service } = setup();

    await controller.getOnboardingUiSettings(user());

    expect(service.getOnboardingUiSettings).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("PUT passes orgId, userId and the settings body field to the service", async () => {
    const { controller, service } = setup();
    const body: UpdateOnboardingUiSettingsDto = {
      settings: { completed: true, dismissed: false },
    };

    await controller.updateOnboardingUiSettings(user(), body);

    expect(service.updateOnboardingUiSettings).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      body,
    );
  });

  it("PUT with missing settings field is forwarded verbatim (service treats as no-op)", async () => {
    const { controller, service } = setup();
    const body: UpdateOnboardingUiSettingsDto = {};

    await controller.updateOnboardingUiSettings(user(), body);

    expect(service.updateOnboardingUiSettings).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      body,
    );
  });

  it("GET response echoes the persisted settings envelope", async () => {
    const { controller } = setup();

    const result = await controller.getOnboardingUiSettings(user());

    expect(result.version).toBe(1);
    expect(result.settings?.completed).toBe(true);
    expect(result.updatedAt.settings).toBe("2026-09-03T00:00:00.000Z");
  });
});
