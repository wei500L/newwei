import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SituationMonitorLockError } from "../situation-monitor/situation-monitor-user-lock";

import {
  MFA_LOCK_BUSY_MESSAGE,
  MFA_USER_LOCK_PREFIX,
  isMachineActorId,
  mfaUserLockName,
  withMfaUserLock,
} from "./auth-factors.lock";

const withMysqlSessionLockMock = vi.hoisted(() => vi.fn());

vi.mock("../situation-monitor/situation-monitor-user-lock", async () => {
  const actual = await vi.importActual<
    typeof import("../situation-monitor/situation-monitor-user-lock")
  >("../situation-monitor/situation-monitor-user-lock");
  return {
    ...actual,
    withMysqlSessionLock: withMysqlSessionLockMock,
  };
});

function expectedLockName(userId: string): string {
  const digest = createHash("sha256").update(userId, "utf8").digest("hex");
  return `mfa:${digest.slice(0, 60)}`;
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("mfaUserLockName", () => {
  it("derives a fixed 64 character ASCII lock name from the user id", () => {
    const name = mfaUserLockName("clx0a1b2c3d4e5f6g7h8i9j0");
    expect(name).toBe(expectedLockName("clx0a1b2c3d4e5f6g7h8i9j0"));
    expect(name).toHaveLength(64);
    expect(/^[\x20-\x7e]+$/.test(name)).toBe(true);
    expect(name.startsWith(MFA_USER_LOCK_PREFIX)).toBe(true);
    expect(name).not.toContain("clx0a1b2c3d4e5f6g7h8i9j0");
  });

  it("is deterministic and never collides across users", () => {
    expect(mfaUserLockName("user-a")).toBe(mfaUserLockName("user-a"));
    expect(mfaUserLockName("user-a")).not.toBe(mfaUserLockName("user-b"));
    expect(mfaUserLockName("machine:token-1")).toHaveLength(64);
  });
});

describe("isMachineActorId", () => {
  it("detects the machine identity shape produced by MachineTokenService", () => {
    expect(isMachineActorId("machine:clx-token")).toBe(true);
    expect(isMachineActorId("clx-human-user")).toBe(false);
    expect(isMachineActorId("")).toBe(false);
  });
});

describe("withMfaUserLock", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "mysql://root:secret@127.0.0.1:3306/app";
  });

  it("returns the callback result when the lock is acquired", async () => {
    withMysqlSessionLockMock.mockImplementationOnce(
      async (_url: string, _name: string, fn: () => Promise<string>) => fn(),
    );
    await expect(withMfaUserLock("user-1", async () => "ok")).resolves.toBe("ok");
    expect(withMysqlSessionLockMock).toHaveBeenCalledWith(
      process.env.DATABASE_URL,
      mfaUserLockName("user-1"),
      expect.any(Function),
    );
  });

  it("maps GET_LOCK contention to a 409 with the shared message", async () => {
    withMysqlSessionLockMock.mockRejectedValueOnce(
      new SituationMonitorLockError("content subscription lock not acquired"),
    );
    const error = await capture(withMfaUserLock("user-1", async () => "never"));
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).message).toBe(MFA_LOCK_BUSY_MESSAGE);
  });

  it("maps connection and handshake failures to a 503", async () => {
    withMysqlSessionLockMock.mockRejectedValueOnce(
      new SituationMonitorLockError("Access denied for user 'root'@'localhost'"),
    );
    await expect(
      withMfaUserLock("user-1", async () => "never"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("re-throws business HttpExceptions unchanged", async () => {
    const business = new HttpException("Invalid MFA verification code", 401);
    withMysqlSessionLockMock.mockRejectedValueOnce(business);
    await expect(withMfaUserLock("user-1", async () => "never")).rejects.toBe(
      business,
    );
  });

  it("re-throws a non-HttpException raised by the callback unchanged", async () => {
    // A secret-decryption failure (wrong key) is not an HttpException: it must
    // keep rendering as the production 500 instead of being masked as a 503
    // lock failure.
    withMysqlSessionLockMock.mockImplementationOnce(
      async (_url: string, _name: string, fn: () => Promise<string>) => fn(),
    );
    const decryptionError = new Error(
      "Failed to decrypt system setting secret",
    );
    await expect(
      withMfaUserLock("user-1", async () => {
        throw decryptionError;
      }),
    ).rejects.toBe(decryptionError);
  });

  it("fails closed when DATABASE_URL is absent", async () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(
        withMfaUserLock("user-1", async () => "never"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(withMysqlSessionLockMock).not.toHaveBeenCalled();
    } finally {
      process.env.DATABASE_URL = previous;
    }
  });
});
