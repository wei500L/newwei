import { createHash } from "node:crypto";

import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "../auth/auth.service";
import { MachineTokenService } from "../auth/machine-token.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { MetricsController } from "./metrics.controller";

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id: "user-1",
    orgId: "org-a",
    permissions: ["metrics.read"],
    ...overrides,
  }) as AuthenticatedUser;

const request = (authorization: string) =>
  ({ headers: { authorization } }) as never;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function setup() {
  const findUnique = vi.fn();
  const prisma = { machineAccessToken: { findUnique } };
  const platformAccess = {
    assertPlatformAdmin: vi.fn().mockResolvedValue(undefined),
    isPlatformAdmin: vi.fn().mockResolvedValue(false),
  };
  const machineTokens = new MachineTokenService(
    prisma as never,
    platformAccess as unknown as PlatformAccessService,
  );
  const controller = new MetricsController(
    platformAccess as unknown as PlatformAccessService,
    machineTokens,
  );
  return { controller, findUnique, platformAccess };
}

describe("MetricsController (SEC-03)", () => {
  it("rejects an org member who has metrics.read but is not a platform admin", async () => {
    const { controller, findUnique, platformAccess } = setup();
    findUnique.mockResolvedValue(null);
    platformAccess.assertPlatformAdmin.mockRejectedValue(
      new ForbiddenException("Platform admin access required"),
    );

    await expect(
      controller.scrape(user(), request("Bearer human-access-token")),
    ).rejects.toThrow(ForbiddenException);

    expect(platformAccess.assertPlatformAdmin).toHaveBeenCalledWith("user-1");
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: tokenHash("human-access-token") },
      }),
    );
  });

  it("returns the full platform scrape for a platform admin", async () => {
    const { controller, platformAccess } = setup();
    const body = await controller.scrape(
      user({ id: "platform-1" }),
      request("Bearer human-access-token"),
    );

    expect(platformAccess.assertPlatformAdmin).toHaveBeenCalledWith("platform-1");
    expect(body).toContain("process_resident_memory_bytes");
    expect(body.length).toBeGreaterThan(200);
  });

  it("rejects a machine token created or left by an ordinary org admin", async () => {
    const { controller, findUnique, platformAccess } = setup();
    const secret = "mtk_org-admin-legacy-token";
    findUnique.mockResolvedValue({
      createdById: "org-admin-1",
      revokedAt: null,
      expiresAt: null,
      org: { isActive: true },
    });

    await expect(
      controller.scrape(user({ id: "machine:row-1" }), request(`Bearer ${secret}`)),
    ).rejects.toThrow(/Platform admin access required/);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: tokenHash(secret) } }),
    );
    expect(platformAccess.isPlatformAdmin).toHaveBeenCalledWith("org-admin-1");
    expect(platformAccess.assertPlatformAdmin).not.toHaveBeenCalled();

    findUnique.mockResolvedValue({
      createdById: null,
      revokedAt: null,
      expiresAt: null,
      org: { isActive: true },
    });
    await expect(
      controller.scrape(user(), request("Bearer mtk_creator-deleted")),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows a machine token whose creator is currently a platform admin", async () => {
    const { controller, findUnique, platformAccess } = setup();
    platformAccess.isPlatformAdmin.mockImplementation(
      async (userId: string) => userId === "platform-creator",
    );
    findUnique.mockResolvedValue({
      createdById: "platform-creator",
      revokedAt: null,
      expiresAt: null,
      org: { isActive: true },
    });
    const secret = "collector-secret-without-prefix";

    const body = await controller.scrape(
      user({ id: "machine:row-9", permissions: ["metrics.read"] }),
      request(`Bearer ${secret}`),
    );

    expect(platformAccess.isPlatformAdmin).toHaveBeenCalledWith("platform-creator");
    expect(platformAccess.assertPlatformAdmin).not.toHaveBeenCalled();
    expect(body).toContain("process_resident_memory_bytes");
    expect(body).not.toMatch(/"orgId"/);
  });
});
