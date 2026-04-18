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
    service = new MfaService(prismaMock, authSecurityMock);
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
});
