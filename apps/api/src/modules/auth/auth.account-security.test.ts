import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from "@nestjs/common";
import bcrypt from "bcrypt";
import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.service";

/**
 * AS2/AS3 unit coverage for AuthService. profile/changePassword only; the login,
 * refresh, MFA and OIDC flows are untouched.
 */
function setup() {
  const userFindUnique = vi.fn();
  const userUpdate = vi.fn().mockResolvedValue({});
  const txUserUpdateMany = vi.fn();
  const txRefreshUpdateMany = vi.fn();
  const membershipFindMany = vi.fn().mockResolvedValue([]);
  const membershipFindFirst = vi.fn().mockResolvedValue(null);
  const transactionClient = {
    user: { updateMany: txUserUpdateMany },
    refreshToken: { updateMany: txRefreshUpdateMany }
  };
  const transaction = vi.fn(async (run: unknown) => {
    if (typeof run !== "function") {
      throw new Error("array transaction form is not expected");
    }
    return (run as (client: unknown) => Promise<unknown>)(transactionClient);
  });
  const prisma = {
    user: { findUnique: userFindUnique, update: userUpdate },
    membership: { findMany: membershipFindMany, findFirst: membershipFindFirst },
    refreshToken: { updateMany: txRefreshUpdateMany },
    $transaction: transaction
  };
  const cache = {
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    wrap: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader())
  };
  const authCacheSettings = {
    getSettings: vi.fn().mockResolvedValue({
      profileTtlSeconds: 600,
      lockTtlMs: 5000,
      maxWaitMs: 5000,
      retryDelayMs: 50
    })
  };
  const storageService = { isPublicUrl: vi.fn().mockResolvedValue(true) };
  const platformAccess = { getGlobalRoles: vi.fn().mockResolvedValue([]) };
  const mfaService = { getStatus: vi.fn().mockResolvedValue({ enabled: false }) };

  const service = new AuthService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
    {} as never,
    {} as never,
    authCacheSettings as never,
    {} as never,
    {} as never,
    storageService as never,
    {} as never,
    platformAccess as never,
    mfaService as never
  );

  return {
    service,
    userFindUnique,
    userUpdate,
    txUserUpdateMany,
    txRefreshUpdateMany,
    membershipFindMany,
    transaction,
    cache,
    authCacheSettings,
    storageService,
    platformAccess,
    mfaService
  };
}

/** The accessible membership/user/cache fixtures updateProfile needs to resolve. */
function useReadableProfile(context: ReturnType<typeof setup>) {
  context.membershipFindMany.mockResolvedValue([
    {
      id: "membership-1",
      orgId: "org-1",
      isActive: true,
      roleId: "role-1",
      org: { isActive: true, slug: "org", planTier: "free", subscriptionStatus: "active" },
      roles: [],
      role: { id: "role-1", permissions: [] }
    }
  ]);
  context.userFindUnique.mockResolvedValue({
    id: "user-1",
    email: "user@example.com",
    emailVerified: null,
    lastLoginAt: null,
    pendingEmail: null,
    firstName: "Ada",
    lastName: "Lovelace",
    avatarUrl: null,
    isActive: true
  });
}

