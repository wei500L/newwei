import { UnauthorizedException } from "@nestjs/common";
import crypto from "node:crypto";

import { MachineTokenService } from "./machine-token.service";

const prismaMock = {
  machineAccessToken: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
} as any;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

describe("MachineTokenService", () => {
  let service: MachineTokenService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MachineTokenService(prismaMock);
  });

  it("creates a one-time machine token and stores only the hash", async () => {
    prismaMock.machineAccessToken.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: "token-1",
        name: data.name,
        expiresAt: data.expiresAt,
      }),
    );

    const result = await service.create({
      orgId: "org-1",
      actorId: "user-1",
      name: "Metrics bot",
      permissions: ["metrics.read", "items.read", "settings.manage"],
      expiresAt: null,
    });

    expect(result.token).toMatch(/^mtk_/);
    expect(result.permissions).toEqual(["metrics.read"]);
    expect(prismaMock.machineAccessToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org-1",
        name: "Metrics bot",
        permissions: ["metrics.read"],
        createdById: "user-1",
        tokenHash: expect.not.stringContaining(result.token),
      }),
    });
    expect(
      prismaMock.machineAccessToken.create.mock.calls[0][0].data.tokenHash,
    ).toHaveLength(64);
  });

  it("validates active tokens into authenticated machine users", async () => {
    const token = "mtk_test-token";
    prismaMock.machineAccessToken.findUnique.mockResolvedValue({
      id: "token-1",
      orgId: "org-1",
      name: "Metrics bot",
      permissions: ["metrics.read"],
      revokedAt: null,
      expiresAt: null,
      org: { isActive: true, planTier: "pro", subscriptionStatus: "active" },
    });
    prismaMock.machineAccessToken.update.mockResolvedValue({});

    const user = await service.validate(token);

    expect(prismaMock.machineAccessToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(token) },
      include: { org: true },
    });
    expect(user).toMatchObject({
      id: "machine:token-1",
      orgId: "org-1",
      permissions: ["metrics.read"],
      isActive: true,
    });
  });

  it("rejects inactive, revoked, or expired machine tokens", async () => {
    prismaMock.machineAccessToken.findUnique.mockResolvedValue({
      id: "token-1",
      orgId: "org-1",
      name: "Metrics bot",
      permissions: ["metrics.read"],
      revokedAt: new Date(),
      expiresAt: null,
      org: { isActive: true },
    });

    await expect(service.validate("mtk_revoked")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
