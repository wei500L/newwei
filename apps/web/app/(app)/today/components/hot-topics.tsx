"use client";

import { useQuery , gql } from "@apollo/client";
import { Skeleton } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

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
  const router = useRouter();

  const { data, loading } = useQuery<{ itemFacets: { topics: TopicFacet[] } }>(HOT_TOPICS_QUERY, {
    fetchPolicy: "cache-first"
  });

  const topics = data?.itemFacets?.topics?.slice(0, 8) ?? [];

  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader kicker="HOT TOPICS" title={t("pages.today.hotTopics")} />
        <Skeleton active paragraph={{ rows: 4 }} />
      </section>
    );
  }

  if (topics.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader kicker="HOT TOPICS" title={t("pages.today.hotTopics")} />
      <div className="flex flex-col divide-y divide-[var(--border)]">
        {topics.map((topic, index) => (
          <div
            key={topic.value}
            className="group flex cursor-pointer items-baseline gap-3 py-2"
            onClick={() => router.push(`/search?topic=${encodeURIComponent(topic.value)}`)}
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
          </div>
        ))}
      </div>
    </section>
  );
}
