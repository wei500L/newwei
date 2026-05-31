import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";

import { PasswordResetService } from "./password-reset.service";

describe("PasswordResetService", () => {
  const prismaMock = {
    user: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    passwordResetToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    refreshToken: {
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  } as any;

  const emailServiceMock = {
    send: jest.fn(),
  } as any;

  const actionRateLimitMock = {
    enforcePasswordResetRequest: jest.fn(),
  } as any;

  let service: PasswordResetService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction = jest.fn(
      async (callback: (tx: typeof prismaMock) => Promise<unknown>) =>
        callback(prismaMock),
    );
    actionRateLimitMock.enforcePasswordResetRequest = jest
      .fn()
      .mockResolvedValue(undefined);
    service = new PasswordResetService(
      prismaMock,
      emailServiceMock,
      actionRateLimitMock,
    );
  });

  it("enforces rate limits before looking up a reset account", async () => {
    actionRateLimitMock.enforcePasswordResetRequest.mockRejectedValue(
      new TooManyRequestsException("Too many password reset requests"),
    );

    await expect(
      service.requestReset({
        email: "user@example.com",
        ipAddress: "203.0.113.10",
        baseUrl: "http://localhost:3000",
      }),
    ).rejects.toThrow(TooManyRequestsException);

    expect(actionRateLimitMock.enforcePasswordResetRequest).toHaveBeenCalledWith(
      "user@example.com",
      "203.0.113.10",
    );
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
    expect(emailServiceMock.send).not.toHaveBeenCalled();
  });

  it("keeps a uniform response for unknown emails after consuming quota", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(
      service.requestReset({
        email: "missing@example.com",
        ipAddress: "203.0.113.10",
        baseUrl: "http://localhost:3000",
      }),
    ).resolves.toEqual({ ok: true });

    expect(actionRateLimitMock.enforcePasswordResetRequest).toHaveBeenCalledWith(
      "missing@example.com",
      "203.0.113.10",
    );
    expect(prismaMock.passwordResetToken.create).not.toHaveBeenCalled();
    expect(emailServiceMock.send).not.toHaveBeenCalled();
  });

  it("marks every active reset token as used after a successful reset", async () => {
    prismaMock.passwordResetToken.findUnique.mockResolvedValue({
      id: "reset-2",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        memberships: [],
      },
    });

    await service.resetPassword({
      token: "raw-token",
      password: "new-password-123",
      ipAddress: "127.0.0.1",
    });

    expect(prismaMock.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        usedAt: null,
      },
      data: {
        usedAt: expect.any(Date),
      },
    });
  });
});
