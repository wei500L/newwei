"use client";

/**
 * Crawl Task Detail 链接总览卡片（FE-批5A：自 task-detail.tsx 拆出）。
 * 跨结果聚合统计、buckets、top links（分数降序）与低质量链接。
 */

import { Card, List, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { buildLinkOverview, getLinkScore } from "./task-detail-link-model";
import type { CrawlTaskDetailResult } from "./task-detail-types";

export function TaskDetailLinkOverview({
  results,
}: {
  results: readonly CrawlTaskDetailResult[];
}) {
  const { t } = useTranslation();
  const linkOverview = buildLinkOverview(results);
  if (!linkOverview) {
    return null;
  }
  return (
    <Card title={t("crawl.links.title")} style={{ marginTop: 24 }}>
      <Space size="large" wrap>
        {[
          {
            label: t("crawl.links.stats.total"),
            value: linkOverview.stats.totalLinks,
          },
          {
            label: t("crawl.links.stats.internal"),
            value: linkOverview.stats.internalLinks,
          },
          {
            label: t("crawl.links.stats.external"),
            value: linkOverview.stats.externalLinks,
          },
          {
            label: t("crawl.links.stats.highQuality"),
            value: linkOverview.stats.highQualityLinks,
          },
          {
            label: t("crawl.links.stats.needsReview"),
            value: linkOverview.stats.lowQualityLinks,
          },
          {
            label: t("crawl.links.stats.avgIntrinsic"),
            value:
              linkOverview.stats.averageIntrinsic !== null &&
              linkOverview.stats.averageIntrinsic !== undefined
                ? linkOverview.stats.averageIntrinsic.toFixed(2)
                : t("common.emptyValue"),
          },
        ].map((item) => (
          <Space key={item.label} direction="vertical" size={0}>
            <Typography.Text type="secondary">{item.label}</Typography.Text>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {item.value}
            </Typography.Title>
          </Space>
        ))}
      </Space>
      {linkOverview.buckets.length ? (
        <>
          <Typography.Text
            strong
            style={{ display: "block", marginTop: 16 }}
          >
            {t("crawl.links.buckets")}
          </Typography.Text>
          <Space wrap>
            {linkOverview.buckets.map((bucket) => (
              <Tag key={bucket.kind}>
                {t("crawl.links.bucketItem", {
                  kind: bucket.kind,
                  count: bucket.count,
                })}
              </Tag>
            ))}
          </Space>
        </>
      ) : null}
      <Space align="start" size="large" style={{ marginTop: 16 }} wrap>
        <div style={{ minWidth: 280 }}>
          <Typography.Text strong>
            {t("crawl.links.topLinks")}
          </Typography.Text>
          <List
            size="small"
            dataSource={linkOverview.topLinks}
            locale={{ emptyText: t("crawl.links.emptyScored") }}
            renderItem={(link) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <Typography.Link href={link.href} target="_blank">
                    {link.text || link.href}
                  </Typography.Link>
                  <Typography.Text type="secondary">
                    {t("crawl.links.linkScore", {
                      domain: (link.baseDomain ?? "link").toString(),
                      score: getLinkScore(link).toFixed(2),
                    })}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </div>
        <div style={{ minWidth: 280 }}>
          <Typography.Text strong>
            {t("crawl.links.lowQuality")}
          </Typography.Text>
          <List
            size="small"
            dataSource={linkOverview.lowLinks}
            locale={{ emptyText: t("crawl.links.emptyLowQuality") }}
            renderItem={(link) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <Typography.Link href={link.href} target="_blank">
                    {link.text || link.href}
                  </Typography.Link>
                  <Typography.Text type="secondary">
                    {t("crawl.links.intrinsicScore", {
                      domain: (link.baseDomain ?? "link").toString(),
                      score: (link.intrinsicScore ?? 0).toFixed(2),
                    })}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </div>
      </Space>
    </Card>
  );
}
