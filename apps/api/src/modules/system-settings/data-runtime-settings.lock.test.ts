import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../situation-monitor/situation-monitor-user-lock", () => {
  class SituationMonitorLockError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SituationMonitorLockError";
    }
  }
  return {
    SituationMonitorLockError,
    withMysqlSessionLock: vi.fn(),
  };
});

import {
  SituationMonitorLockError,
  withMysqlSessionLock,
} from "../situation-monitor/situation-monitor-user-lock";

import {
  DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK,
  DATA_RUNTIME_SETTINGS_REALTIME_LOCK,
  withDataRuntimeSettingsLock,
} from "./data-runtime-settings.lock";

const sessionLock = vi.mocked(withMysqlSessionLock);

const REALTIME_BUSY =
  "Realtime signals settings are being updated by another request; retry later";
const NOMINATIM_BUSY =
  "Nominatim identity settings are being updated by another request; retry later";

describe("data runtime settings locks", () => {
  beforeEach(() => {
    sessionLock.mockReset();
  });

  it("pins the two global lock names the Go takeover shares", () => {
    expect(DATA_RUNTIME_SETTINGS_REALTIME_LOCK).toBe(
      "data-runtime-settings:realtime:v1",
    );
    expect(DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK).toBe(
      "data-runtime-settings:nominatim:v1",
    );
    // MySQL GET_LOCK rejects names longer than 64 characters.
    expect(DATA_RUNTIME_SETTINGS_REALTIME_LOCK.length).toBeLessThanOrEqual(64);
    expect(DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK.length).toBeLessThanOrEqual(64);
    // Global singletons: no tenant or user suffix.
    expect(DATA_RUNTIME_SETTINGS_REALTIME_LOCK).not.toContain("org");
    expect(DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK).not.toContain("org");
  });

  it("runs the callback under the requested lock and returns its result", async () => {
    sessionLock.mockImplementation(async (_url, _name, fn) => await fn());

    const result = await withDataRuntimeSettingsLock(
      DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK,
      NOMINATIM_BUSY,
      async () => "settings",
    );

    expect(result).toBe("settings");
    expect(sessionLock).toHaveBeenCalledTimes(1);
    expect(sessionLock.mock.calls[0]?.[1]).toBe(
      DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK,
    );
  });

  it("maps an unacquired session lock to the 409 retry contract", async () => {
    sessionLock.mockRejectedValue(
      new SituationMonitorLockError("content subscription lock not acquired"),
    );

    const caught = await withDataRuntimeSettingsLock(
      DATA_RUNTIME_SETTINGS_REALTIME_LOCK,
      REALTIME_BUSY,
      async () => null,
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).message).toBe(REALTIME_BUSY);
  });

  it("maps any other lock infrastructure failure to the generic 503", async () => {
    for (const failure of [
      new SituationMonitorLockError("unexpected mysql auth packet for x"),
      new Error("connect ECONNREFUSED 127.0.0.1:3306"),
    ]) {
      sessionLock.mockRejectedValue(failure);
      await expect(
        withDataRuntimeSettingsLock(
          DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK,
          NOMINATIM_BUSY,
          async () => null,
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it("never masks a business HttpException raised inside the lock", async () => {
    sessionLock.mockImplementation(async (_url, _name, fn) => await fn());

    await expect(
      withDataRuntimeSettingsLock(
        DATA_RUNTIME_SETTINGS_REALTIME_LOCK,
        REALTIME_BUSY,
        async () => {
          throw new ForbiddenException("Platform admin access required");
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