describe("AuthService changePassword (AS2)", () => {
  it("rejects identical raw password strings before any database access", async () => {
    const context = setup();
    await expect(
      context.service.changePassword("user-1", "org-1", "same-password", "same-password")
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(context.userFindUnique).not.toHaveBeenCalled();
  });

  it("returns 409 and rolls back when the compare-and-swap affects zero rows", async () => {
    const context = setup();
    const originalHash = await bcrypt.hash("current-password", 10);
    context.userFindUnique.mockResolvedValue({ id: "user-1", passwordHash: originalHash });
    context.txUserUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      context.service.changePassword("user-1", "org-1", "current-password", "brand-new-password")
    ).rejects.toBeInstanceOf(ConflictException);

    expect(context.txUserUpdateMany).toHaveBeenCalledWith({
      where: { id: "user-1", passwordHash: originalHash },
      data: { passwordHash: expect.any(String) }
    });
    // The losing request must not revoke any refresh token.
    expect(context.txRefreshUpdateMany).not.toHaveBeenCalled();
  });

  it("updates with a CAS and revokes every non-revoked refresh token in one transaction", async () => {
    const context = setup();
    const originalHash = await bcrypt.hash("current-password", 10);
    context.userFindUnique.mockResolvedValue({ id: "user-1", passwordHash: originalHash });
    context.txUserUpdateMany.mockResolvedValue({ count: 1 });
    context.txRefreshUpdateMany.mockResolvedValue({ count: 3 });

    await context.service.changePassword("user-1", "org-1", "current-password", "brand-new-password");

    expect(context.transaction).toHaveBeenCalledTimes(1);
    expect(context.txUserUpdateMany).toHaveBeenCalledWith({
      where: { id: "user-1", passwordHash: originalHash },
      data: { passwordHash: expect.any(String) }
    });
    expect(context.txRefreshUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
    expect(context.cache.del).toHaveBeenCalledWith("profile:user-1:org-1");
  });

  it("rejects a wrong current password with 401", async () => {
    const context = setup();
    context.userFindUnique.mockResolvedValue({
      id: "user-1",
      passwordHash: await bcrypt.hash("another-password", 10)
    });

    await expect(
      context.service.changePassword("user-1", "org-1", "current-password", "brand-new-password")
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(context.txUserUpdateMany).not.toHaveBeenCalled();
  });

  it("accepts a password whose first 72 bytes match the stored hash (Node bcrypt truncation)", async () => {
    const context = setup();
    const prefix = "a".repeat(72);
    context.userFindUnique.mockResolvedValue({
      id: "user-1",
      passwordHash: await bcrypt.hash(prefix, 10)
    });
    context.txUserUpdateMany.mockResolvedValue({ count: 1 });
    context.txRefreshUpdateMany.mockResolvedValue({ count: 1 });

    await context.service.changePassword("user-1", "org-1", `${prefix}-different-suffix`, "brand-new-password");
    expect(context.txUserUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("AuthService updateProfile (AS3)", () => {
  it("turns an explicit null into the empty-field 400 without writing", async () => {
    const context = setup();
    context.userFindUnique.mockResolvedValue({ id: "user-1" });

    await expect(
      context.service.updateProfile("user-1", "org-1", { firstName: null } as never)
    ).rejects.toThrow("First name cannot be empty");
    await expect(
      context.service.updateProfile("user-1", "org-1", { lastName: null } as never)
    ).rejects.toThrow("Last name cannot be empty");
    await expect(
      context.service.updateProfile("user-1", "org-1", { avatarUrl: null } as never)
    ).rejects.toThrow("Avatar URL cannot be empty");
    expect(context.userUpdate).not.toHaveBeenCalled();
  });

  it("returns 401 Invalid access token for a machine identity with no real user", async () => {
    const context = setup();
    context.userFindUnique.mockResolvedValue(null);

    await expect(
      context.service.updateProfile("machine:mtk_1", "org-1", {} as never)
    ).rejects.toThrow("Invalid access token");
    expect(context.userUpdate).not.toHaveBeenCalled();
  });

  it("does not update updatedAt for an empty body", async () => {
    const context = setup();
    useReadableProfile(context);

    const profile = await context.service.updateProfile("user-1", "org-1", {} as never);
    expect(context.userUpdate).not.toHaveBeenCalled();
    expect(profile.firstName).toBe("Ada");
    expect("accessTokenId" in profile).toBe(false);
  });

  it("validates the avatar against the storage base URL before writing", async () => {
    const context = setup();
    context.userFindUnique.mockResolvedValue({ id: "user-1" });
    context.storageService.isPublicUrl.mockResolvedValue(false);

    await expect(
      context.service.updateProfile("user-1", "org-1", { avatarUrl: "https://evil.test/a.png" } as never)
    ).rejects.toThrow("Avatar URL must use the approved storage base URL");
    expect(context.userUpdate).not.toHaveBeenCalled();
  });

  it("trims and writes exactly the provided fields, then returns the base profile", async () => {
    const context = setup();
    useReadableProfile(context);

    const profile = await context.service.updateProfile("user-1", "org-1", {
      firstName: "  Ada  ",
      lastName: "Lovelace"
    } as never);

    expect(context.userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { firstName: "Ada", lastName: "Lovelace" }
    });
    expect(context.cache.del).toHaveBeenCalledWith("profile:user-1:org-1");
    // PATCH intentionally differs from GET /me: no request metadata.
    expect("accessTokenId" in profile).toBe(false);
    expect("accessTokenExpiresAt" in profile).toBe(false);
  });
});
