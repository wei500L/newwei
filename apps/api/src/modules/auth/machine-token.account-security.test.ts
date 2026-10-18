import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MachineTokenService } from "./machine-token.service";

/**
 * AS1/AS4 unit coverage for MachineTokenService. The interactive transaction is
 * mocked so the test can assert which Prisma client each statement runs on:
 * rotate must never escape onto `this.prisma`.
 */
function setup() {
  const txCreate = vi.fn();
  const txFindFirst = vi.fn();
  const txUpdateMany = vi.fn();
  const prismaCreate = vi.fn();
  const prismaUpdateMany = vi.fn();
  const transactionClient = {
    machineAccessToken: {
      create: txCreate,
      findFirst: txFindFirst,
      updateMany: txUpdateMany
    }
  };
  const transaction = vi.fn(async (run: unknown) => {
    if (typeof run !== "function") {
      throw new Error("array transaction form is not expected");
    }
    return (run as (client: unknown) => Promise<unknown>)(transactionClient);
  });
  const prisma = {
    machineAccessToken: {
      create: prismaCreate,
      findFirst: vi.fn(),
      updateMany: prismaUpdateMany
    },
    $transaction: transaction
  };
  const service = new MachineTokenService(prisma as never, {} as never);
  return {
    service,
    transaction,
    txCreate,
    txFindFirst,
    txUpdateMany,
    prismaCreate,
    prismaUpdateMany
  };
}

const storedRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "mtk_old",
  orgId: "org-1",
  name: "legacy token",
  permissions: ["metrics.read"],
  createdById: "user-1",
  expiresAt: null,
  revokedAt: null,
  ...overrides
});

