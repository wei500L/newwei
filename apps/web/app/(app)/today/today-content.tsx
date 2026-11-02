"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";
import { SectionHeader } from "@/components/section-header";
import { usePageTitle } from "@/hooks/use-page-title";
import dayjs from "@/lib/dayjs";
import { resolveLocale } from "@/lib/i18n";

import { BreakingAlerts } from "./components/breaking-alerts";
import { Headlines } from "./components/headlines";
import { HotTopics } from "./components/hot-topics";
import { UserDigestPanel } from "./user-digest-panel";

export function TodayContent() {
  const { t, i18n } = useTranslation();
  usePageTitle(t("nav.main.today"));
  const [todayLabel, setTodayLabel] = useState<string>("Today");
  const [todayDateRange, setTodayDateRange] = useState<
    [ReturnType<typeof dayjs>, ReturnType<typeof dayjs>] | undefined
  >(undefined);

  useEffect(() => {
    const now = dayjs();
    // dayjs locale 已由 app/providers.tsx 随 i18n 语言设置；这里显式指定，
    // 避免子组件 effect 早于 Provider effect 执行时首帧拿到英文星期名。
    const isZh = resolveLocale(i18n.language) === "zh-CN";
    setTodayLabel(
      now
        .locale(isZh ? "zh-cn" : "en")
        .format(isZh ? "M月D日 dddd" : "dddd, MMMM D"),
    );
    setTodayDateRange([now.startOf("day"), now.endOf("day")]);
  }, [i18n.language]);

  return (
    <div className="flex flex-col gap-6 pb-10">
      {/* 报头（仅 Today 使用，不抽通用组件） */}
      <header className="flex flex-col gap-2">
        <p className="kicker m-0">{t("pages.today.kicker")}</p>
        <h1
          className="m-0 font-serif text-3xl font-semibold leading-tight tracking-tight md:text-4xl"
          suppressHydrationWarning
        >
          {todayLabel}
        </h1>
        <p className="m-0 max-w-measure text-sm text-muted-foreground">
          {t("pages.today.subtitle")}
        </p>
        <div
          aria-hidden
          className="mt-2 h-[6px] border-y-2 border-[var(--border-strong)] [border-bottom-width:1px]"
        />
      </header>

      {/* 突发条 */}
      <BreakingAlerts />

      {/* 头版栅格：左 7 栏头条 / 右 5 栏热点 + 我的摘要 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-7">
          <Headlines />
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-span-5 lg:border-l lg:border-[var(--border)] lg:pl-6">
          <HotTopics />
          <section className="flex flex-col gap-4 border-t border-[var(--border)] pt-6">
            <SectionHeader
              kicker={t("pages.today.kickers.myDigest")}
              title={t("pages.today.myDigest")}
            />
            <UserDigestPanel />
          </section>
        </div>
      </div>

      {/* 最新信息流（全宽） */}
      <section className="flex flex-col gap-3">
        <SectionHeader rule kicker={t("pages.today.kickers.latest")} title={t("pages.today.latestFeed")} />
        <ItemsView
          surface="none"
          initialView="feed"
          emptyStateVariant="today"
          sortMode="publishedDesc"
          experiencePreset="reader"
          density="compact"
          initialFilters={{
            dateRange: todayDateRange
          }}
        />
      </section>
    </div>
  );
}
