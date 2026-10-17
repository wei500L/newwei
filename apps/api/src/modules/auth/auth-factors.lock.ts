import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";

import {
  SituationMonitorLockError,
  withMysqlSessionLock,
} from "../situation-monitor/situation-monitor-user-lock";

/**
 * Per-user MySQL session locks for the authenticated MFA management routes.
 *
 * A TOTP factor is a *global* `User` state, not a per-organization one: the
 * same `UserTotpFactor` row is shared by every membership the user has, so the
 * lock name must be derived from the user id alone. Adding an org suffix would
 * let the same user's requests in two organizations run concurrently and
 * interleave a begin/verify/disable/rotate sequence.
 */
export const MFA_USER_LOCK_PREFIX = "mfa:";

/**
 * Message of the 409 returned when the per-user lock is already held by another
 * request. The same text is used by the Go takeover
 * (`apps/api-go/internal/authfactors`), so a Nest request and a Go request
 * contending on the same lock produce one contract.
 */
export const MFA_LOCK_BUSY_MESSAGE =
  "MFA settings are being updated by another request; retry later";

/**
 * Message raised by {@link withMysqlSessionLock} when `GET_LOCK` returns 0 (the
 * lock is held elsewhere), the session times out, or the DSN cannot be parsed.
 * It is the only signal that distinguishes contention from a broken
 * connection, so it is compared verbatim. The shared lock helper is
 * deliberately left untouched by this batch.
 */
const MYSQL_LOCK_NOT_ACQUIRED_MESSAGE =
  "content subscription lock not acquired";

/**
 * Derives the deterministic lock name for one user.
 *
 * The name is `mfa:` followed by the first 60 hex characters of the SHA-256 of
 * the UTF-8 user id: exactly 64 ASCII characters, which is MySQL's `GET_LOCK`
 * name limit. Hashing keeps the name fixed-length for any user id shape
 * (cuid, `machine:<id>`, future formats) without ever embedding a raw identity.
 * The Go takeover computes the identical string.
 */
export function mfaUserLockName(userId: string): string {
  const digest = createHash("sha256").update(userId, "utf8").digest("hex");
  return `${MFA_USER_LOCK_PREFIX}${digest.slice(0, 60)}`;
}

/**
 * Reports whether an authenticated actor id belongs to a machine access token.
 *
 * `JwtAuthGuard` accepts `mtk_` tokens and `MachineTokenService.validate`
 * materializes them as `machine:<tokenId>`. Machine ids are not `User` rows, so
 * every MFA *write* route must reject them before touching `UserTotpFactor`
 * (whose `userId` is a foreign key into `User(id)`).
 */
export function isMachineActorId(actorId: string): boolean {
  return actorId.startsWith("machine:");
}

/**
 * Runs `fn` while holding the caller's per-user MFA session lock.
 *
 * This wraps the existing {@link withMysqlSessionLock} helper: one dedicated
 * MySQL session runs `GET_LOCK(name, 10)` and releases it after the callback
 * resolves, so the lock is held across the whole read-verify-transaction
 * sequence — including the `lastUsedAt` update, the factor change and the
 * recovery-code replacement.
 *
 * Failure mapping keeps the NestJS contract:
 *   - a business `HttpException` raised by `fn` (400/401) is re-thrown
 *     unchanged, so a wrong code is never masked as an infrastructure error;
 *   - `GET_LOCK` returning 0 is surfaced as a 409 with
 *     {@link MFA_LOCK_BUSY_MESSAGE};
 *   - every other failure (refused connection, failed handshake, missing DSN)
 *     is surfaced as a 503 rendered by `GlobalExceptionFilter` as
 *     `{statusCode: 503, message: "Internal server error", error: "Service Unavailable"}`.
 *
 * The lock tool name, the MySQL connection details and every secret stay out of
 * the response body.
 */
export async function withMfaUserLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!(process.env.DATABASE_URL ?? "").trim()) {
    throw new ServiceUnavailableException();
  }
  try {
    return await withMysqlSessionLock(
      process.env.DATABASE_URL ?? "",
      mfaUserLockName(userId),
      fn,
    );
  } catch (error) {
    if (error instanceof HttpException) {
      throw error;
    }
    if (
      error instanceof SituationMonitorLockError &&
      error.message === MYSQL_LOCK_NOT_ACQUIRED_MESSAGE
    ) {
      throw new ConflictException(MFA_LOCK_BUSY_MESSAGE);
    }
    throw new ServiceUnavailableException();
  }
}
