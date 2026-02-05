"use client";

import { FireOutlined, RiseOutlined } from "@ant-design/icons";
import { useQuery } from "@apollo/client";
import { gql } from "@apollo/client";
import { Card, Skeleton, Tag } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

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

function getTrendType(index: number): "hot" | "rising" | "stable" {
  if (index < 2) return "hot";
  if (index < 5) return "rising";
  return "stable";
}

function formatTrend(count: number): string {
  if (count >= 100) return "+" + Math.round(count / 10) * 10;
  return `+${count}`;
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
      <Card
        title={
          <div className="flex items-center gap-2">
            <FireOutlined className="text-orange-500" /> {t("pages.today.hotTopics", { defaultValue: "Hot Topics" })}
          </div>
        }
        size="small"
        className="glass-card"
      >
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
    );
  }

  if (topics.length === 0) {
    return null;
  }

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <FireOutlined className="text-orange-500" /> {t("pages.today.hotTopics", { defaultValue: "Hot Topics" })}
        </div>
      }
      size="small"
      className="glass-card"
    >
      <div className="flex flex-col gap-1">
        {topics.map((topic, index) => {
          const trendType = getTrendType(index);
          const trendColor = trendType === "hot" ? "red" : trendType === "rising" ? "orange" : "green";

          return (
            <div
              key={topic.value}
              className="flex items-center justify-between p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded cursor-pointer transition-colors group"
              onClick={() => router.push(`/search?topic=${encodeURIComponent(topic.value)}`)}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-gray-400 font-mono text-xs w-5">{String(index + 1).padStart(2, "0")}</span>
                <span className="font-medium text-sm group-hover:text-blue-500 transition-colors truncate">
                  {topic.value}
                </span>
              </div>
              <Tag color={trendColor} icon={<RiseOutlined />} className="text-[10px] shrink-0">
                {formatTrend(topic.count)}
              </Tag>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
