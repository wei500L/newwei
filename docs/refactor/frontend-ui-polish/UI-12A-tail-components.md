# FE-UI 批12A：`components/**` 收尾

> **一句话目标**：按 README **§3.6 收尾换算表**，把本批目录里剩下的「装饰色 Tag」「颜色映射函数」「裸 `<Empty>`」「内联 `style={{ margin… }}`」机械地收尾。这是纯执行批：**规则全部在 §3.6，查表照做，不要自己发挥**。
>
> **本批规模**（快照）：Tag 字面量预设色 **97** 处、颜色映射里的预设色 **160** 处、裸 Empty **13** 处、内联 margin **224** 处。
>
> **依赖**：UI-11 已合入（UI-11 改过本批部分文件的时间格式，先 `git pull`）。可与另外两个 UI-12 批次并行，目录互不相交。本批**只改** `apps/web/components/**`。
>
> **开工前必读**：README §3.5、**§3.6**、§4、§5、§7。

---

## 执行顺序

按目录推进：`components/settings/**` 先做（量最大），然后 `components/analysis/**`，最后 `components/` 根目录下的文件。**每个文件按下面 4 步做完再换下一个文件**：

1. **Tag 字面量**：`grep -nE 'color="(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' <文件>`，逐个看 Tag 里的文字，按 §3.6-A 换成状态色或删掉 color。
2. **颜色映射**：`grep -nE '(:|\?|return)\s*"(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' <文件>`，找到所属函数 / 常量，**先 grep 它的使用处**，确认只喂给 Tag / Badge 后再按 §3.6-A 改返回值。
3. **裸 Empty**：按 §3.6-C 处理。`ChartEmptyState` 从 `@/components/chart-empty-state` 导入；`Empty` 不再使用就从 antd import 里删掉。
4. **内联 margin**：`grep -nE 'style=\{\{[^}]*margin' <文件>`，按 §3.6-B 换算或删除。

## 分次提交

- 每完成**一个子目录**（或累计约 15 个文件）提交一次，commit message 用：
  - `🎨 style(web): FE-UI 批12A <子目录> Tag 状态色收敛、空态与间距写法统一`
- **总上限**：本窗口最多处理 250 处 margin。超出就停下，在报告里写明停在哪个文件，剩下的留给下一个窗口（下一个窗口从报告列出的位置继续）。

## 文件清单（快照，按总数降序）

路径相对 `apps/web/`；所有 grep 命令都在 `apps/web/` 下执行。数量是快照，行号会漂移，以 grep 结果为准。

