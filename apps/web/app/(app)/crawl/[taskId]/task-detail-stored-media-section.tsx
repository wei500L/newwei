"use client";

/**
 * Crawl Task Detail 已存储媒体区（FE-批5A：自 task-detail.tsx 拆出）。
 * 渲染 result.mediaAssets JSON 解析出的存储资产：预览/下载/来源链接、
 * 字节数与缺失访问链接提示。
 */

import { WarningOutlined } from "@ant-design/icons";
import { Card, List, Space, Typography } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

import { formatBytes, resolveStoredMediaUrl } from "./task-detail-formatters";
import type { CrawlStoredMediaAsset } from "./task-detail-types";

export function StoredMediaSection({
  assets,
}: {
  assets: CrawlStoredMediaAsset[] | null;
}) {
  const { t } = useTranslation();
  if (!assets || assets.length === 0) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.media.storedTitle")}
      style={{ marginTop: 12 }}
    >
      <List
        size="small"
        split={false}
        dataSource={assets}
        renderItem={(asset) => {
          const sourceHref = /^https?:\/\//i.test(asset.sourceUrl)
            ? asset.sourceUrl
            : undefined;
          const previewHref = resolveStoredMediaUrl(asset.previewUrl);
          const downloadHref = resolveStoredMediaUrl(
            asset.downloadUrl ?? asset.previewUrl,
          );
          const missingStoredAccess = !previewHref && !downloadHref;
          return (
            <List.Item key={`${asset.id}-${asset.sourceUrl}`}>
              <Space align="start">
                <StoredMediaPreview asset={asset} previewUrl={previewHref} />
                <Space direction="vertical" size={4}>
                  <Typography.Text strong>
                    {asset.title ?? asset.alt ?? asset.kind}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {(
                      asset.contentType ?? t("crawl.detail.media.unknownMime")
                    ).toUpperCase()}{" "}
                    • {formatBytes(asset.bytes)}
                  </Typography.Text>
                  <Typography.Paragraph style={{ marginBottom: 4 }}>
                    {asset.desc ?? asset.sourceUrl}
                  </Typography.Paragraph>
                  {missingStoredAccess ? (
                    <Typography.Text type="danger">
                      {t("crawl.detail.media.assetUnavailable")}
                    </Typography.Text>
                  ) : null}
                  <Space size="small">
                    {sourceHref ? (
                      <Typography.Link
                        href={sourceHref}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("common.source")}
                      </Typography.Link>
                    ) : null}
                    {downloadHref ? (
                      <Typography.Link
                        href={downloadHref}
                        download={`${asset.kind}-${asset.id}`}
                        rel="noreferrer"
                      >
                        {t("common.download")}
                      </Typography.Link>
                    ) : null}
                  </Space>
                </Space>
              </Space>
            </List.Item>
          );
        }}
      />
    </Card>
  );
}

function StoredMediaPreview({
  asset,
  previewUrl,
}: {
  asset: CrawlStoredMediaAsset;
  previewUrl?: string;
}) {
  const { t } = useTranslation();
  const [previewFailed, setPreviewFailed] = useState(false);
  if (previewUrl && !previewFailed && asset.contentType?.startsWith("image/")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={previewUrl}
        alt={asset.alt ?? asset.title ?? asset.kind}
        style={{
          width: 96,
          height: 96,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid var(--ant-color-border-secondary)",
        }}
        loading="lazy"
        onError={() => {
          setPreviewFailed(true);
          captureClientError("Failed to load stored crawl image preview", {
            assetId: asset.id,
            sourceUrl: asset.sourceUrl,
            storageProvider: asset.storageProvider,
          });
        }}
      />
    );
  }
  if (previewUrl && !previewFailed && asset.contentType?.startsWith("video/")) {
    return (
      <video
        src={previewUrl}
        controls
        style={{ width: 160, borderRadius: 8 }}
        preload="metadata"
        onError={() => {
          setPreviewFailed(true);
          captureClientError("Failed to load stored crawl video preview", {
            assetId: asset.id,
            sourceUrl: asset.sourceUrl,
            storageProvider: asset.storageProvider,
          });
        }}
      />
    );
  }
  return (
    <Space direction="vertical" size={4} align="center">
      <div className="media-thumb" style={{ width: 80, height: 80 }}>
        {asset.kind.slice(0, 2).toUpperCase()}
      </div>
      {previewFailed ? (
        <Space size={4} align="center">
          <WarningOutlined style={{ color: "var(--ant-color-error)" }} />
          <Typography.Text type="danger">
            {t("crawl.detail.media.previewLoadFailed")}
          </Typography.Text>
        </Space>
      ) : (
        <Typography.Text type="secondary">
          {t("crawl.detail.media.previewUnavailable")}
        </Typography.Text>
      )}
    </Space>
  );
}
