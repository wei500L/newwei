"use client";

import { SearchOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Segmented, Space, Switch, Tooltip, Typography, message } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { emitNewsnowPersonalizationUpdated } from "@/lib/newsnow-personalization-events";

import { useNewsMetadata } from "../hooks/use-news-sources";
import { useNewsnowStore } from "../store/newsnow-store";

import { NewsnowSearch } from "./newsnow-search";

export function NewsnowHeader() {
  const pathname = usePathname();
  const { data: metadata } = useNewsMetadata();
  const { data: session } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const [messageApi, contextHolder] = message.useMessage();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
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

  const staticTabs = [
    { key: "focus", name: "关注" },
    { key: "hottest", name: "最热" },
    { key: "realtime", name: "实时" },
  ];

  const dynamicTabs = metadata
    ? Object.entries(metadata.columns)
        .filter(([key]) => !["focus", "hottest", "realtime"].includes(key))
        .map(([key, column]) => ({ key, name: column.name }))
    : [];

  const allTabs = [...staticTabs, ...dynamicTabs];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.95)_0%,rgba(248,250,252,0.92)_100%)] shadow-[0_8px_24px_-18px_rgba(15,23,42,0.18)] backdrop-blur-md dark:border-white/10 dark:bg-[linear-gradient(180deg,rgba(7,10,17,0.96)_0%,rgba(6,9,15,0.94)_100%)] dark:shadow-[0_8px_24px_-18px_rgba(0,0,0,0.9)]">
      {contextHolder}
      <div className="mx-auto w-full max-w-[1760px] px-4 py-3 md:px-6 md:py-4 xl:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {allTabs.map((tab) => {
              const href = `/newsnow/${tab.key}`;
              const isActive = pathname === href;
              return (
                <Link
                  key={tab.key}
                  href={href}
                  aria-current={isActive ? "page" : undefined}
                  className={`whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-medium tracking-[0.01em] transition-[color,background-color,box-shadow,border-color] duration-200 ${
                    isActive
                      ? "bg-slate-900/10 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] ring-1 ring-slate-900/12 dark:bg-white/12 dark:text-zinc-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] dark:ring-white/20"
                      : "text-slate-600 hover:bg-slate-900/5 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-100"
                  }`}
                >
                  {tab.name}
                </Link>
              );
            })}
          </nav>
          <div className="flex shrink-0 items-center gap-2.5">
            <Space size={6} className="hidden xl:flex">
              <Link href="/news-hub">
                <span className="inline-flex rounded-lg px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-900/5 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-100">
                  Hub
                </span>
              </Link>
              <Link href="/items">
                <span className="inline-flex rounded-lg px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-900/5 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-100">
                  深读
                </span>
              </Link>
              <Link href="/events">
                <span className="inline-flex rounded-lg px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-900/5 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/6 dark:hover:text-zinc-100">
                  事件
                </span>
              </Link>
            </Space>
            <Button
              type="default"
              icon={<SearchOutlined />}
              onClick={() => setIsSearchOpen(true)}
              className="flex items-center rounded-xl border-slate-300/65 bg-white/65 text-slate-700 shadow-[0_8px_18px_-18px_rgba(15,23,42,0.7)] hover:border-slate-400/70 hover:text-slate-900 dark:border-white/15 dark:bg-white/5 dark:text-zinc-300 dark:hover:border-white/25 dark:hover:bg-white/10 dark:hover:text-zinc-100"
            >
              搜索
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2.5 md:mt-4">
          <div className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-slate-300/65 bg-white/68 px-2.5 py-1.5 shadow-[0_14px_28px_-26px_rgba(15,23,42,0.9)] dark:border-white/12 dark:bg-white/[0.045]">
            <Segmented
              size="small"
              value={sortMode}
              options={[
                { label: "手动", value: "manual" },
                { label: "个性化", value: "personalized" },
              ]}
              onChange={(value) => setSortMode(value as "manual" | "personalized")}
            />
            <Tooltip title={realtimeConnected ? "实时连接正常" : "实时连接断开"}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <span
                  className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                    realtimeConnected ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                />
                实时 {realtimeUnreadTotal > 0 ? `${realtimeUnreadTotal}` : ""}
              </Typography.Text>
            </Tooltip>
          </div>

          <div className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-slate-300/65 bg-white/68 px-2.5 py-1.5 shadow-[0_14px_28px_-26px_rgba(15,23,42,0.9)] dark:border-white/12 dark:bg-white/[0.045]">
            <Tooltip title="跨源标题相同新闻将仅保留首个来源卡片中的条目">
              <Space size={4} align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  去重
                </Typography.Text>
                <Switch
                  size="small"
                  checked={hideCrossSourceDuplicates}
                  onChange={(checked) => setHideCrossSourceDuplicates(checked)}
                />
              </Space>
            </Tooltip>
            <Tooltip title="调整列表密度：紧凑优先信息量，舒适优先可读性。">
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
            </Tooltip>
          </div>

          {sortMode === "personalized" ? (
            <Tooltip title="根据本地偏好与行为画像计算个性化排序。重置本地偏好不会清空服务端行为画像。">
              <div className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-300/65 bg-white/68 px-2.5 py-1.5 shadow-[0_14px_28px_-26px_rgba(15,23,42,0.9)] dark:border-white/12 dark:bg-white/[0.045]">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  样本 {affinitySamples}
                </Typography.Text>
                {manualOrderColumnCount > 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    手动顺序 {manualOrderColumnCount} 列
                  </Typography.Text>
                ) : null}
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
                {manualOrderColumnCount > 0 ? (
                  <Button
                    size="small"
                    type="text"
                    onClick={() => resetColumnOrders()}
                  >
                    清除手动顺序
                  </Button>
                ) : null}
              </div>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <NewsnowSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
    </header>
  );
}
