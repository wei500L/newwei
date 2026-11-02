"use client";

import { useQuery , gql } from "@apollo/client";
import { Skeleton } from "antd";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import { resolveArticlePublishedTime } from "@/components/article-published-time";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { NewsImage } from "@/components/news-image";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { SectionHeader } from "@/components/section-header";
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
  const locale = resolveLocale(i18n.language);

  const { data, loading, error } = useQuery<{ items: { edges: { node: HeadlineItem }[] } }>(HEADLINES_QUERY, {
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
  const publishedUnknown = t("items.time.publishedUnknown");

  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader kicker={t("pages.today.kickers.headlines")} title={t("pages.today.headlines.title")} />
        <Skeleton active paragraph={{ rows: 6 }} />
      </section>
    );
  }

  if (error) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader kicker={t("pages.today.kickers.headlines")} title={t("pages.today.headlines.title")} />
        <RequestErrorBanner error={error} presentation="center" className="h-auto py-6" />
      </section>
    );
  }

  if (!heroItem) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader kicker={t("pages.today.kickers.headlines")} title={t("pages.today.headlines.title")} />
        <ChartEmptyState className="h-auto py-6" description={t("pages.today.headlines.empty")} />
      </section>
    );
  }

  const heroThumbnail = safeHttpUrl(heroItem.rawPreview?.thumbnail);
  const heroPublished = resolveArticlePublishedTime({
    publishedAt: heroItem.publishedAt ?? null,
    locale,
    formatOptions: { dateStyle: "medium", timeStyle: "short" },
    unknownText: publishedUnknown
  });
  const heroSource = heroItem.rawPreview?.sourceName;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader kicker={t("pages.today.kickers.headlines")} title={t("pages.today.headlines.title")} />

      {/* 头条：图文分离 */}
      <Link
        href={`/items/${heroItem.id}`}
        className="group flex cursor-pointer flex-col gap-2"
      >
        {heroThumbnail ? (
          <NewsImage
            src={heroThumbnail}
            alt={heroItem.title}
            aspectRatio="video"
            fallback="gradient"
            fallbackText={heroSource ?? heroItem.title}
            priority
          />
        ) : null}

        <p className="kicker m-0 flex flex-wrap items-baseline gap-x-2">
          {heroSource ? <span>{heroSource}</span> : null}
          <span>· {heroPublished.primaryText}</span>
          {heroPublished.relativeText ? <span>· {heroPublished.relativeText}</span> : null}
        </p>

        <h3 className="m-0 font-serif text-2xl font-semibold leading-snug line-clamp-3 group-hover:underline underline-offset-4">
          {heroItem.title}
        </h3>

        {heroItem.processedPreview?.summary ? (
          <p className="m-0 text-sm text-muted-foreground line-clamp-2">
            {heroItem.processedPreview.summary}
          </p>
        ) : null}
      </Link>

      {/* 次条：无图，右侧缩略图 */}
      {subItems.length > 0 ? (
        <div className="divide-y divide-[var(--border)]">
          {subItems.map((item) => {
            const itemPublished = resolveArticlePublishedTime({
              publishedAt: item.publishedAt ?? null,
              locale,
              formatOptions: { dateStyle: "medium", timeStyle: "short" },
              unknownText: publishedUnknown
            });
            const itemThumbnail = safeHttpUrl(item.rawPreview?.thumbnail);
            const itemSource = item.rawPreview?.sourceName;

            return (
              <Link
                key={item.id}
                href={`/items/${item.id}`}
                className="flex cursor-pointer items-start gap-3 py-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h4 className="m-0 text-[15px] font-semibold leading-snug line-clamp-2">
                    {item.title}
                  </h4>
                  <p className="m-0 font-mono text-xs text-muted-foreground">
                    {itemSource ? `${itemSource} · ` : ""}
                    {itemPublished.primaryText}
                    {itemPublished.relativeText ? ` · ${itemPublished.relativeText}` : ""}
                  </p>
                </div>
                {itemThumbnail ? (
                  <NewsImage
                    src={itemThumbnail}
                    alt={item.title}
                    aspectRatio="square"
                    fallback="initials"
                    fallbackText={itemSource ?? item.title}
                    className="w-12 shrink-0"
                  />
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
