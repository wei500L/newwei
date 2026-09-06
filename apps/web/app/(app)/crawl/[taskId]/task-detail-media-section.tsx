"use client";

/**
 * Crawl Task Detail 媒体区（FE-批5A：自 task-detail.tsx 拆出）。
 * 渲染 result.media JSON 解析出的图片/视频/音频等媒体形态，
 * 含 srcset 变体与 picture/responsive 来源列表。
 */

import { Card, List, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import {
  formatDimensions,
  formatScore,
} from "./task-detail-formatters";
import type {
  CrawlMediaCollection,
  CrawlMediaItem,
  CrawlMediaSource,
  TaskDetailTranslate,
} from "./task-detail-types";

const mediaDocsUrl =
  "https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/link-media.md";

export function MediaSection({ media }: { media: CrawlMediaCollection | null }) {
  const { t } = useTranslation();
  if (!media) {
    return null;
  }
  const entries = Object.entries(media).filter(
    ([, items]) => Array.isArray(items) && items.length > 0,
  );
  if (!entries.length) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.media.title")}
      style={{ marginTop: 12 }}
      extra={
        <Typography.Link href={mediaDocsUrl} target="_blank" rel="noreferrer">
          {t("common.docs")}
        </Typography.Link>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {entries.map(([kind, items]) => {
          const preview = items.slice(0, 4);
          const remaining = Math.max(0, items.length - preview.length);
          return (
            <div key={kind}>
              <Typography.Text strong style={{ textTransform: "capitalize" }}>
                {kind} ({items.length})
              </Typography.Text>
              <List
                size="small"
                split={false}
                style={{ marginTop: 8 }}
                dataSource={preview}
                renderItem={(item, index) => (
                  <List.Item key={`${kind}-${index}-${item.src ?? "media"}`}>
                    <Space align="start">
                      {renderMediaPreview(kind, item, t)}
                      <Space direction="vertical" size={4}>
                        <Typography.Link href={item.src} target="_blank">
                          {item.src ?? t("crawl.detail.media.viewAsset")}
                        </Typography.Link>
                        {item.alt || item.title ? (
                          <Typography.Text strong>
                            {item.alt ?? item.title}
                          </Typography.Text>
                        ) : null}
                        {item.desc ? (
                          <Typography.Paragraph style={{ marginBottom: 4 }}>
                            {item.desc}
                          </Typography.Paragraph>
                        ) : null}
                        <Typography.Text type="secondary">
                          {[
                            item.type,
                            item.format,
                            formatDimensions(item),
                            formatScore(item, t),
                          ]
                            .filter(Boolean)
                            .join(" • ")}
                        </Typography.Text>
                        {item.srcset ? renderSrcset(item.srcset, t) : null}
                        {renderSourceList(
                          t("crawl.detail.media.sourceTypes.picture"),
                          item.pictureSources,
                          t,
                        )}
                        {renderSourceList(
                          t("crawl.detail.media.sourceTypes.responsive"),
                          item.responsiveSources,
                          t,
                        )}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
              {remaining > 0 ? (
                <Typography.Text type="secondary">
                  {t("crawl.detail.media.more", { count: remaining, kind })}
                </Typography.Text>
              ) : null}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

function renderMediaPreview(
  kind: string,
  item: CrawlMediaItem,
  t: TaskDetailTranslate,
) {
  if (!item.src) {
    return null;
  }
  const normalized = kind.toLowerCase();
  if (normalized.includes("image")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.src}
        alt={item.alt || item.title || t("crawl.detail.media.thumbnailAlt")}
        style={{
          width: 96,
          height: 96,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid var(--ant-color-border-secondary)",
        }}
        loading="lazy"
      />
    );
  }
  if (normalized.includes("video")) {
    return (
      <video
        src={item.src}
        poster={item.poster}
        controls
        style={{ width: 160, borderRadius: 8 }}
      />
    );
  }
  if (normalized.includes("audio")) {
    return <audio src={item.src} controls style={{ minWidth: 160 }} />;
  }
  return null;
}

function renderSrcset(
  srcset: string[],
  t: TaskDetailTranslate,
) {
  return (
    <div>
      <Typography.Text type="secondary">
        {t("crawl.detail.media.srcsetVariants")}
      </Typography.Text>
      <pre
        style={{
          background: "var(--ant-color-fill-alter)",
          padding: 8,
          borderRadius: 4,
          maxWidth: 520,
          whiteSpace: "pre-wrap",
        }}
      >
        {srcset.join("\n")}
      </pre>
    </div>
  );
}

function renderSourceList(
  label: string,
  sources: CrawlMediaSource[] | undefined,
  t: TaskDetailTranslate,
) {
  if (!sources || sources.length === 0) {
    return null;
  }
  return (
    <div>
      <Typography.Text type="secondary">
        {t("crawl.detail.media.sources", { label, count: sources.length })}
      </Typography.Text>
      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
        {sources.slice(0, 4).map((source, index) => (
          <li key={`${label}-${index}`}>
            <code>{source.srcset ?? source.src}</code>
            {source.type ? ` • ${source.type}` : ""}
            {source.media ? ` • ${source.media}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
