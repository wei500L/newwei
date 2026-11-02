"use client";

import { useQuery , gql } from "@apollo/client";
import { Skeleton } from "antd";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { SectionHeader } from "@/components/section-header";

const HOT_TOPICS_QUERY = gql`
  query HotTopics($search: String, $filters: ItemsFiltersInput) {
    itemFacets(search: $search, filters: $filters) {
      topics {
        value
        count
      }
    }
  }
`;

interface TopicFacet {
  value: string;
  count: number;
}

export function HotTopics() {
  const { t } = useTranslation();

  const { data, loading, error } = useQuery<{ itemFacets: { topics: TopicFacet[] } }>(HOT_TOPICS_QUERY, {
    fetchPolicy: "cache-first"
  });

  const topics = data?.itemFacets?.topics?.slice(0, 8) ?? [];

  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader kicker={t("pages.today.kickers.hotTopics")} title={t("pages.today.hotTopics.title")} />
        <Skeleton active paragraph={{ rows: 4 }} />
      </section>
    );
  }

  if (error) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader kicker={t("pages.today.kickers.hotTopics")} title={t("pages.today.hotTopics.title")} />
        <RequestErrorBanner error={error} presentation="center" className="h-auto py-6" />
      </section>
    );
  }

  if (topics.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader kicker={t("pages.today.kickers.hotTopics")} title={t("pages.today.hotTopics.title")} />
        <ChartEmptyState className="h-auto py-6" description={t("pages.today.hotTopics.empty")} />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader kicker={t("pages.today.kickers.hotTopics")} title={t("pages.today.hotTopics.title")} />
      <div className="flex flex-col divide-y divide-[var(--border)]">
        {topics.map((topic, index) => (
          <Link
            key={topic.value}
            href={`/search?topic=${encodeURIComponent(topic.value)}`}
            className="group flex cursor-pointer items-baseline gap-3 py-2"
          >
            <span className="w-5 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm group-hover:underline underline-offset-4">
              {topic.value}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {topic.count}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
