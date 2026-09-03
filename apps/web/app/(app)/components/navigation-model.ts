import {
  AimOutlined,
  ApartmentOutlined,
  AppstoreOutlined,
  BellOutlined,
  BookOutlined,
  ClusterOutlined,
  DashboardOutlined,
  EnvironmentOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  FundOutlined,
  GlobalOutlined,
  HistoryOutlined,
  RadarChartOutlined,
  ReadOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  TagsOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { ComponentType } from "react";

/**
 * App Shell 导航模型（单一真源，FE-批2 IA 重构）。
 *
 * 桌面 ActionRail、移动 Drawer 与桌面矮视口 Drawer 全部从本文件消费同一份
 * 导航定义；权限过滤只有 resolveNavigationGroups 一个事实源。模型只描述
 * 「有什么、在哪组、需要什么权限」，不做翻译（渲染方 t(item.labelKey)）、
 * 不持有 hooks——因此本文件可被任意客户端组件与测试直接引用。
 *
 * 图标语义唯一：20 个入口各占一个 antd 图标（FE-批2 图标审计的去重保持）。
 */

export type NavGroupId = "today" | "situation" | "research" | "workspace" | "admin";

export interface NavItemDefinition {
  /** 稳定路由 key（与 path 一致，供 resolveActiveItemKey 使用） */
  key: string;
  /** 导航目标路由 */
  path: string;
  /** 图标组件（渲染方以 <item.icon /> 挂载） */
  icon: ComponentType;
  /** i18n 键（如 nav.main.today） */
  labelKey: string;
  /** 任一权限命中即可见；缺省 = 所有登录用户可见 */
  requiresAnyPermissions?: readonly string[];
}

export interface NavGroupDefinition {
  id: NavGroupId;
  /** 分组标题 i18n 键（nav.groups.*） */
  labelKey: string;
  items: readonly NavItemDefinition[];
}

/** 态势总览与知识图谱沿用同一权限（与迁移前的 dashboard/knowledge-graph 门禁一致）。 */
const DASHBOARDS_READ: readonly string[] = ["dashboards.read"];

export const NAV_GROUP_DEFINITIONS: readonly NavGroupDefinition[] = [
  {
    id: "today",
    labelKey: "nav.groups.today",
    items: [
      {
        key: "/today",
        path: "/today",
        icon: ReadOutlined,
        labelKey: "nav.main.today",
      },
      {
        key: "/news-hub",
        path: "/news-hub",
        icon: AppstoreOutlined,
        labelKey: "nav.main.newsHub",
      },
      {
        key: "/newsnow",
        path: "/newsnow",
        icon: GlobalOutlined,
        labelKey: "nav.main.newsnow",
      },
      {
        key: "/rss",
        path: "/rss",
        icon: BookOutlined,
        labelKey: "nav.main.rss",
      },
      {
        key: "/search",
        path: "/search",
        icon: SearchOutlined,
        labelKey: "nav.main.search",
      },
    ],
  },
  {
    id: "situation",
    labelKey: "nav.groups.situation",
    items: [
      {
        key: "/dashboard",
        path: "/dashboard",
        icon: DashboardOutlined,
        labelKey: "nav.dashboard",
        requiresAnyPermissions: DASHBOARDS_READ,
      },
      {
        key: "/events",
        path: "/events",
        icon: ClusterOutlined,
        labelKey: "nav.main.events",
      },
      {
        key: "/events-archive",
        path: "/events-archive",
        icon: HistoryOutlined,
        labelKey: "nav.main.eventsArchive",
      },
      {
        key: "/topics",
        path: "/topics",
        icon: TagsOutlined,
        labelKey: "nav.main.topics",
      },
      {
        key: "/situation-monitor",
        path: "/situation-monitor",
        icon: RadarChartOutlined,
        labelKey: "nav.main.situationMonitor",
      },
      {
        key: "/map",
        path: "/map",
        icon: EnvironmentOutlined,
        labelKey: "nav.main.map",
      },
      {
        key: "/finance",
        path: "/finance",
        icon: FundOutlined,
        labelKey: "nav.main.finance",
      },
    ],
  },
  {
    id: "research",
    labelKey: "nav.groups.research",
    items: [
      {
        key: "/analysis",
        path: "/analysis",
        icon: FolderOpenOutlined,
        labelKey: "nav.main.analysis",
        requiresAnyPermissions: ["analysis.read", "analysis.write"],
      },
      {
        key: "/assistant",
        path: "/assistant",
        icon: RobotOutlined,
        labelKey: "nav.main.assistant",
        requiresAnyPermissions: ["assistant.read", "assistant.run"],
      },
      {
        key: "/knowledge-graph",
        path: "/knowledge-graph",
        icon: ApartmentOutlined,
        labelKey: "nav.main.knowledgeGraph",
        requiresAnyPermissions: DASHBOARDS_READ,
      },
    ],
  },
  {
    id: "workspace",
    labelKey: "nav.groups.workspace",
    items: [
      {
        key: "/alerts",
        path: "/alerts",
        icon: ExclamationCircleOutlined,
        labelKey: "nav.main.alerts",
      },
      {
        key: "/subscriptions",
        path: "/subscriptions",
        icon: BellOutlined,
        labelKey: "nav.main.subscriptions",
      },
      {
        key: "/profile",
        path: "/profile",
        icon: UserOutlined,
        labelKey: "nav.main.profile",
      },
    ],
  },
  {
    id: "admin",
    labelKey: "nav.groups.admin",
    items: [
      {
        key: "/admin",
        path: "/admin",
        icon: SettingOutlined,
        labelKey: "nav.admin",
        requiresAnyPermissions: [
          "settings.manage",
          "org.write",
          "users.write",
          "crawl.read",
          "crawl.write",
          "dashboards.write",
          "alerts.manage",
        ],
      },
      {
        key: "/admin/ops/crawl-tasks",
        path: "/admin/ops/crawl-tasks",
        icon: AimOutlined,
        labelKey: "nav.crawlTasks",
        requiresAnyPermissions: ["crawl.read", "crawl.write"],
      },
    ],
  },
];

/** 单个导航项的权限判断（任一命中即可见；无要求 = 所有登录用户）。 */
export function hasNavPermission(
  permissions: readonly string[],
  required?: readonly string[],
): boolean {
  if (!required || required.length === 0) {
    return true;
  }
  return required.some((permission) => permissions.includes(permission));
}

/**
 * 按权限解析可见导航组：过滤无权限项，并丢弃因此为空的组（不显示空标题）。
 * 这是 ActionRail 与移动 Drawer 共用的唯一权限过滤事实源。
 */
export function resolveNavigationGroups(
  permissions: readonly string[],
): NavGroupDefinition[] {
  return NAV_GROUP_DEFINITIONS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      hasNavPermission(permissions, item.requiresAnyPermissions),
    ),
  })).filter((group) => group.items.length > 0);
}
