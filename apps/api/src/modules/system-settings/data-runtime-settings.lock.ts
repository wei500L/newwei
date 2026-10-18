import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";

import {
  SituationMonitorLockError,
  withMysqlSessionLock,
} from "../situation-monitor/situation-monitor-user-lock";

/**
 * Global MySQL session locks for the "data runtime settings" singletons.
 *
 * Both records are process-wide singletons (`SystemSetting` rows with no
 * `orgId`/`userId` dimension), so the lock names carry no tenant suffix. They
 * are deliberately distinct from every other migration unit's lock names: this
 * batch migrates its own configuration domains and must never serialize against
 * the infrastructure, model-access or platform-governance batches.
 *
 * The names must stay below MySQL's 64 character GET_LOCK limit and must be
 * byte-identical to the constants used by the Go takeover
 * (`apps/api-go/internal/dataruntimesettings`), otherwise a Nest write and a Go
 * write could interleave and lose an update.
 */
export const DATA_RUNTIME_SETTINGS_REALTIME_LOCK =
  "data-runtime-settings:realtime:v1";
export const DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK =
  "data-runtime-settings:nominatim:v1";

/**
 * Error text `withMysqlSessionLock` throws when `GET_LOCK` returned 0 (timeout)
 * or the lock session could not be opened at all. The helper in
 * `situation-monitor-user-lock.ts` is a shared, read-only dependency for this
 * batch and does not export the literal, so it is repeated here verbatim.
 */
const LOCK_NOT_ACQUIRED_MESSAGE = "content subscription lock not acquired";

/**
 * Runs `fn` while holding one global MySQL session lock.
 *
 * A dedicated MySQL session runs `GET_LOCK(name, 10)` and releases it after the
 * callback resolves, so the lock is held across the whole read-modify-write
 * sequence (the row upsert, the audit write and the cache invalidation
 * included) and is never released before the database commit.
 *
 * Failure mapping is deliberately two-way so a business rejection is never
 * masked as an infrastructure error and vice versa:
 *   - "lock not acquired" (GET_LOCK returned 0, or no lock session at all)
 *     becomes a 409 carrying `busyMessage`, which is the retry contract the
 *     callers document;
 *   - any other FAILURE (refused connection, failed handshake, protocol
 *     error) becomes the generic `ServiceUnavailableException` 503 that
 *     `GlobalExceptionFilter` renders as
 *     `{statusCode: 503, message: "Internal server error", error: "Service Unavailable"}`;
 *   - an `HttpException` raised by `fn` (validation, platform-admin rejection)
 *     is re-thrown unchanged.
 *
 * The lock tool name, the MySQL connection details and the setting values never
 * reach the response.
 */
export async function withDataRuntimeSettingsLock<T>(
  lockName: string,
  busyMessage: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withMysqlSessionLock(
      process.env.DATABASE_URL ?? "",
      lockName,
      fn,
    );
  } catch (error) {
    if (error instanceof HttpException) {
      throw error;
    }
    if (
      error instanceof SituationMonitorLockError &&
      error.message === LOCK_NOT_ACQUIRED_MESSAGE
    ) {
      throw new ConflictException(busyMessage);
    }
    throw new ServiceUnavailableException();
  }
}
