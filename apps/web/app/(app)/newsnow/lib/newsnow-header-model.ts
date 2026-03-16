import type { NewsnowSortMode } from '../store/newsnow-store';

const RESERVED_COLUMN_KEYS = new Set(['focus', 'hottest', 'realtime']);

const STATIC_TABS = [
  { key: 'focus', name: '关注' },
  { key: 'hottest', name: '最热' },
  { key: 'realtime', name: '实时' },
] as const;

export const NEWSNOW_UTILITY_LINKS = [
  { href: '/news-hub', label: 'Hub' },
  { href: '/items', label: '深读' },
  { href: '/events', label: '事件' },
] as const;

interface NewsnowHeaderMetadataColumn {
  name: string;
}

interface NewsnowHeaderMetadata {
  columns: Record<string, NewsnowHeaderMetadataColumn>;
}

export interface NewsnowHeaderTab {
  key: string;
  name: string;
  href: string;
  isActive: boolean;
  isStatic: boolean;
}

export type NewsnowRealtimeSummaryTone = 'active' | 'idle' | 'offline';

export interface NewsnowRealtimeSummary {
  label: string;
  detail: string;
  tooltip: string;
  tone: NewsnowRealtimeSummaryTone;
  unreadCount: number;
}

export interface NewsnowPersonalizationState {
  isPersonalized: boolean;
  showSummary: boolean;
  summaryText: string;
  showManageButton: boolean;
  showPanel: boolean;
  showResetColumnOrders: boolean;
}

export interface NewsnowHeaderVisibility {
  showUtilityLinks: boolean;
  showDesktopSearch: boolean;
  showInlineSearch: boolean;
  stackSummaryRow: boolean;
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

export function isPersonalizedSortMode(sortMode: NewsnowSortMode): boolean {
  return sortMode === 'personalized' || sortMode === 'smart';
}

export function buildNewsnowHeaderTabs(
  pathname: string | null | undefined,
  metadata?: NewsnowHeaderMetadata | null
): NewsnowHeaderTab[] {
  const dynamicTabs = metadata
    ? Object.entries(metadata.columns)
        .filter(([key]) => !RESERVED_COLUMN_KEYS.has(key))
        .map(([key, column]) => ({
          key,
          name: column.name,
          isStatic: false,
        }))
    : [];

  return [...STATIC_TABS.map((tab) => ({ ...tab, isStatic: true })), ...dynamicTabs].map(
    (tab) => {
      const href = `/newsnow/${tab.key}`;
      return {
        ...tab,
        href,
        isActive: pathname === href,
      };
    }
  );
}

export function buildNewsnowRealtimeSummary(input: {
  realtimeConnected: boolean;
  realtimeUnreadTotal: number;
}): NewsnowRealtimeSummary {
  const unreadCount = normalizeCount(input.realtimeUnreadTotal);

  if (!input.realtimeConnected) {
    return {
      label: '实时连接已断开',
      detail: unreadCount > 0 ? `未处理 ${unreadCount}` : '等待重连',
      tooltip: '实时连接断开',
      tone: 'offline',
      unreadCount,
    };
  }

  if (unreadCount > 0) {
    return {
      label: '实时推送已到达',
      detail: `待处理 ${unreadCount}`,
      tooltip: '实时连接正常',
      tone: 'active',
      unreadCount,
    };
  }

  return {
    label: '实时连接正常',
    detail: '更新中',
    tooltip: '实时连接正常',
    tone: 'idle',
    unreadCount: 0,
  };
}

export function buildNewsnowPersonalizationState(input: {
  sortMode: NewsnowSortMode;
  affinitySamples: number;
  manualOrderColumnCount: number;
  panelOpen: boolean;
}): NewsnowPersonalizationState {
  const isPersonalized = isPersonalizedSortMode(input.sortMode);
  const affinitySamples = normalizeCount(input.affinitySamples);
  const manualOrderColumnCount = normalizeCount(input.manualOrderColumnCount);

  if (!isPersonalized) {
    return {
      isPersonalized: false,
      showSummary: false,
      summaryText: '',
      showManageButton: false,
      showPanel: false,
      showResetColumnOrders: false,
    };
  }

  const summaryParts = [`样本 ${affinitySamples}`];
  if (manualOrderColumnCount > 0) {
    summaryParts.push(`手动顺序 ${manualOrderColumnCount} 列`);
  }

  return {
    isPersonalized: true,
    showSummary: true,
    summaryText: summaryParts.join(' · '),
    showManageButton: true,
    showPanel: input.panelOpen,
    showResetColumnOrders: manualOrderColumnCount > 0,
  };
}

export function resolveNewsnowHeaderVisibility(input: {
  isMobile: boolean;
}): NewsnowHeaderVisibility {
  return {
    showUtilityLinks: !input.isMobile,
    showDesktopSearch: !input.isMobile,
    showInlineSearch: input.isMobile,
    stackSummaryRow: input.isMobile,
  };
}
