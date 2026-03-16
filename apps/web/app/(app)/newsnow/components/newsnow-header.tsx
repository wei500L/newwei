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

import { NewsnowSearch } from "./newsnow-search";

const controlShellClassName =
  "rounded-[22px] border border-slate-200/75 bg-white/78 px-3 py-2.5 shadow-[0_16px_36px_-30px_rgba(15,23,42,0.85)] backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.055] dark:shadow-[0_20px_48px_-34px_rgba(0,0,0,0.9)]";

const controlLabelClassName =
  "px-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-zinc-500";

const realtimeToneClassNames = {
  active: {
    shell:
      "border-emerald-200/80 bg-emerald-50/85 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100",
    dot: "bg-emerald-500",
    badge:
      "bg-emerald-500/12 text-emerald-700 ring-1 ring-emerald-500/15 dark:bg-emerald-400/15 dark:text-emerald-100 dark:ring-emerald-400/20",
  },
  idle: {
    shell:
      "border-slate-200/80 bg-slate-50/90 text-slate-700 dark:border-white/12 dark:bg-white/[0.05] dark:text-zinc-200",
    dot: "bg-emerald-400",
    badge:
      "bg-white/80 text-slate-600 ring-1 ring-slate-200/70 dark:bg-white/10 dark:text-zinc-300 dark:ring-white/10",
  },
  offline: {
    shell:
      "border-amber-200/80 bg-amber-50/90 text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100",
    dot: "bg-amber-500",
    badge:
      "bg-amber-500/12 text-amber-700 ring-1 ring-amber-500/15 dark:bg-amber-400/15 dark:text-amber-100 dark:ring-amber-400/20",
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
    <header className="sticky top-0 z-50 w-full border-b border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.95)_0%,rgba(248,250,252,0.92)_100%)] shadow-[0_8px_24px_-18px_rgba(15,23,42,0.18)] backdrop-blur-md dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(7,10,17,0.96)_0%,rgba(6,9,15,0.94)_100%)] dark:shadow-[0_8px_24px_-18px_rgba(0,0,0,0.9)]">
      {contextHolder}
      <div className="mx-auto flex w-full max-w-[1760px] flex-col gap-3 px-4 py-3 md:px-6 md:py-4 xl:px-8">
        <div className="glass-panel rounded-[26px] border border-white/40 px-3 py-2.5 shadow-[0_18px_42px_-30px_rgba(15,23,42,0.72)] dark:border-white/10 dark:bg-white/[0.04] md:px-4">
          <div className="flex items-center gap-3">
            <nav className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {tabs.map((tab) => (
                <Link
                  key={tab.key}
                  href={tab.href}
                  aria-current={tab.isActive ? "page" : undefined}
                  className={`group inline-flex shrink-0 items-center rounded-2xl px-3 py-2 text-sm font-medium tracking-[0.01em] transition-[color,background-color,box-shadow,border-color,transform] duration-200 ${
                    tab.isActive
                      ? "bg-slate-950 text-white shadow-[0_16px_30px_-22px_rgba(15,23,42,0.9)] dark:bg-white dark:text-slate-950"
                      : "text-slate-600 hover:bg-slate-900/6 hover:text-slate-950 dark:text-zinc-400 dark:hover:bg-white/8 dark:hover:text-zinc-100"
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
                    <span className="inline-flex rounded-xl px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-900/6 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/8 dark:hover:text-zinc-100">
                      {link.label}
                    </span>
                  </Link>
                ))}
              </div>
            ) : null}

            {visibility.showDesktopSearch ? (
              <Button
                type="default"
                icon={<SearchOutlined />}
                onClick={() => setIsSearchOpen(true)}
                className="hidden items-center rounded-2xl border-slate-300/70 bg-white/82 text-slate-700 shadow-[0_12px_24px_-24px_rgba(15,23,42,0.9)] hover:border-slate-400/75 hover:text-slate-900 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:border-white/25 dark:hover:bg-white/[0.1] dark:hover:text-zinc-100 md:inline-flex"
              >
                搜索
              </Button>
            ) : null}
          </div>
        </div>

        <div className="glass-panel rounded-[26px] border border-white/40 px-3 py-3 shadow-[0_20px_44px_-30px_rgba(15,23,42,0.76)] dark:border-white/10 dark:bg-white/[0.04] md:px-4 md:py-3.5">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="flex min-w-0 flex-col gap-2.5 md:flex-row md:flex-wrap md:items-stretch">
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

                    <div className="hidden h-7 w-px bg-slate-200/85 dark:bg-white/10 sm:block" />

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
                    icon={<SearchOutlined />}
                    onClick={() => setIsSearchOpen(true)}
                    className="inline-flex w-full items-center justify-center rounded-2xl border-slate-300/70 bg-white/82 text-slate-700 shadow-[0_12px_24px_-24px_rgba(15,23,42,0.9)] hover:border-slate-400/75 hover:text-slate-900 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:border-white/25 dark:hover:bg-white/[0.1] dark:hover:text-zinc-100 sm:w-auto"
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
                    className={`inline-flex items-center gap-2 rounded-[20px] border px-3 py-2 text-sm shadow-[0_12px_24px_-24px_rgba(15,23,42,0.7)] ${realtimeTone.shell}`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${realtimeTone.dot} ${
                        realtimeSummary.tone === "active" ? "animate-pulse" : ""
                      }`}
                    />
                    <span className="font-medium">{realtimeSummary.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${realtimeTone.badge}`}
                    >
                      {realtimeSummary.detail}
                    </span>
                  </div>
                </Tooltip>

                {personalizationState.showSummary ? (
                  <Tooltip title="根据本地偏好与行为画像计算个性化排序。重置本地偏好不会清空服务端行为画像。">
                    <div className="inline-flex items-center gap-2 rounded-[20px] border border-sky-200/80 bg-sky-50/85 px-3 py-2 text-sm text-sky-950 shadow-[0_12px_24px_-24px_rgba(15,23,42,0.7)] dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-100">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-200">
                        个性化
                      </span>
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
                    className={`rounded-xl font-medium ${
                      personalizationState.showPanel
                        ? "border-slate-300/75 bg-white/85 text-slate-900 dark:border-white/15 dark:bg-white/[0.08] dark:text-zinc-100"
                        : "text-slate-600 hover:text-slate-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                    }`}
                  >
                    {personalizationState.showPanel ? "收起偏好" : "管理偏好"}
                  </Button>
                ) : null}
              </div>
            </div>

            {personalizationState.showPanel ? (
              <div className="rounded-[24px] border border-slate-200/80 bg-slate-50/78 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:border-white/10 dark:bg-white/[0.045]">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                      个性化排序管理
                    </p>
                    <p className="text-xs leading-5 text-slate-500 dark:text-zinc-400">
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
      </div>

      <NewsnowSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
    </header>
  );
}
