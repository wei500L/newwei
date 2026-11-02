"use client";

import { SearchOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Segmented, Switch, Tooltip, message } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { emitNewsnowPersonalizationUpdated } from "@/lib/newsnow-personalization-events";

import { useIsMobile } from "../hooks/use-is-mobile";
import { useNewsMetadata } from "../hooks/use-news-sources";
import {
  NEWSNOW_UTILITY_LINKS,
  buildNewsnowHeaderTabs,
  buildNewsnowPersonalizationState,
  buildNewsnowRealtimeSummary,
  resolveNewsnowHeaderVisibility,
} from "../lib/newsnow-header-model";
import { useNewsnowStore } from "../store/newsnow-store";

import { NewsnowBoardContainer } from "./newsnow-board-container";
import { NewsnowSearch } from "./newsnow-search";

const controlShellClassName =
  "rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5";

const controlLabelClassName = "kicker px-1";

const realtimeToneClassNames = {
  active: {
    shell: "border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)]",
    dot: "bg-[var(--bullish)]",
    badge: "border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]",
  },
  idle: {
    shell: "border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]",
    dot: "bg-[var(--muted-foreground)]",
    badge: "border border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]",
  },
  offline: {
    shell: "border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)]",
    dot: "bg-[var(--accent)]",
    badge: "border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)]",
  },
} as const;

