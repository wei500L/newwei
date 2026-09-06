"use client";

/**
 * Crawl Task Detail Multi URL 卡片（FE-批5A：自 task-detail.tsx 拆出）。
 * multiUrlConfigs 策略列表：名称/匹配模式/URL 列表/覆盖项摘要。
 */

import { Card, List, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import {
  buildMultiUrlConfigs,
  formatMultiUrlOverrides,
} from "./task-detail-multi-url-model";

export function TaskDetailMultiUrl({ config }: { config: CrawlTaskConfig }) {
  const { t } = useTranslation();
  const multiConfigs = buildMultiUrlConfigs(config);
  if (!multiConfigs.length) {
    return null;
  }
  return (
    <Card title={t("crawl.multiUrl.title")} style={{ marginTop: 24 }}>
      <List
        dataSource={multiConfigs}
        renderItem={(item, index) => {
          const matcher = item?.matcher;
          const urls = Array.isArray(item?.urls) ? item.urls : [];
          const options = item?.options ?? {};
          const overridesSummary = formatMultiUrlOverrides(options, t);
          return (
            <List.Item key={item?.name ?? `strategy-${index}`}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text strong>
                  {item?.name ??
                    t("crawl.multiUrl.strategyTitle", { index: index + 1 })}
                </Typography.Text>
                {matcher?.patterns?.length ? (
                  <Typography.Text type="secondary">
                    {t("crawl.detail.multiUrl.patterns", {
                      mode: matcher.matchMode ?? "glob",
                      patterns: matcher.patterns.join(", "),
                    })}
                  </Typography.Text>
                ) : null}
                {urls.length ? (
                  <Space wrap>
                    {urls.map((url) => (
                      <Typography.Link
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {url}
                      </Typography.Link>
                    ))}
                  </Space>
                ) : null}
                {Object.keys(options).length && overridesSummary ? (
                  <Typography.Text>
                    {t("crawl.detail.multiUrl.overrides", {
                      overrides: overridesSummary,
                    })}
                  </Typography.Text>
                ) : null}
              </Space>
            </List.Item>
          );
        }}
      />
    </Card>
  );
}
