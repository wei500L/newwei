"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo } from "react";

import { resolveActiveItemKey } from "./action-rail-routing";
import { resolveNavigationGroups, type NavGroupDefinition } from "./navigation-model";

export interface Navigation {
  /** 权限过滤后的可见导航组（空组已被丢弃） */
  groups: NavGroupDefinition[];
  /** 活跃路由 key（最长路径前缀命中，语义不变） */
  activeKey: string | null;
}

/**
 * App Shell 导航的统一消费入口：ActionRail 与移动 Drawer 都从这里拿
 * 同一份组配置与活跃项，保证两端信息架构一致（FE-批2）。
 */
export function useNavigation(): Navigation {
  const pathname = usePathname();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];

  return useMemo(() => {
    const groups = resolveNavigationGroups(permissions);
    const activeKey = resolveActiveItemKey(
      pathname,
      groups.flatMap((group) => group.items),
    );
    return { groups, activeKey };
  }, [pathname, permissions]);
}
