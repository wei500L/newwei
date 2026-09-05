/**
 * Crawl Task Detail 表格模型（FE-批5A：自 task-detail.tsx 拆出）。
 * 纯函数模块：无 React、无 "use client"；dataFrame 行优先，否则按
 * headers×rows 重建记录，预览固定 5 行。
 */

import type {
  CrawlResultTable,
  CrawlResultTablePreviewRow,
  CrawlResultTableRecord,
} from "./task-detail-types";

const TABLE_PREVIEW_ROW_COUNT = 5;

export function buildTableRecords(table: CrawlResultTable): CrawlResultTableRecord[] {
  if (table.dataFrame?.rows?.length) {
    return table.dataFrame.rows;
  }
  return table.rows.map((row) =>
    table.headers.reduce<CrawlResultTableRecord>((acc, header, index) => {
      acc[header] = row[index] ?? null;
      return acc;
    }, {}),
  );
}

export function buildTableColumns(table: CrawlResultTable) {
  return (table.dataFrame?.columns ?? table.headers).map((header) => ({
    title: header,
    dataIndex: header,
    key: header,
    ellipsis: true,
  }));
}

export function buildTablePreviewRows(
  table: CrawlResultTable,
  records: CrawlResultTableRecord[],
): CrawlResultTablePreviewRow[] {
  return records
    .slice(0, TABLE_PREVIEW_ROW_COUNT)
    .map((record, index) => ({
      key: `${table.id}-${index}`,
      ...record,
    }));
}
