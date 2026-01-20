# 时间字段字典（Time Field Dictionary）

本项目同时存在“内容语义时间”（发布时间等）与“系统语义时间”（入库/抓取/处理等）。为避免指标口径漂移、排序错乱与 UI 静默替换，统一约定如下。

## 总规则

1. **内容相关的排序/聚类/聚合/时间窗口**：默认使用 `sortAt`（Published 优先策略）。
2. **内容发布时间展示**：使用 `publishedAt`（可能为空，需显示 `N/A`）。
3. **系统入库/抓取时间展示**：使用 `ingestedAt` / `crawlAt`（通常不为空）。
4. **禁止静默替换**：UI 不允许把 `createdAt` 当作 `publishedAt` 的无标注 fallback；需要同时展示两者或明确标注。

## 字段语义速查

| 字段名 | 语义类型 | 含义 | 推荐用途 |
| --- | --- | --- | --- |
| `publishedAt` | 内容语义 | 内容发布时间（文章/内容本身的时间） | 内容时间线、内容窗口、内容指标、内容排序（优先） |
| `ingestedAt` | 系统语义 | 入库时间（进入系统/被抓取/被写入的时间） | 系统延迟分析、回溯排查、与 `publishedAt` 对照展示 |
| `sortAt` | 派生时间 | Published 优先的统一时间戳：`publishedAt ?? ingestedAt ?? createdAt` | 默认排序键、聚类/聚合窗口、时间范围筛选 |
| `createdAt` | 系统语义 | 记录创建时间（不同模型含义不同：可能是入库、也可能是处理结果生成） | 仅用于该记录自身的生命周期；不要当成 `publishedAt` |
| `processedAt` | 系统语义 | 处理完成/生成结果的时间 | 处理链路性能、延迟、稳定性指标 |
| `crawlAt` | 系统语义 | 抓取/采集时间（Article 级别） | 采集窗口、采集延迟、与 `publishedAt` 对照展示 |
| `triggeredAt` | 系统语义 | 告警触发时间 | 告警时间线/审计 |

## 主要模型约定

### Prisma：`ItemMeta`（MySQL）

- `publishedAt`: 内容发布时间（可空）
- `createdAt`: 入库时间（该条 ItemMeta 记录被创建的时间）
- `sortAt`: 默认排序时间（`publishedAt` 有值则取 `publishedAt`，否则回退到入库时间）

推荐：
- Items 列表的默认时间排序/过滤窗口使用 `sortAt`。
- UI 同时展示：
  - Published: `publishedAt`（无则 `N/A`）
  - Ingested: `createdAt`（或 GraphQL 的 `ingestedAt`）

### Mongo：`ProcessedItem`

- `result.published_at`: LLM/解析阶段抽取到的发布时间（字符串，可能格式不统一）
- `ingestedAt`: 入库时间（可空；应尽量在写入时填充）
- `sortAt`: Published 优先策略的排序时间（应尽量在写入时填充）
- `createdAt`: ProcessedItem 文档创建时间（通常更接近“处理结果生成时间”）

推荐：
- 内容相关窗口/聚合优先用 `sortAt`（Published 优先），不要用 `createdAt`。
- UI 展示应同时给出 `publishedAt` 与 `ingestedAt`（或无法取到时明确标注）。

### Prisma：`Article` / `ProcessedArticle`

- `Article.crawlAt`: 抓取/采集时间（系统语义，通常不为空）
- `ProcessedArticle.publishedAt`: 内容发布时间（内容语义，可空）
- `ProcessedArticle.processedAt`: 处理完成时间（系统语义）

推荐：
- 内容相关窗口优先使用 `ProcessedArticle.publishedAt`，为空时回退到 `Article.crawlAt`。
- UI 同时展示 Published + Ingested（crawlAt）。

## 前端展示规范（UI）

- 任何出现 `publishedAt ?? createdAt`、`publishedAt || createdAt`、`publishedAt ?? crawlAt` 的地方：
  - 必须改为同时展示两个时间（并加标签），或在同一块 UI 中明确标注当前显示的是哪一种时间。
- 推荐文案统一：
  - `items.time.published`: Published
  - `items.time.ingested`: Ingested

