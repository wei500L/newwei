import { HttpException, ServiceUnavailableException } from "@nestjs/common";

import { withMysqlSessionLock } from "../situation-monitor/situation-monitor-user-lock";

/**
 * Global MySQL session locks for the infrastructure settings singletons.
 *
 * Both records are process-wide singletons (`SystemSetting` rows with no `orgId`
 * or `userId` dimension), so the lock names carry no tenant suffix. They are
 * intentionally distinct from the model-access batch's lock names: the two
 * batches migrate different configuration domains and must never serialize
 * against each other.
 *
 * The names must stay below MySQL's 64 character GET_LOCK limit and must be
 * byte-identical to the constants used by the Go takeover
 * (`apps/api-go/internal/infrastructuresettings`), otherwise a Nest write and a
 * Go write could interleave and lose an update.
 */
export const INFRASTRUCTURE_SETTINGS_VECTOR_LOCK = "infra-settings:vector-service:v1";
export const INFRASTRUCTURE_SETTINGS_NEWS_SOURCE_SECRETS_LOCK =
  "infra-settings:news-source-runtime-secrets:v1";

/**
 * Runs `fn` while holding one global MySQL session lock.
 *
 * This only wraps the existing {@link withMysqlSessionLock} helper: a dedicated
 * MySQL session runs `GET_LOCK(name, 10)` and releases it after the callback
 * resolves, so the lock is held across the whole read-modify-write sequence
 * (Prisma transaction, audit write and cache invalidation included) and is
 * never released before the database commit.
 *
 * A lock failure (timeout, refused connection, failed handshake) is surfaced as
 * a 503: `GlobalExceptionFilter` renders it as
 * `{statusCode: 503, message: "Internal server error", error: "Service Unavailable"}`.
 * Business failures raised by `fn` are `HttpException`s and are re-thrown
 * unchanged, so a validation or platform-admin rejection is never masked as an
 * infrastructure error. The underlying lock tool name, the MySQL connection
 * details and the setting values never reach the response.
 */
export async function withInfrastructureSettingsLock<T>(
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withMysqlSessionLock(process.env.DATABASE_URL ?? "", lockName, fn);
  } catch (error) {
    if (error instanceof HttpException) {
      throw error;
    }
    throw new ServiceUnavailableException();
  }
}
