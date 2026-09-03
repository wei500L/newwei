import { describe, expect, it } from "vitest";

import en from "@/lib/locales/en.json";
import zh from "@/lib/locales/zh.json";

import {
  NAV_GROUP_DEFINITIONS,
  hasNavPermission,
  resolveNavigationGroups,
} from "./navigation-model";

/** 迁移前 buildActionRailNavConfig 的全部 20 个入口路径（17 主项 + 3 管理项）。 */
const LEGACY_ROUTE_INVENTORY = [
  "/today",
  "/news-hub",
  "/newsnow",
  "/rss",
  "/search",
  "/dashboard",
  "/events",
  "/events-archive",
  "/topics",
  "/situation-monitor",
  "/map",
  "/finance",
  "/analysis",
  "/assistant",
  "/knowledge-graph",
  "/alerts",
  "/subscriptions",
  "/profile",
  "/admin",
  "/admin/ops/crawl-tasks",
] as const;

/** 迁移前逐项的权限门禁（语义不变，仅收敛为声明式数据）。 */
const LEGACY_PERMISSION_GATES: Record<string, readonly string[]> = {
  "/dashboard": ["dashboards.read"],
  "/knowledge-graph": ["dashboards.read"],
  "/analysis": ["analysis.read", "analysis.write"],
  "/assistant": ["assistant.read", "assistant.run"],
  "/admin/ops/crawl-tasks": ["crawl.read", "crawl.write"],
  "/admin": [
    "settings.manage",
    "org.write",
    "users.write",
    "crawl.read",
    "crawl.write",
    "dashboards.write",
    "alerts.manage",
  ],
};

const allItems = NAV_GROUP_DEFINITIONS.flatMap((group) => group.items);

/** 按点号路径从 locale 资源里取嵌套键。 */
function resolveLocaleKey(
  resource: Record<string, unknown>,
  key: string,
): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, resource);
}

describe("navigation-model（五组信息架构）", () => {
  it("按规范顺序定义五个语义组", () => {
    expect(NAV_GROUP_DEFINITIONS.map((group) => group.id)).toEqual([
      "today",
      "situation",
      "research",
      "workspace",
      "admin",
    ]);
  });

  it("组内路由与规范分组一致", () => {
    const pathsByGroup = Object.fromEntries(
      NAV_GROUP_DEFINITIONS.map((group) => [
        group.id,
        group.items.map((item) => item.path),
      ]),
    );
    expect(pathsByGroup.today).toEqual([
      "/today",
      "/news-hub",
      "/newsnow",
      "/rss",
      "/search",
    ]);
    expect(pathsByGroup.situation).toEqual([
      "/dashboard",
      "/events",
      "/events-archive",
      "/topics",
      "/situation-monitor",
      "/map",
      "/finance",
    ]);
    expect(pathsByGroup.research).toEqual([
      "/analysis",
      "/assistant",
      "/knowledge-graph",
    ]);
    expect(pathsByGroup.workspace).toEqual([
      "/alerts",
      "/subscriptions",
      "/profile",
    ]);
    expect(pathsByGroup.admin).toEqual(["/admin", "/admin/ops/crawl-tasks"]);
  });

  it("保留迁移前的全部导航路由（无丢失、无新增）", () => {
    const paths = allItems.map((item) => item.path);
    expect([...paths].sort()).toEqual([...LEGACY_ROUTE_INVENTORY].sort());
  });

  it("迁移前的权限门禁语义逐项不变", () => {
    for (const item of allItems) {
      expect(item.requiresAnyPermissions ?? null).toEqual(
        LEGACY_PERMISSION_GATES[item.path] ?? null,
      );
    }
  });

  it("管理入口只出现在管理组（不混入普通用户高频导航）", () => {
    const nonAdminGroups = NAV_GROUP_DEFINITIONS.filter(
      (group) => group.id !== "admin",
    );
    for (const group of nonAdminGroups) {
      for (const item of group.items) {
        expect(item.path.startsWith("/admin")).toBe(false);
      }
    }
  });

  it("全部入口图标语义唯一（无重复图标）", () => {
    const icons = allItems.map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("resolveNavigationGroups（权限过滤单一事实源）", () => {
  it("持有全部权限时返回完整五组", () => {
    const groups = resolveNavigationGroups([
      "dashboards.read",
      "analysis.read",
      "assistant.read",
      "crawl.read",
      "settings.manage",
    ]);
    expect(groups.map((group) => group.id)).toEqual([
      "today",
      "situation",
      "research",
      "workspace",
      "admin",
    ]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(
      LEGACY_ROUTE_INVENTORY.length,
    );
  });

  it("无任何权限时过滤受限项并丢弃空组（不显示空标题）", () => {
    const groups = resolveNavigationGroups([]);
    const ids = groups.map((group) => group.id);
    expect(ids).toContain("today");
    expect(ids).toContain("workspace");
    // situation 只剩无门禁项；research 与 admin 全部门禁 → 整组消失
    expect(ids).not.toContain("research");
    expect(ids).not.toContain("admin");
    const situation = groups.find((group) => group.id === "situation");
    expect(situation?.items.map((item) => item.path)).not.toContain(
      "/dashboard",
    );
  });

  it("仅部分权限命中时按任一命中保留入口", () => {
    const groups = resolveNavigationGroups(["crawl.write"]);
    const paths = groups.flatMap((group) => group.items.map((item) => item.path));
    expect(paths).toContain("/admin");
    expect(paths).toContain("/admin/ops/crawl-tasks");
    expect(paths).not.toContain("/analysis");
  });

  it("hasNavPermission：无要求对所有人可见，多权限任一命中即可", () => {
    expect(hasNavPermission([], undefined)).toBe(true);
    expect(hasNavPermission([], [])).toBe(true);
    expect(hasNavPermission(["crawl.read"], ["crawl.read", "crawl.write"])).toBe(
      true,
    );
    expect(hasNavPermission(["alerts.read"], ["crawl.read"])).toBe(false);
  });
});

describe("导航 i18n 完整性（中英双语）", () => {
  it.each([
    ["zh-CN", zh],
    ["en-US", en],
  ] as const)("分组标题与入口文案在 %s 中均有翻译", (_locale, resource) => {
    for (const group of NAV_GROUP_DEFINITIONS) {
      const groupLabel = resolveLocaleKey(resource, group.labelKey);
      expect(groupLabel, `missing ${group.labelKey}`).toBeTruthy();
      for (const item of group.items) {
        const label = resolveLocaleKey(resource, item.labelKey);
        expect(label, `missing ${item.labelKey}`).toBeTruthy();
      }
    }
  });
});
