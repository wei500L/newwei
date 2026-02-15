"use client";

import { ArrowRightOutlined } from "@ant-design/icons";
import { useQuery } from "@apollo/client";
import { gql } from "@apollo/client";
import { Card, Skeleton } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { resolveArticlePublishedTime } from "@/components/article-published-time";
import dayjs from "@/lib/dayjs";
import { resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

const HEADLINES_QUERY = gql`
  query Headlines($first: Int!, $filters: ItemsFiltersInput, $orderBy: ItemsOrderBy) {
    items(first: $first, filters: $filters, orderBy: $orderBy) {
      edges {
        node {
          id
          title
          publishedAt
          rawPreview {
            url
            sourceName
            thumbnail
          }
          processedPreview {
            summary
            qualityScore
          }
        }
      }
    }
  }
`;

interface HeadlineItem {
  id: string;
  title: string;
  publishedAt?: string;
  rawPreview?: {
    url?: string;
    sourceName?: string;
    thumbnail?: string;
  };
  processedPreview?: {
    summary?: string;
    qualityScore?: number;
  };
}

export function Headlines() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale = resolveLocale(i18n.language);

  const { data, loading } = useQuery<{ items: { edges: { node: HeadlineItem }[] } }>(HEADLINES_QUERY, {
    variables: {
      first: 4,
      filters: {
        dateRange: {
          start: dayjs().startOf("day").toISOString(),
          end: dayjs().endOf("day").toISOString()
        }
      },
      orderBy: "PUBLISHED_DESC"
    },
    fetchPolicy: "cache-first"
  });

  const items = data?.items?.edges?.map((e) => e.node) ?? [];
  const heroItem = items[0];
  const subItems = items.slice(1, 4);
  const publishedUnknown = t("items.time.publishedUnknown", {
    defaultValue: "Published time unknown"
  });

  if (loading) {
    return (
      <Card className="glass-card overflow-hidden" styles={{ body: { padding: 0 } }} variant="borderless">
        <Skeleton active paragraph={{ rows: 6 }} className="p-6" />
      </Card>
    );
  }

  if (!heroItem) {
    return null;
  }

  const heroThumbnail = safeHttpUrl(heroItem.rawPreview?.thumbnail);
  const heroPublished = resolveArticlePublishedTime({
    publishedAt: heroItem.publishedAt ?? null,
    locale,
    formatOptions: { dateStyle: "medium", timeStyle: "short" },
    unknownText: publishedUnknown
  });

  return (
    <Card className="glass-card overflow-hidden" styles={{ body: { padding: 0 } }} variant="borderless">
      {/* Hero Section */}
      <div
        className="relative h-64 w-full group cursor-pointer"
        onClick={() => router.push(`/items/${heroItem.id}`)}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent z-10" />
        {heroThumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={heroThumbnail}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-900" />
        )}

        <div className="absolute bottom-0 left-0 p-6 z-20 w-full">
          <div className="flex items-center gap-2 mb-2">
            <span className="bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider">
              {t("pages.today.headline", { defaultValue: "Headline" })}
            </span>
            {heroItem.rawPreview?.sourceName && (
              <span className="text-white/70 text-xs">{heroItem.rawPreview.sourceName}</span>
            )}
          </div>
          <h2 className="text-white text-xl md:text-2xl font-bold leading-tight mb-2 group-hover:underline decoration-blue-400 underline-offset-4 transition-all">
            {heroItem.title}
          </h2>
          {heroItem.processedPreview?.summary && (
            <p className="text-gray-300 text-sm line-clamp-2 mb-3">
              {heroItem.processedPreview.summary}
            </p>
          )}
          <div className="mb-3">
            <p className="text-white/85 text-xs m-0">{heroPublished.primaryText}</p>
            {heroPublished.relativeText ? (
              <p className="text-white/65 text-[11px] m-0">{heroPublished.relativeText}</p>
            ) : null}
          </div>
          <div className="flex items-center text-blue-300 text-xs font-medium gap-1">
            {t("common.readMore", { defaultValue: "Read full story" })} <ArrowRightOutlined />
          </div>
        </div>
      </div>

      {/* Sub Headlines */}
      {subItems.length > 0 && (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {subItems.map((item) => {
            const itemPublished = resolveArticlePublishedTime({
              publishedAt: item.publishedAt ?? null,
              locale,
              formatOptions: { dateStyle: "medium", timeStyle: "short" },
              unknownText: publishedUnknown
            });

            return (
              <div
                key={item.id}
                className="p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors"
                onClick={() => router.push(`/items/${item.id}`)}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 m-0">
                      {item.title}
                    </h3>
                    {item.rawPreview?.sourceName ? (
                      <p className="text-xs text-gray-500 mt-1 mb-0">{item.rawPreview.sourceName}</p>
                    ) : null}
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 mb-0">{itemPublished.primaryText}</p>
                    {itemPublished.relativeText ? (
                      <p className="text-[11px] text-gray-500 dark:text-gray-500 mt-0.5 mb-0">{itemPublished.relativeText}</p>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
