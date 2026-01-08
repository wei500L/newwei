# 时间字段字典（Published vs Ingested）

## 统一定义
- **Published（内容发布时间）**
  - 数据源：`ProcessedItem.result.published_at`
  - 语义：内容/新闻在来源站点的发布时间（可能为空）。
  - 格式：ISO8601（UTC，示例：`2024-01-01T00:00:00.000Z`）。
- **Ingested（入库时间）**
  - 数据源：`ItemMeta.createdAt`（SQL 侧 item 记录创建时间）。
  - 语义：系统将该条内容纳入处理/入库的时间（用于“入库”口径的稳定排序/分页）。

## API / GraphQL 字段映射
- `ItemModel.publishedAt`：Published（ISO8601 字符串）；优先来自 `ProcessedItem.result.published_at`，缺失时回退到 Raw payload 的 `publishedAt/published_at`。
- `ItemModel.ingestedAt`：Ingested（`GraphQLISODateTime`），当前与 `ItemModel.createdAt` 等价（显式别名，避免前端靠推断）。
- `ProcessedItemModelGraph.createdAt`：Mongo processed 记录创建时间（**处理记录时间**，不等同于 Published）。

## 页面/排序口径（当前）
- Items 列表（`apps/web/app/(app)/items/items-view.tsx`）
  - 展示：同时展示 `Published` 与 `Ingested`（Published 缺失时显示 N/A）。
  - 排序：默认依赖服务端（当前为 `ItemMeta.createdAt desc`）；`sortMode=publishedDesc` 场景仅做临时展示用排序（后续由 DV.T14 统一到服务端稳定排序）。
- Item 详情（`apps/web/app/(app)/items/[id]/item-detail.tsx`）
  - 展示：同时展示 `Published` 与 `Ingested`（Published 缺失时显示 N/A）。

