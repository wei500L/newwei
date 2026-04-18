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

  let service: PasswordResetService;

  beforeEach(() => {
    jest.resetAllMocks();
    prismaMock.$transaction = jest.fn(
      async (callback: (tx: typeof prismaMock) => Promise<unknown>) =>
        callback(prismaMock),
    );
    service = new PasswordResetService(prismaMock, emailServiceMock);
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
