/**
 * 队列运维页面的访问判定（后端鉴权规则在前端的镜像）：
 * 需要 queue.manage 权限 **且** platform_admin 全局角色。
 *
 * 单独的 helper 便于 ops 入口（ops-content.tsx）与页面本体共用同一判定，
 * 并用纯函数单测覆盖四种组合。
 */
export const QUEUE_OPS_REQUIRED_PERMISSION = "queue.manage";
export const QUEUE_OPS_REQUIRED_GLOBAL_ROLE = "platform_admin";

export interface QueueOpsAccessInput {
  permissions?: readonly string[] | null;
  globalRoles?: readonly string[] | null;
}

export function canViewQueueOps(input: QueueOpsAccessInput): boolean {
  const permissions = input.permissions ?? [];
  const globalRoles = input.globalRoles ?? [];
  return (
    permissions.includes(QUEUE_OPS_REQUIRED_PERMISSION) &&
    globalRoles.includes(QUEUE_OPS_REQUIRED_GLOBAL_ROLE)
  );
}
