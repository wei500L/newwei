import { UnauthorizedException } from "@nestjs/common";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

import { MfaService } from "./mfa.service";

jest.mock("./auth-flow.utils", () => ({
  buildOtpAuthUri: jest.fn().mockReturnValue("otpauth://modular/test"),
  generateRecoveryCodes: jest.fn().mockReturnValue(["RCODE-1", "RCODE-2"]),
  generateTotpSecret: jest.fn().mockReturnValue("SECRET"),
  hashOpaqueToken: jest.fn((value: string) => `hash:${value}`),
  verifyTotpCode: jest.fn().mockReturnValue(true),
}));

const authFlowUtilsMock = jest.requireMock("./auth-flow.utils") as {
  buildOtpAuthUri: jest.Mock;
  generateRecoveryCodes: jest.Mock;
  generateTotpSecret: jest.Mock;
  hashOpaqueToken: jest.Mock;
  verifyTotpCode: jest.Mock;
};

describe("MfaService", () => {
  const prismaMock = {
    userTotpFactor: {
      findUnique: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    userRecoveryCode: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    membership: {
      findUnique: jest.fn(),
    },
    authChallenge: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  } as any;

  const authSecurityMock = {
    encodeSecret: jest.fn(),
    decodeSecret: jest.fn(),
    getMfaPolicy: jest.fn(),
  } as any;

  const envMock = {
    authMfaChallengeConfig: {
      maxAttempts: 5,
    },
  } as any;

  let service: MfaService;

  beforeEach(() => {
    jest.resetAllMocks();
    authFlowUtilsMock.buildOtpAuthUri.mockReturnValue("otpauth://modular/test");
    authFlowUtilsMock.generateRecoveryCodes.mockReturnValue([
      "RCODE-1",
      "RCODE-2",
    ]);
    authFlowUtilsMock.generateTotpSecret.mockReturnValue("SECRET");
    authFlowUtilsMock.hashOpaqueToken.mockImplementation(
      (value: string) => `hash:${value}`,
    );
    authFlowUtilsMock.verifyTotpCode.mockReturnValue(true);
    prismaMock.$transaction = jest.fn(
      async (callback: (tx: typeof prismaMock) => Promise<unknown>) =>
        callback(prismaMock),
    );
    authSecurityMock.encodeSecret = jest
      .fn()
      .mockResolvedValue({ cipher: "encoded" });
    authSecurityMock.decodeSecret = jest.fn().mockResolvedValue("SECRET");
    prismaMock.authChallenge.updateMany = jest
      .fn()
      .mockResolvedValue({ count: 1 });
    service = new MfaService(prismaMock, authSecurityMock, envMock);
  });

  it("keeps the active MFA factor intact while a replacement enrollment is pending", async () => {
    prismaMock.userTotpFactor.findUnique.mockResolvedValue({
      verifiedAt: new Date("2026-04-18T00:00:00.000Z"),
      disabledAt: null,
    });

    const result = await service.beginEnrollment("user-1", "user@example.com");

    expect(prismaMock.userTotpFactor.update).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: expect.objectContaining({
        pendingSecret: { cipher: "encoded" },
        pendingLabel: "user@example.com",
      }),
    });
    expect(prismaMock.userRecoveryCode.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      secret: "SECRET",
      otpauthUri: "otpauth://modular/test",
    });
  });

  it("promotes a verified pending secret and rotates recovery codes", async () => {
    prismaMock.userTotpFactor.findUnique.mockResolvedValue({
      userId: "user-1",
      secret: { cipher: "active" },
      pendingSecret: { cipher: "pending" },
      label: "old@example.com",
      pendingLabel: "new@example.com",
      enrolledAt: new Date("2026-04-01T00:00:00.000Z"),
      verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
      disabledAt: null,
    });
    prismaMock.userRecoveryCode.count.mockResolvedValue(2);

    const result = await service.verifyEnrollment("user-1", "123456");

    expect(prismaMock.userTotpFactor.update).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: expect.objectContaining({
        secret: { cipher: "pending" },
        label: "new@example.com",
        pendingLabel: null,
        pendingStartedAt: null,
      }),
    });
    expect(prismaMock.userRecoveryCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prismaMock.userRecoveryCode.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "user-1", codeHash: "hash:RCODE-1" },
        { userId: "user-1", codeHash: "hash:RCODE-2" },
      ],
    });
    expect(result.recoveryCodes).toEqual(["RCODE-1", "RCODE-2"]);
  });

  it("records failed login challenge attempts without consuming the challenge", async () => {
    authFlowUtilsMock.verifyTotpCode.mockReturnValue(false);
    prismaMock.authChallenge.findUnique
      .mockResolvedValueOnce(loginChallenge({ failedAttempts: 0 }))
      .mockResolvedValueOnce({ failedAttempts: 1 });
    prismaMock.userTotpFactor.findUnique.mockResolvedValue({
      userId: "user-1",
      secret: { cipher: "active" },
      verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
      disabledAt: null,
    });
    prismaMock.userRecoveryCode.findFirst.mockResolvedValue(null);

    await expect(
      service.consumeLoginChallenge("challenge-1", "000000"),
    ).rejects.toThrow(UnauthorizedException);

    expect(prismaMock.authChallenge.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.authChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "challenge-1",
          consumedAt: null,
          lockedAt: null,
          failedAttempts: { lt: 5 },
        }),
        data: {
          failedAttempts: { increment: 1 },
        },
      }),
    );
  });

  it("locks a login challenge when the failed attempt limit is reached", async () => {
    authFlowUtilsMock.verifyTotpCode.mockReturnValue(false);
    prismaMock.authChallenge.findUnique
      .mockResolvedValueOnce(loginChallenge({ failedAttempts: 4 }))
      .mockResolvedValueOnce({ failedAttempts: 5 });
    prismaMock.userTotpFactor.findUnique.mockResolvedValue({
      userId: "user-1",
      secret: { cipher: "active" },
      verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
      disabledAt: null,
    });
    prismaMock.userRecoveryCode.findFirst.mockResolvedValue(null);

    await expect(
      service.consumeLoginChallenge("challenge-1", "000000"),
    ).rejects.toThrow(TooManyRequestsException);

    expect(prismaMock.authChallenge.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "challenge-1",
        lockedAt: null,
      },
      data: {
        lockedAt: expect.any(Date),
      },
    });
  });

  it("rejects locked login challenges before verifying the MFA code", async () => {
    prismaMock.authChallenge.findUnique.mockResolvedValueOnce(
      loginChallenge({ failedAttempts: 5, lockedAt: new Date() }),
    );

    await expect(
      service.consumeLoginChallenge("challenge-1", "123456"),
    ).rejects.toThrow(TooManyRequestsException);

    expect(prismaMock.userTotpFactor.findUnique).not.toHaveBeenCalled();
  });

  it("consumes a valid login challenge only while under the failed attempt limit", async () => {
    prismaMock.authChallenge.findUnique.mockResolvedValueOnce(
      loginChallenge({ failedAttempts: 4 }),
    );
    prismaMock.userTotpFactor.findUnique.mockResolvedValue({
      userId: "user-1",
      secret: { cipher: "active" },
      verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
      disabledAt: null,
    });

    const result = await service.consumeLoginChallenge(
      "challenge-1",
      "123456",
    );

    expect(result).toEqual({
      userId: "user-1",
      orgId: "org-1",
      ipAddress: "127.0.0.1",
      userAgent: "jest",
      action: "login",
    });
    expect(prismaMock.authChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "challenge-1",
          failedAttempts: { lt: 5 },
          lockedAt: null,
        }),
        data: {
          consumedAt: expect.any(Date),
        },
      }),
    );
  });

  it("applies the same failed attempt lockout to enrollment challenges", async () => {
    authFlowUtilsMock.verifyTotpCode.mockReturnValue(false);
    prismaMock.authChallenge.findUnique
      .mockResolvedValueOnce(
        loginChallenge({
          type: "mfa_enrollment",
          failedAttempts: 4,
        }),
      )
      .mockResolvedValueOnce({ failedAttempts: 5 });
    prismaMock.userTotpFactor.findUnique.mockResolvedValue({
      userId: "user-1",
      secret: { cipher: "pending" },
      pendingSecret: null,
    });

    await expect(
      service.consumeEnrollmentChallenge("challenge-1", "000000"),
    ).rejects.toThrow(TooManyRequestsException);

    expect(prismaMock.authChallenge.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "challenge-1",
        lockedAt: null,
      },
      data: {
        lockedAt: expect.any(Date),
      },
    });
  });
});

function loginChallenge(
  overrides: Partial<{
    type: "mfa_login" | "mfa_enrollment";
    failedAttempts: number;
    lockedAt: Date | null;
  }> = {},
) {
  return {
    id: "challenge-1",
    type: overrides.type ?? "mfa_login",
    userId: "user-1",
    orgId: "org-1",
    payload: {
      orgId: "org-1",
      ipAddress: "127.0.0.1",
      userAgent: "jest",
      action: "login",
    },
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    failedAttempts: overrides.failedAttempts ?? 0,
    lockedAt: overrides.lockedAt ?? null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}
