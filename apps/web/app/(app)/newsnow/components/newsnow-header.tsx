"use client";

import { SearchOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Segmented, Switch, Tooltip, message } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
  "rounded bg-[var(--surface-muted)] px-3 py-2.5";

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
  const { t } = useTranslation();
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
  const staticTabLabels: Record<string, string> = {
    focus: t("newsnow.header.tabFocus"),
    hottest: t("newsnow.header.tabHottest"),
    realtime: t("newsnow.header.tabRealtime"),
    recommended: t("newsnow.header.tabRecommended"),
  };
  const utilityLinkLabels: Record<string, string> = {
    "/news-hub": t("newsnow.header.utilityHub"),
    "/items": t("newsnow.header.utilityItems"),
    "/events": t("newsnow.header.utilityEvents"),
  };
  const realtimeLabel =
    realtimeSummary.tone === "offline"
      ? t("newsnow.header.realtimeOffline")
      : realtimeSummary.tone === "active"
        ? t("newsnow.header.realtimeActive")
        : t("newsnow.header.realtimeIdle");
  const realtimeDetail =
    realtimeSummary.tone === "offline"
      ? realtimeSummary.unreadCount > 0
        ? t("newsnow.header.realtimeUnhandled", { count: realtimeSummary.unreadCount })
        : t("newsnow.header.realtimeWaitingReconnect")
      : realtimeSummary.tone === "active"
        ? t("newsnow.header.realtimePending", { count: realtimeSummary.unreadCount })
        : t("newsnow.header.realtimeUpdating");
  const realtimeTooltip =
    realtimeSummary.tone === "offline"
      ? t("newsnow.header.realtimeOfflineTooltip")
      : t("newsnow.header.realtimeNormalTooltip");
  const personalizationSummaryText =
    manualOrderColumnCount > 0
      ? t("newsnow.header.summaryWithOrder", {
          samples: affinitySamples,
          count: manualOrderColumnCount,
        })
      : t("newsnow.header.summary", { samples: affinitySamples });

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
      messageApi.success(t("newsnow.header.clearBehaviorSuccess"));
    } catch (error) {
      captureClientError("Failed to clear NewsNow behavior profile", error);
      messageApi.error(t("newsnow.header.clearBehaviorFailed"));
    } finally {
      setClearingBehavior(false);
    }
  }, [apiClient, messageApi, t]);

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
                  <span className="truncate">
                    {tab.isStatic ? staticTabLabels[tab.key] ?? tab.name : tab.name}
                  </span>
                </Link>
              ))}
            </nav>

            {visibility.showUtilityLinks ? (
              <div className="hidden shrink-0 items-center gap-1 xl:flex">
                {NEWSNOW_UTILITY_LINKS.map((link) => (
                  <Link key={link.href} href={link.href}>
                    <span className="inline-flex rounded px-2.5 py-1.5 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
                      {utilityLinkLabels[link.href] ?? link.label}
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
                {t("common.search")}
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
                      <span className={controlLabelClassName}>{t("newsnow.header.sort")}</span>
                      <Segmented
                        size="small"
                        value={activeSortMode}
                        options={[
                          { label: t("newsnow.header.sortManual"), value: "manual" },
                          { label: t("newsnow.header.sortPersonalized"), value: "personalized" },
                        ]}
                        onChange={(value) => setSortMode(value as "manual" | "personalized")}
                      />
                    </div>
                  </div>
                )}

                <div className={`${controlShellClassName} min-w-0`}>
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <Tooltip title={t("newsnow.header.dedupeTooltip")}>
                      <div className="inline-flex items-center gap-2">
                        <span className={controlLabelClassName}>{t("newsnow.header.dedupe")}</span>
                        <Switch
                          size="small"
                          checked={hideCrossSourceDuplicates}
                          onChange={(checked) => setHideCrossSourceDuplicates(checked)}
                        />
                      </div>
                    </Tooltip>

                    <div className="hidden h-7 w-px bg-[var(--border)] sm:block" />

                    <Tooltip title={t("newsnow.header.densityTooltip")}>
                      <div className="inline-flex min-w-0 items-center gap-2">
                        <span className={controlLabelClassName}>{t("newsnow.header.density")}</span>
                        <Segmented
                          size="small"
                          value={densityMode}
                          options={[
                            { label: t("newsnow.header.densityCompact"), value: "compact" },
                            { label: t("newsnow.header.densityComfortable"), value: "comfortable" },
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
                    {t("common.search")}
                  </Button>
                ) : null}
              </div>

              <div
                className={`flex flex-wrap items-center gap-2.5 ${
                  visibility.stackSummaryRow ? "w-full" : "justify-end xl:ml-6"
                }`}
              >
                <Tooltip title={realtimeTooltip}>
                  <div
                    className={`inline-flex items-center gap-2 rounded border px-3 py-2 text-sm ${realtimeTone.shell}`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${realtimeTone.dot} ${
                        realtimeSummary.tone === "active" ? "animate-pulse" : ""
                      }`}
                    />
                    <span className="font-medium">{realtimeLabel}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${realtimeTone.badge}`}
                    >
                      {realtimeDetail}
                    </span>
                  </div>
                </Tooltip>

                {personalizationState.showSummary ? (
                  <Tooltip title={t("newsnow.header.personalizationTooltip")}>
                    <div className="inline-flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--foreground)]">
                      <span className="kicker">{t("newsnow.header.personalizationLabel")}</span>
                      <span className="font-medium">{personalizationSummaryText}</span>
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
                    {personalizationState.showPanel
                      ? t("newsnow.header.collapsePrefs")
                      : t("newsnow.header.managePrefs")}
                  </Button>
                ) : null}
              </div>
            </div>

            {personalizationState.showPanel ? (
              <div className="rounded-lg bg-[var(--surface-muted)] p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      {t("newsnow.header.panelTitle")}
                    </p>
                    <p className="text-xs leading-5 text-[var(--muted-foreground)]">
                      {t("newsnow.header.personalizationTooltip")}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="small"
                      type="text"
                      onClick={() => resetSourceAffinity()}
                      disabled={affinitySamples === 0}
                    >
                      {t("newsnow.header.resetLocalAffinity")}
                    </Button>

                    <Popconfirm
                      title={t("newsnow.header.clearBehaviorTitle")}
                      description={t("newsnow.header.clearBehaviorDescription")}
                      okText={t("newsnow.header.confirmClear")}
                      cancelText={t("common.cancel")}
                      onConfirm={() => handleClearBehaviorProfile()}
                    >
                      <Button size="small" type="text" loading={clearingBehavior}>
                        {t("newsnow.header.clearBehavior")}
                      </Button>
                    </Popconfirm>

                    {personalizationState.showResetColumnOrders ? (
                      <Button
                        size="small"
                        type="text"
                        onClick={() => resetColumnOrders()}
                      >
                        {t("newsnow.header.resetColumnOrders")}
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
