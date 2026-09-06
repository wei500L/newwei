"use client";

/**
 * Crawl Task Detail 表格区（FE-批5A：自 task-detail.tsx 拆出）。
 * 渲染 result.tables：caption、行列数、元数据、5 行预览与剩余数量；
 * 窄屏走 List 布局，宽屏走 Table。
 */

import { Card, List, Space, Table, Tag, Typography, Grid } from "antd";
import { useTranslation } from "react-i18next";

import {
  buildTableColumns,
  buildTablePreviewRows,
  buildTableRecords,
} from "./task-detail-table-model";
import type { CrawlResultTable } from "./task-detail-types";

const tableDocsUrl =
  "https://github.com/unclecode/crawl4ai/blob/main/docs/blog/release-v0.7.3.md";

export function TablesSection({ tables }: { tables: CrawlResultTable[] | null }) {
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  if (!tables || !tables.length) {
    return null;
  }
  return (
    <Card
      size="small"
      title={t("crawl.detail.tables.title")}
      style={{ marginTop: 12 }}
      extra={
        <Typography.Link href={tableDocsUrl} target="_blank" rel="noreferrer">
          {t("crawl.detail.tables.releaseNotes")}
        </Typography.Link>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {tables.map((table) => {
          const columns = buildTableColumns(table);
          const records = buildTableRecords(table);
          const previewRows = buildTablePreviewRows(table, records);
          const remaining = Math.max(0, table.rowCount - previewRows.length);
          return (
            <div key={table.id}>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Space wrap>
                  <Typography.Text strong>
                    {table.caption ||
                      t("crawl.detail.tables.defaultTitle", { id: table.id })}
                  </Typography.Text>
                  <Tag>
                    {table.rowCount} × {table.columnCount}
                  </Tag>
                  {table.source && (
                    <Typography.Text type="secondary">
                      {t("crawl.detail.tables.source", {
                        source: table.source,
                      })}
                    </Typography.Text>
                  )}
                </Space>
                {table.metadata && (
                  <Typography.Text type="secondary">
                    {JSON.stringify(table.metadata)}
                  </Typography.Text>
                )}
              </Space>
              {!screens.md ? (
                <List
                  dataSource={previewRows}
                  size="small"
                  style={{ marginTop: 8 }}
                  renderItem={(item, i) => (
                    <List.Item>
                      <List.Item.Meta
                        title={`${t("common.row")} ${i + 1}`}
                        description={
                          <Space direction="vertical" size={0}>
                            {columns.slice(0, 3).map((col) => (
                              <div key={col.key}>
                                <Typography.Text
                                  type="secondary"
                                  style={{ fontSize: 12 }}
                                >
                                  {col.title}:
                                </Typography.Text>{" "}
                                <Typography.Text style={{ fontSize: 12 }}>
                                  {String(item[col.dataIndex] ?? "")}
                                </Typography.Text>
                              </div>
                            ))}
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
              ) : (
                <Table
                  columns={columns}
                  dataSource={previewRows}
                  size="small"
                  pagination={false}
                  style={{ marginTop: 8 }}
                  scroll={{ x: true }}
                />
              )}
              {remaining > 0 && (
                <Typography.Text type="secondary">
                  {t("crawl.detail.tables.remaining", {
                    preview: previewRows.length,
                    remaining,
                  })}
                </Typography.Text>
              )}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}
