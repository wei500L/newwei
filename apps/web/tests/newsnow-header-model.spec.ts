import { describe, expect, it } from 'vitest';

import {
  buildNewsnowHeaderTabs,
  buildNewsnowPersonalizationState,
  buildNewsnowRealtimeSummary,
  isPersonalizedSortMode,
  resolveNewsnowHeaderVisibility,
} from '../app/(app)/newsnow/lib/newsnow-header-model';

describe('newsnow header model', () => {
  it('keeps static tabs first and marks the active tab', () => {
    const tabs = buildNewsnowHeaderTabs('/newsnow/hottest', {
      columns: {
        focus: { name: '关注' },
        hottest: { name: '最热' },
        realtime: { name: '实时' },
        domestic: { name: '国内' },
        world: { name: '国际' },
      },
    });

    expect(tabs.map((tab) => tab.key)).toEqual([
      'focus',
      'hottest',
      'realtime',
      'recommended',
      'domestic',
      'world',
    ]);
    expect(tabs.find((tab) => tab.key === 'hottest')?.isActive).toBe(true);
    expect(tabs.find((tab) => tab.key === 'domestic')?.href).toBe(
      '/newsnow/domestic',
    );
  });

  it('builds an active realtime summary when unread updates exist', () => {
    expect(
      buildNewsnowRealtimeSummary({
        realtimeConnected: true,
        realtimeUnreadTotal: 3,
      }),
    ).toEqual({
      label: '实时推送已到达',
      detail: '待处理 3',
      tooltip: '实时连接正常',
      tone: 'active',
      unreadCount: 3,
    });
  });

  it('builds an offline realtime summary when disconnected', () => {
    expect(
      buildNewsnowRealtimeSummary({
        realtimeConnected: false,
        realtimeUnreadTotal: 0,
      }),
    ).toEqual({
      label: '实时连接已断开',
      detail: '等待重连',
      tooltip: '实时连接断开',
      tone: 'offline',
      unreadCount: 0,
    });
  });

  it('summarizes personalized mode and only shows manual-order reset when needed', () => {
    expect(
      buildNewsnowPersonalizationState({
        sortMode: 'personalized',
        affinitySamples: 6,
        manualOrderColumnCount: 2,
        panelOpen: true,
      }),
    ).toEqual({
      isPersonalized: true,
      showSummary: true,
      summaryText: '样本 6 · 手动顺序 2 列',
      showManageButton: true,
      showPanel: true,
      showResetColumnOrders: true,
    });

    expect(
      buildNewsnowPersonalizationState({
        sortMode: 'personalized',
        affinitySamples: 0,
        manualOrderColumnCount: 0,
        panelOpen: false,
      }),
    ).toEqual({
      isPersonalized: true,
      showSummary: true,
      summaryText: '样本 0',
      showManageButton: true,
      showPanel: false,
      showResetColumnOrders: false,
    });
  });

  it('hides personalized controls for manual mode and treats smart as personalized', () => {
    expect(isPersonalizedSortMode('manual')).toBe(false);
    expect(isPersonalizedSortMode('smart')).toBe(true);

    expect(
      buildNewsnowPersonalizationState({
        sortMode: 'manual',
        affinitySamples: 4,
        manualOrderColumnCount: 1,
        panelOpen: true,
      }),
    ).toEqual({
      isPersonalized: false,
      showSummary: false,
      summaryText: '',
      showManageButton: false,
      showPanel: false,
      showResetColumnOrders: false,
    });
  });

  it('hides utility links on mobile and moves search inline', () => {
    expect(resolveNewsnowHeaderVisibility({ isMobile: true })).toEqual({
      showUtilityLinks: false,
      showDesktopSearch: false,
      showInlineSearch: true,
      stackSummaryRow: true,
    });

    expect(resolveNewsnowHeaderVisibility({ isMobile: false })).toEqual({
      showUtilityLinks: true,
      showDesktopSearch: true,
      showInlineSearch: false,
      stackSummaryRow: false,
    });
  });
});
