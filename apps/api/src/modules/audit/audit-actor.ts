/**
 * Normalizes the actor id that is written to the nullable `User` foreign keys
 * (`SystemSetting.updatedById`, `RateLimitPolicy.updatedById` and
 * `AuditLog.actorId`).
 *
 * Machine access tokens authenticate as `machine:<tokenId>`. That string is not
 * a `User` row, so persisting it into any of those columns triggers MySQL
 * foreign key error 1452 and turns an otherwise valid settings write into an
 * HTTP 500. Machine actors (and empty ids) must therefore be stored as NULL,
 * while human users keep their real user id.
 */
export const normalizeAuditActorId = (actorId: string | null | undefined): string | null => {
  if (!actorId) {
    return null;
  }
  return actorId.startsWith("machine:") ? null : actorId;
};
