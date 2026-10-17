import { createHash } from "node:crypto";

import { withMysqlSessionLock } from "../situation-monitor/situation-monitor-user-lock";

// 与 apps/api-go/internal/newsindicator/store.go 的 orgLockName 相同。
// 锁名规则：ni:<orgId>；超过 MySQL 64 字符上限时用 ni: + sha256(orgId)
// 前 60 位十六进制。
export function newsIndicatorOrgLockName(orgId: string): string {
  const raw = `ni:${orgId}`;
  if ([...raw].length <= 64) {
    return raw;
  }
  const digest = createHash("sha256").update(orgId, "utf8").digest("hex");
  return `ni:${digest.slice(0, 60)}`;
}

// withNewsIndicatorOrgLock 在专用连接上持有按组织的 MySQL 会话锁，
// 整个 refreshOrg 完成后释放。不要在 Prisma 事务里调用 GET_LOCK。
export async function withNewsIndicatorOrgLock<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await withMysqlSessionLock(
    process.env.DATABASE_URL ?? "",
    newsIndicatorOrgLockName(orgId),
    fn,
  );
}