| 文件 | Tag 字面量 | 颜色映射 | 裸 Empty | 内联 margin |
|---|---|---|---|---|
| `components/settings/news-event-source-policy-settings-panel.tsx` | 2 | 16 | 1 | 20 |
| `components/settings/assistant-safety-settings-panel.tsx` | 23 | 1 |  | 15 |
| `components/settings/situation-monitor-settings-panel.tsx` |  | 18 |  | 8 |
| `components/settings/llm-gateway-settings-panel.tsx` | 7 | 9 |  | 8 |
| `components/settings/llm-gateway/llm-gateway-embedding-rerank-panel.tsx` | 12 | 6 |  | 2 |
| `components/settings/news-source-runtime-secrets-panel.tsx` | 10 | 1 | 1 | 7 |
| `components/settings/llm-gateway/llm-gateway-test-result.tsx` | 9 |  |  | 10 |
| `components/settings/geo-nominatim-settings-panel.tsx` | 5 | 1 |  | 10 |
| `components/settings/news-dedupe-settings-panel.tsx` | 1 |  | 1 | 14 |
| `components/settings/llm-gateway/llm-gateway-proxy-governance-panel.tsx` |  | 10 |  | 6 |
| `components/settings/newsnow-personalization-settings-panel.tsx` | 2 |  |  | 13 |
| `components/settings/access-settings-content.tsx` | 2 |  | 5 | 7 |
| `components/settings/realtime-signals/realtime-signals-overview.tsx` |  | 13 |  | 1 |
| `components/settings/knowledge-graph-review-panel.tsx` | 1 | 3 | 1 | 8 |
| `components/settings/email-settings-panel.tsx` |  | 2 |  | 9 |
| `components/settings/system-security-settings-panel.tsx` | 3 | 1 |  | 6 |
| `components/settings/realtime-signals/realtime-signals-runtime-model.ts` |  | 10 |  |  |
| `components/settings/llm-gateway/llm-gateway-governance.view.ts` |  | 10 |  |  |
| `components/settings/llm-gateway/llm-gateway-profiles-panel.tsx` | 5 | 5 |  |  |
| `components/settings/akshare-gateway-settings-panel.tsx` |  | 9 |  |  |
| `components/settings/news-source-scheduler-settings-panel.tsx` |  | 3 |  | 5 |
| `components/settings/model-service-settings-panel.tsx` | 1 | 3 |  | 4 |
| `components/settings/vector-service-settings-panel.tsx` | 1 | 7 |  |  |
| `components/settings/llm-gateway/llm-gateway-proxy-lb-panel.tsx` | 3 |  |  | 5 |
| `components/settings/task-log-settings-panel.tsx` |  | 1 |  | 6 |
| `components/settings/realtime-signals/realtime-signals-source-card.tsx` | 4 | 3 |  |  |
| `components/settings/archive-preparation-settings-panel.tsx` |  | 4 |  | 2 |
| `components/settings/rate-limit-policies-panel.tsx` |  | 4 |  | 2 |
| `components/settings/news-events-settings-panel.tsx` |  | 2 |  | 4 |
| `components/analysis/annotation-panel.tsx` |  |  | 2 | 4 |
| `components/settings/llm-request-logs-panel.tsx` | 2 | 2 |  | 1 |
| `components/settings/multi-tenant-scheduler-settings-panel.tsx` |  | 1 |  | 4 |
| `components/settings/knowledge-graph-settings-panel.tsx` |  |  |  | 5 |
| `components/settings/llm-gateway/llm-gateway-proxy-lb-test-result.tsx` | 1 | 3 |  | 1 |
| `components/settings/storage-settings-content.tsx` |  |  |  | 4 |
| `components/settings/rss-diagnostics-panel.tsx` | 1 | 3 |  |  |
| `components/settings/news-indicator-settings-panel.tsx` |  |  |  | 4 |
| `components/settings/realtime-signals-settings-panel.tsx` |  |  |  | 3 |
| `components/settings/rss-translation-metrics-panel.tsx` |  | 2 |  | 1 |
| `components/settings/entity-impact-graph-settings-panel.tsx` |  |  |  | 3 |
| `components/settings/news-classification-settings-panel.tsx` |  |  |  | 3 |
| `components/settings/realtime-signals/realtime-signals-credentials-section.tsx` |  |  |  | 3 |
| `components/settings/llm-gateway/llm-gateway-profile-modals.tsx` |  |  |  | 3 |
| `components/settings/llm-gateway/llm-gateway-models-modals.tsx` |  | 1 |  | 2 |
| `components/analysis/analysis-toolbar.tsx` |  | 1 |  | 2 |
| `components/chart-data-meta.tsx` | 2 |  |  |  |
| `components/settings/rate-limit-settings-panel.tsx` |  |  |  | 2 |
| `components/settings/applications-panel.tsx` |  |  | 2 |  |
| `components/settings/crawl-client-settings-panel.tsx` |  |  |  | 2 |
| `components/settings/realtime-signals/realtime-signals-runtime-panel.tsx` |  | 2 |  |  |
| `components/settings/llm-gateway/llm-gateway.formatters.ts` |  | 2 |  |  |
| `components/time-range-controls.tsx` |  | 1 |  |  |
| `components/settings/form-field-feedback.tsx` |  |  |  | 1 |
| `components/settings/audit-log-retention-panel.tsx` |  |  |  | 1 |
| `components/settings/auth-cache-settings-panel.tsx` |  |  |  | 1 |
| `components/settings/realtime-signals/realtime-signals-general-section.tsx` |  |  |  | 1 |
| `components/settings/realtime-signals/realtime-signals-endpoints-section.tsx` |  |  |  | 1 |

---

## 禁止事项

- README §4；只改本批目录。
- 不动 `components/data-state-boundary.tsx`、`chart-empty-state.tsx`、`page-header.tsx`、`section-header.tsx`、`filter-bar.tsx`、`time-range-controls.tsx` 这些原语的 API 和实现。
- 不改 Tag 的文字、`key`、`onClick`、`closable` 等其它属性；只改 `color`（或整体换成 span）。
- 不因为「顺手」去拆组件、改布局结构；本批只做 §3.6 的四件事。

## 自查（每个子目录做完跑一次）

```bash
D="<子目录>"
grep -rnE 'color="(blue|geekblue|purple|cyan|magenta|volcano|lime|gold|orange|green|red|pink)"' "$D"   # 期望 0
grep -rnE '<Empty\b' "$D" --include='*.tsx' | grep -v emptyText | grep -v notFoundContent             # 期望 0
grep -rnE 'style=\{\{[^}]*margin' "$D" --include='*.tsx'                                              # 只剩 §3.6-B 允许保留的
```

映射函数没改的（因为同时喂给图表 / 地图 / style），在报告中逐个列出：`文件:行 函数名 —— 另外用于哪里`。

## 测试

- 已有测试必须通过。断言了 Tag `color` 或 `ant-tag-<color>` 类名的测试，按新的状态色更新（例如 `ant-tag-green` → `ant-tag-success`）。
- 断言了「暂无数据」文案的测试：ChartEmptyState 显示的仍是同一个 description，`getByText` 不受影响。
- 不新增测试。

## 人工冒烟清单

| 页面 | 亮/暗 | 1280 | 看什么 |
|---|---|---|---|
| `/admin/settings/ai`、`/admin/settings/monitoring`、`/admin/settings/news` | 亮 + 暗 | ✓ | Tag 只剩绿 / 红 / 琥珀 / 蓝四种状态色，信息类 Tag 是中性灰；段落间距均匀 |
| `/admin/settings/access` | 亮 | ✓ | 空列表显示统一空态 |
| `/assistant`、`/analysis` | 亮 | ✓ | 标注面板、工具栏间距正常 |
