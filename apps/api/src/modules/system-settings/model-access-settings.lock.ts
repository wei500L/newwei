import { ServiceUnavailableException } from "@nestjs/common";

import { withMysqlSessionLock } from "../situation-monitor/situation-monitor-user-lock";

/**
 * Global MySQL session lock names for the model-access settings domain.
 *
 * `SystemSetting.key` is a global primary key with no org dimension, so both
 * families are single global singletons. The lock name therefore carries no
 * orgId/userId suffix — two callers protecting the same row must always contend
 * on the same session-wide advisory lock, including across NestJS and Go
 * processes (apps/api-go/internal/modelaccesssettings/lock.go uses the exact
 * same literals).
 */
export const MODEL_SERVICE_SETTINGS_LOCK_NAME = "model-access:model-service:v1";
export const OPENAI_KEYS_SETTINGS_LOCK_NAME = "model-access:openai-keys:v1";
/**
 * `SystemSetting.key=litellm_proxy_load_balancing` is the third global singleton
 * of this domain. PUT and DELETE share this lock name, and the Go takeover
 * (apps/api-go/internal/modelaccesssettings/lock.go) uses the same literal.
 */
export const PROXY_LOAD_BALANCING_SETTINGS_LOCK_NAME =
  "model-access:proxy-load-balancing:v1";

/**
 * Runs `fn` while holding one global MySQL advisory lock.
 *
 * The authority is `withMysqlSessionLock` (read-only reuse, never modified):
 * a dedicated connection executes `SELECT GET_LOCK(name, 10)` and releases it in
 * a `finally` block after the callback settles, so the lock is never released
 * before COMMIT of the nested statement and never leaks into the Prisma pool.
 *
 * Failure mapping: only the acquisition itself can produce this wrapper's 503.
 * Once the callback has started, every error it throws (a DTO-adjacent business
 * 400, an audit failure, an encryption failure) propagates unchanged — otherwise
 * a legitimate 400 would be reported as a lock outage. A non-acquired lock must
 * never fall through to a write.
 */
export async function withModelAccessSettingsLock<T>(
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  let callbackStarted = false;
  try {
    return await withMysqlSessionLock(
      process.env.DATABASE_URL ?? "",
      lockName,
      async () => {
        callbackStarted = true;
        return await fn();
      },
    );
  } catch (error) {
    if (callbackStarted) {
      throw error;
    }
    // GlobalExceptionFilter renders a >=500 HttpException as
    // {message:"Internal server error", error:"Service Unavailable"} — the same
    // shape the Go lock adapter writes. The internal lock name and the MySQL
    // error text (which may contain the CLI message) never reach the client.
    throw new ServiceUnavailableException("Settings lock not acquired");
  }
}