export function NewsnowHeader() {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { data: metadata } = useNewsMetadata();
  const { data: session } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const [messageApi, contextHolder] = message.useMessage();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isPersonalizationPanelOpen, setIsPersonalizationPanelOpen] = useState(false);
  const [clearingBehavior, setClearingBehavior] = useState(false);
  const {
    hideCrossSourceDuplicates,
    setHideCrossSourceDuplicates,
    sortMode,
    setSortMode,
    densityMode,
    setDensityMode,
    columnOrders,
    resetColumnOrders,
    sourceAffinity,
    resetSourceAffinity,
    liveUnreadBySource,
    realtimeConnected,
  } = useNewsnowStore();

  const affinitySamples = Object.keys(sourceAffinity).length;
  const realtimeUnreadTotal = Object.values(liveUnreadBySource).reduce(
    (sum, count) => sum + count,
    0,
  );
  const manualOrderColumnCount = useMemo(
    () =>
      Object.values(columnOrders).reduce(
        (count, order) => count + (Array.isArray(order) && order.length > 0 ? 1 : 0),
        0,
      ),
    [columnOrders],
  );
  const tabs = useMemo(
    () => buildNewsnowHeaderTabs(pathname, metadata),
    [metadata, pathname],
  );
  const isRecommendedTab = pathname === "/newsnow/recommended";
  const realtimeSummary = useMemo(
    () =>
      buildNewsnowRealtimeSummary({
        realtimeConnected,
        realtimeUnreadTotal,
      }),
    [realtimeConnected, realtimeUnreadTotal],
  );
  const personalizationState = useMemo(
    () =>
      buildNewsnowPersonalizationState({
        sortMode,
        affinitySamples,
        manualOrderColumnCount,
        panelOpen: isPersonalizationPanelOpen,
      }),
    [affinitySamples, isPersonalizationPanelOpen, manualOrderColumnCount, sortMode],
  );
  const visibility = useMemo(
    () =>
      resolveNewsnowHeaderVisibility({
        isMobile,
      }),
    [isMobile],
  );
  const activeSortMode = personalizationState.isPersonalized ? "personalized" : "manual";
  const realtimeTone = realtimeToneClassNames[realtimeSummary.tone];

  useEffect(() => {
    if (!personalizationState.isPersonalized) {
      setIsPersonalizationPanelOpen(false);
    }
  }, [personalizationState.isPersonalized]);

  const handleClearBehaviorProfile = useCallback(async () => {
    setClearingBehavior(true);
    try {
      await apiClient.delete("user-news-behavior/profile");
      emitNewsnowPersonalizationUpdated({ updatedAt: Date.now() });
      messageApi.success("行为画像已清空");
    } catch (error) {
      captureClientError("Failed to clear NewsNow behavior profile", error);
      messageApi.error("清空行为画像失败");
    } finally {
      setClearingBehavior(false);
    }
  }, [apiClient, messageApi]);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[var(--border)] bg-[var(--background)]">
      {contextHolder}
      <NewsnowBoardContainer spacing="header" className="flex flex-col gap-3">
        <div className="content-card px-3 py-2.5 md:px-4">
          <div className="flex items-center gap-3">
            <nav className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {tabs.map((tab) => (
                <Link
                  key={tab.key}
                  href={tab.href}
                  aria-current={tab.isActive ? "page" : undefined}
                  className={`group inline-flex shrink-0 items-center rounded px-3 py-2 text-sm font-medium tracking-[0.01em] transition-colors duration-200 ${
                    tab.isActive
                      ? "border-b-2 border-[var(--foreground)] text-[var(--foreground)]"
                      : "border-b-2 border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}
                >
                  <span className="truncate">{tab.name}</span>
                </Link>
              ))}
            </nav>

            {visibility.showUtilityLinks ? (
              <div className="hidden shrink-0 items-center gap-1 xl:flex">
                {NEWSNOW_UTILITY_LINKS.map((link) => (
                  <Link key={link.href} href={link.href}>
                    <span className="inline-flex rounded px-2.5 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
                      {link.label}
                    </span>
                  </Link>
                ))}
              </div>
            ) : null}

            {visibility.showDesktopSearch ? (
              <Button
                type="default"
                size="small"
                icon={<SearchOutlined />}
                onClick={() => setIsSearchOpen(true)}
                className="hidden items-center md:inline-flex"
              >
                搜索
              </Button>
            ) : null}
          </div>
        </div>

        <div className="content-card px-3 py-3 md:px-4 md:py-3.5">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="flex min-w-0 flex-col gap-2.5 md:flex-row md:flex-wrap md:items-stretch">
                {isRecommendedTab ? null : (
                  <div className={`${controlShellClassName} min-w-0`}>
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <span className={controlLabelClassName}>排序</span>
                      <Segmented
                        size="small"
                        value={activeSortMode}
                        options={[
                          { label: "手动", value: "manual" },
                          { label: "个性化", value: "personalized" },
                        ]}
                        onChange={(value) => setSortMode(value as "manual" | "personalized")}
                      />
                    </div>
                  </div>
                )}

                <div className={`${controlShellClassName} min-w-0`}>
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <Tooltip title="跨源标题相同新闻将仅保留首个来源卡片中的条目">
                      <div className="inline-flex items-center gap-2">
                        <span className={controlLabelClassName}>去重</span>
                        <Switch
                          size="small"
                          checked={hideCrossSourceDuplicates}
                          onChange={(checked) => setHideCrossSourceDuplicates(checked)}
                        />
                      </div>
                    </Tooltip>

                    <div className="hidden h-7 w-px bg-[var(--border)] sm:block" />

                    <Tooltip title="调整列表密度：紧凑优先信息量，舒适优先可读性。">
                      <div className="inline-flex min-w-0 items-center gap-2">
                        <span className={controlLabelClassName}>密度</span>
                        <Segmented
                          size="small"
                          value={densityMode}
                          options={[
                            { label: "紧凑", value: "compact" },
                            { label: "舒适", value: "comfortable" },
                          ]}
                          onChange={(value) =>
                            setDensityMode(value as "compact" | "comfortable")
                          }
                        />
                      </div>
                    </Tooltip>
                  </div>
                </div>

                {visibility.showInlineSearch ? (
                  <Button
                    type="default"
                    size="small"
                    icon={<SearchOutlined />}
                    onClick={() => setIsSearchOpen(true)}
                    className="inline-flex w-full items-center justify-center sm:w-auto"
                  >
                    搜索
                  </Button>
                ) : null}
              </div>

              <div
                className={`flex flex-wrap items-center gap-2.5 ${
                  visibility.stackSummaryRow ? "w-full" : "justify-end xl:ml-6"
                }`}
              >
                <Tooltip title={realtimeSummary.tooltip}>
                  <div
                    className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-sm ${realtimeTone.shell}`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${realtimeTone.dot} ${
                        realtimeSummary.tone === "active" ? "animate-pulse" : ""
                      }`}
                    />
                    <span className="font-medium">{realtimeSummary.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${realtimeTone.badge}`}
                    >
                      {realtimeSummary.detail}
                    </span>
                  </div>
                </Tooltip>

                {personalizationState.showSummary ? (
                  <Tooltip title="根据本地偏好与行为画像计算个性化排序。重置本地偏好不会清空服务端行为画像。">
                    <div className="inline-flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--foreground)]">
                      <span className="kicker">个性化</span>
                      <span className="font-medium">{personalizationState.summaryText}</span>
                    </div>
                  </Tooltip>
                ) : null}

                {personalizationState.showManageButton ? (
                  <Button
                    size="small"
                    type={personalizationState.showPanel ? "default" : "text"}
                    aria-expanded={personalizationState.showPanel}
                    onClick={() =>
                      setIsPersonalizationPanelOpen((current) => !current)
                    }
                    className={`rounded font-medium ${
                      personalizationState.showPanel
                        ? "border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)]"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {personalizationState.showPanel ? "收起偏好" : "管理偏好"}
                  </Button>
                ) : null}
              </div>
            </div>

            {personalizationState.showPanel ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      个性化排序管理
                    </p>
                    <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                      根据本地偏好与行为画像计算个性化排序。重置本地偏好不会清空服务端行为画像。
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="small"
                      type="text"
                      onClick={() => resetSourceAffinity()}
                      disabled={affinitySamples === 0}
                    >
                      重置本地偏好
                    </Button>

                    <Popconfirm
                      title="清空行为画像"
                      description="将删除服务端累计的来源/主题/实体偏好分，影响个性化排序。"
                      okText="确认清空"
                      cancelText="取消"
                      onConfirm={() => handleClearBehaviorProfile()}
                    >
                      <Button size="small" type="text" loading={clearingBehavior}>
                        清空行为画像
                      </Button>
                    </Popconfirm>

                    {personalizationState.showResetColumnOrders ? (
                      <Button
                        size="small"
                        type="text"
                        onClick={() => resetColumnOrders()}
                      >
                        清除手动顺序
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </NewsnowBoardContainer>

      <NewsnowSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
    </header>
  );
}