describe("MachineTokenService rotate (AS1)", () => {
  it("revokes and re-creates through the transaction client", async () => {
    const context = setup();
    context.txFindFirst.mockResolvedValue(storedRecord());
    context.txUpdateMany.mockResolvedValue({ count: 1 });
    context.txCreate.mockResolvedValue({
      id: "mtk_new",
      name: "legacy token",
      expiresAt: null
    });

    const result = await context.service.rotate("org-1", "mtk_old");

    expect(context.transaction).toHaveBeenCalledTimes(1);
    expect(context.txFindFirst).toHaveBeenCalledWith({
      where: { id: "mtk_old", orgId: "org-1", revokedAt: null }
    });
    expect(context.txUpdateMany).toHaveBeenCalledWith({
      where: { id: "mtk_old", orgId: "org-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
    expect(context.txCreate).toHaveBeenCalledTimes(1);
    // The INSERT must run on the transaction client, never on this.prisma.
    expect(context.prismaCreate).not.toHaveBeenCalled();
    expect(context.txCreate.mock.calls[0][0].data.createdById).toBe("user-1");
    expect(result.id).toBe("mtk_new");
    expect(result.token.startsWith("mtk_")).toBe(true);
  });

  it("keeps the old row untouched when the stored permissions normalize away", async () => {
    const context = setup();
    // A historical settings.manage-only token: the create-time whitelist empties.
    context.txFindFirst.mockResolvedValue(
      storedRecord({ permissions: ["settings.manage"] })
    );

    await expect(context.service.rotate("org-1", "mtk_old")).rejects.toThrow(
      "At least one supported permission is required"
    );
    expect(context.txUpdateMany).not.toHaveBeenCalled();
    expect(context.txCreate).not.toHaveBeenCalled();
  });

  it("fails with the shared error when the conditional revoke affects zero rows", async () => {
    const context = setup();
    context.txFindFirst.mockResolvedValue(storedRecord());
    context.txUpdateMany.mockResolvedValue({ count: 0 });

    await expect(context.service.rotate("org-1", "mtk_old")).rejects.toThrow(
      "Machine token not found or already revoked"
    );
    expect(context.txCreate).not.toHaveBeenCalled();
  });

  it("propagates a failed INSERT without revoking through the public create", async () => {
    const context = setup();
    context.txFindFirst.mockResolvedValue(storedRecord());
    context.txUpdateMany.mockResolvedValue({ count: 1 });
    context.txCreate.mockRejectedValue(new Error("insert failed"));

    await expect(context.service.rotate("org-1", "mtk_old")).rejects.toThrow(
      "insert failed"
    );
    // The public create path (this.prisma) must never be reached: it would
    // escape the transaction and leave the old token revoked without a
    // successor.
    expect(context.prismaCreate).not.toHaveBeenCalled();
  });

  it("inherits the original creator and never the current operator", async () => {
    const context = setup();
    context.txFindFirst.mockResolvedValue(
      storedRecord({ createdById: "original-creator" })
    );
    context.txUpdateMany.mockResolvedValue({ count: 1 });
    context.txCreate.mockResolvedValue({
      id: "mtk_new",
      name: "legacy token",
      expiresAt: null
    });

    await context.service.rotate("org-1", "mtk_old");
    expect(context.txCreate.mock.calls[0][0].data.createdById).toBe(
      "original-creator"
    );
  });
});

describe("MachineTokenService create (AS4)", () => {
  it("rejects a whitespace-only name after trimming", async () => {
    const context = setup();
    await expect(
      context.service.create({
        orgId: "org-1",
        actorId: "user-1",
        name: "   ",
        permissions: ["metrics.read"]
      })
    ).rejects.toThrow("Machine token name cannot be empty");
    expect(context.prismaCreate).not.toHaveBeenCalled();
  });

  it("checks the permission whitelist before the name", async () => {
    const context = setup();
    await expect(
      context.service.create({
        orgId: "org-1",
        actorId: "user-1",
        name: "  ",
        permissions: ["settings.manage"]
      })
    ).rejects.toThrow("At least one supported permission is required");
  });

  it("stores SQL NULL for a machine or empty creator and keeps a human id", async () => {
    const context = setup();
    context.prismaCreate.mockResolvedValue({
      id: "mtk_new",
      name: "ci",
      expiresAt: null
    });

    await context.service.create({
      orgId: "org-1",
      actorId: "machine:mtk_creator",
      name: "  ci  ",
      permissions: [" metrics.read "]
    });
    expect(context.prismaCreate.mock.calls[0][0].data.createdById).toBeNull();
    expect(context.prismaCreate.mock.calls[0][0].data.name).toBe("ci");
    expect(context.prismaCreate.mock.calls[0][0].data.permissions).toEqual([
      "metrics.read"
    ]);

    await context.service.create({
      orgId: "org-1",
      actorId: "user-1",
      name: "ci",
      permissions: ["metrics.read"]
    });
    expect(context.prismaCreate.mock.calls[1][0].data.createdById).toBe("user-1");

    await context.service.create({
      orgId: "org-1",
      actorId: undefined,
      name: "ci",
      permissions: ["metrics.read"]
    });
    expect(context.prismaCreate.mock.calls[2][0].data.createdById).toBeNull();
  });

  it("still rejects an unsupported-only permission list", async () => {
    const context = setup();
    await expect(
      context.service.create({
        orgId: "org-1",
        actorId: "user-1",
        name: "ci",
        permissions: ["settings.manage"]
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("MachineTokenService revoke", () => {
  it("uses one shared error for every miss", async () => {
    const context = setup();
    context.prismaUpdateMany.mockResolvedValue({ count: 0 });
    await expect(context.service.revoke("org-1", "mtk_x")).rejects.toThrow(
      "Machine token not found or already revoked"
    );
    expect(context.prismaUpdateMany).toHaveBeenCalledWith({
      where: { id: "mtk_x", orgId: "org-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
  });
});

// Keep the unused import path meaningful for future tests without weakening
// assertions.
beforeEach(() => {
  vi.clearAllMocks();
});
