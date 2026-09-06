"use client";

/**
 * Crawl Task Detail 单结果项（FE-批5A：自 task-detail.tsx 拆出）。
 * 源链接/抓取时间/item 状态与操作、raw/citations/references/fit
 * markdown variants（单一 variant 不渲染 Tabs）、metadata 与媒体表格。
 */

import { Button, List, Space, Tabs, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import type { CrawlResultActionController } from "./hooks/use-crawl-result-actions";
import { markdownPreviewStyle, safeParseJson } from "./task-detail-formatters";
import { MediaSection } from "./task-detail-media-section";
import { StoredMediaSection } from "./task-detail-stored-media-section";
import { TablesSection } from "./task-detail-tables-section";
import type {
  CrawlMediaCollection,
  CrawlResultTable,
  CrawlStoredMediaAsset,
  CrawlTaskDetailResult,
} from "./task-detail-types";

const itemStatusColors: Record<string, string> = {
  draft: "default",
  pending: "gold",
  processing: "blue",
  completed: "green",
  failed: "red",
  duplicate: "purple",
};

interface ResultItemProps {
  result: CrawlTaskDetailResult;
  canViewItems: boolean;
  canCreateItem: boolean;
  resultActions: CrawlResultActionController;
  locale: SupportedLocale;
}

export function TaskDetailResultItem({
  result,
  canViewItems,
  canCreateItem,
  resultActions,
  locale,
}: ResultItemProps) {
  const { t } = useTranslation();
  const metadata = result.metadata;
  const mediaPayload = safeParseJson<CrawlMediaCollection>(result.media);
  const storedAssets = safeParseJson<CrawlStoredMediaAsset[]>(
    result.mediaAssets,
  );
  const tablesPayload = (result.tables ?? null) as CrawlResultTable[] | null;
  const itemId = result.itemId ?? null;
  const itemStatus =
    result.itemStatus?.toLowerCase?.() ?? result.itemStatus ?? null;
  const itemTagColor =
    itemStatus && typeof itemStatus === "string"
      ? (itemStatusColors[itemStatus] ?? "default")
      : "default";
  const variantEntries = [
    {
      key: "raw",
      label: t("crawl.detail.results.variants.raw"),
      content: result.markdown,
    },
    {
      key: "citations",
      label: t("crawl.detail.results.variants.citations"),
      content: result.markdownWithCitations,
    },
    {
      key: "references",
      label: t("crawl.detail.results.variants.references"),
      content: result.referencesMarkdown,
    },
    {
      key: "fit",
      label: t("crawl.detail.results.variants.cleanFit"),
      content: result.fitMarkdown,
    },
  ].filter((entry) => entry.content && entry.content.length > 0);
  const defaultContent = (
    <pre
      className="markdown-preview"
      style={{ ...markdownPreviewStyle, marginTop: 8 }}
    >
      {result.markdown}
    </pre>
  );
  const tabs =
    variantEntries.length > 1 ? (
      <Tabs
        size="small"
        style={{ marginTop: 8 }}
        items={variantEntries.map((entry) => ({
          key: entry.key,
          label: entry.label,
          children: (
            <pre
              className="markdown-preview"
              style={{ ...markdownPreviewStyle, marginTop: 8 }}
            >
              {entry.content}
            </pre>
          ),
        }))}
      />
    ) : (
      defaultContent
    );
  return (
    <List.Item key={result.id}>
      <List.Item.Meta
        title={
          <Space wrap>
            <Typography.Link href={result.sourceUrl} target="_blank">
              {result.sourceUrl}
            </Typography.Link>
            <Typography.Text type="secondary">
              {formatDateTime(result.fetchedAt, locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Typography.Text>
            {itemId ? (
              <>
                {itemStatus ? (
                  <Tag color={itemTagColor}>
                    {t(`items.status.${itemStatus}`, {
                      defaultValue: itemStatus,
                    })}
                  </Tag>
                ) : null}
                {canViewItems ? (
                  <Button
                    size="small"
                    onClick={() => resultActions.openItem(itemId)}
                  >
                    {t("crawl.detail.openItem")}
                  </Button>
                ) : null}
              </>
            ) : canCreateItem ? (
              <Button
                size="small"
                loading={
                  resultActions.ingesting &&
                  resultActions.ingestingResultId === result.id
                }
                onClick={() => void resultActions.createItem(result.id)}
              >
                {t("crawl.detail.ingestToItems")}
              </Button>
            ) : null}
          </Space>
        }
        description={
          <>
            {metadata && (
              <Typography.Text type="secondary">{metadata}</Typography.Text>
            )}
            {tabs}
            <MediaSection media={mediaPayload} />
            <StoredMediaSection assets={storedAssets} />
            <TablesSection tables={tablesPayload} />
          </>
        }
      />
    </List.Item>
  );
}
