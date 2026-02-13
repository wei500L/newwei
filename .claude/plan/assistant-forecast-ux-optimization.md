# 📋 实施计划：AI 助手预测功能经济序列展示优化

## 任务概述
优化 AI 助手预测功能中经济序列的展示方式，解决"slug 或名称"术语对用户不友好的问题，同时保留优秀的数值计算逻辑。

## 任务类型
- [x] 前端 (→ Gemini)
- [ ] 后端 (→ Codex)
- [ ] 全栈 (→ 并行)

---

## 多模型分析结论

### Gemini（前端视角）推荐
**方案 B（增强型搜索补全）+ 方案 A（文案优化）**
- 将 Input 替换为 Select(showSearch) 或 AutoComplete
- 调用现有数据源提供搜索补全
- 优化文案去除"slug"术语

### Codex（后端视角）推荐
**"A + C 分阶段"**
- Phase 1（快赢）：文案+引导优化，立即降低术语门槛
- Phase 2（主改）：专用建议 API + 自动补全

### 综合决策
采用 **分阶段实施方案**，优先实现 Phase 1（文案优化），作为快速改进；Phase 2（搜索补全）作为后续增强。

---

## 技术方案

### Phase 1：文案与引导优化（快速修复）

#### 1.1 国际化文案修改

**文件**: `apps/web/lib/locales/en.json`
```json
// 修改前
"series": "Economic series (slug or name)"
"seriesPlaceholder": "e.g. usd_index_history or economic:usd_index_history:latest"

// 修改后
"series": "Economic indicator",
"seriesPlaceholder": "Search or enter indicator name, e.g. USD Index, GDP...",
"seriesHelp": "You can enter the indicator name (e.g. 'USD Index') or its identifier (e.g. 'usd_index_history'). Advanced formats like 'economic:slug:latest' are also supported."
```

**文件**: `apps/web/lib/locales/zh.json`
```json
// 修改前
"series": "经济序列（slug 或名称）"
"seriesPlaceholder": "例如：usd_index_history 或 economic:usd_index_history:latest"

// 修改后
"series": "经济指标",
"seriesPlaceholder": "搜索或输入指标名称，如：美元指数、GDP...",
"seriesHelp": "您可以输入指标名称（如'美元指数'）或其标识符（如'usd_index_history'）。也支持'economic:slug:latest'等高级格式。"
```

#### 1.2 表单组件优化

**文件**: `apps/web/app/(app)/assistant/assistant-content.tsx` L800-810

```tsx
// 修改前
<Form.Item
  name="series"
  label={t("assistant.forecast.series", { defaultValue: "Economic series (slug or name)" })}
  rules={[{ required: true }]}
>
  <Input
    placeholder={t("assistant.forecast.seriesPlaceholder", {
      defaultValue: "e.g. usd_index_history or economic:usd_index_history:latest",
    })}
  />
</Form.Item>

// 修改后
<Form.Item
  name="series"
  label={t("assistant.forecast.series", { defaultValue: "Economic indicator" })}
  rules={[{ required: true }]}
  extra={
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {t("assistant.forecast.seriesHelp", {
        defaultValue: "Enter indicator name or identifier. Advanced formats like 'economic:slug:latest' are also supported."
      })}
    </Typography.Text>
  }
>
  <Input
    placeholder={t("assistant.forecast.seriesPlaceholder", {
      defaultValue: "Search or enter indicator name, e.g. USD Index, GDP...",
    })}
  />
</Form.Item>
```

#### 1.3 结果展示页优化

**文件**: `apps/web/app/(app)/assistant/assistant-content.tsx` L395-405

```tsx
// 修改前
<Descriptions.Item label={t("assistant.preview.series", { defaultValue: "Series" })}>
  {displayName || slug ? (
    <Space direction="vertical" size={0}>
      <Typography.Text strong>{displayName ?? slug}</Typography.Text>
      {slug ? <Typography.Text type="secondary">slug: {slug}</Typography.Text> : null}
      {field ? <Typography.Text type="secondary">field: {field}</Typography.Text> : null}
    </Space>
  ) : (
    "-"
  )}
</Descriptions.Item>

// 修改后
<Descriptions.Item label={t("assistant.preview.series", { defaultValue: "Indicator" })}>
  {displayName || slug ? (
    <Space direction="vertical" size={0}>
      <Typography.Text strong>{displayName ?? slug}</Typography.Text>
      {slug ? <Typography.Text type="secondary" copyable>{slug}</Typography.Text> : null}
      {field ? (
        <Typography.Text type="secondary">
          {t("assistant.preview.field", { defaultValue: "Field" })}: {field}
        </Typography.Text>
      ) : null}
    </Space>
  ) : (
    "-"
  )}
</Descriptions.Item>
```

---

### Phase 2：搜索补全功能（增强体验）

#### 2.1 GraphQL Query 新增（可选，若需要专用 API）

**文件**: `apps/api/src/graphql/resolvers/assistant.resolver.ts`

新增 Query:
```typescript
@Query(() => [EconomicSeriesSuggestion])
@UseGuards(GqlAuthGuard)
async assistantEconomicSeriesSuggestions(
  @CurrentUser() user: User,
  @Args('term') term: string,
  @Args('limit', { nullable: true }) limit?: number
): Promise<EconomicSeriesSuggestion[]> {
  // 复用现有 searchEconomicSeriesCandidates 逻辑
  // 返回 { slug, displayName, description? }
}
```

#### 2.2 前端 AutoComplete 组件

**文件**: `apps/web/app/(app)/assistant/assistant-content.tsx`

```tsx
// 新增 import
import { AutoComplete } from 'antd';
import { useLazyQuery } from '@apollo/client';

// 新增 GraphQL query
const SEARCH_ECONOMIC_SERIES = gql`
  query SearchEconomicSeries($term: String!, $limit: Int) {
    assistantEconomicSeriesSuggestions(term: $term, limit: $limit) {
      slug
      displayName
      description
    }
  }
`;

// 组件内使用
const [searchSeries, { data: searchData }] = useLazyQuery(SEARCH_ECONOMIC_SERIES);

const seriesOptions = useMemo(() => {
  return searchData?.assistantEconomicSeriesSuggestions.map(item => ({
    value: item.slug,
    label: (
      <Space direction="vertical" size={0}>
        <Typography.Text strong>{item.displayName}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.slug}</Typography.Text>
      </Space>
    ),
  })) ?? [];
}, [searchData]);

// 替换 Input 为 AutoComplete
<Form.Item name="series" ...>
  <AutoComplete
    options={seriesOptions}
    onSearch={(value) => {
      if (value.length >= 2) {
        debouncedSearch({ variables: { term: value, limit: 8 } });
      }
    }}
    placeholder={t("assistant.forecast.seriesPlaceholder", ...)}
  >
    <Input />
  </AutoComplete>
</Form.Item>
```

---

## 实施步骤

### Phase 1（推荐先实施）

| 步骤 | 操作 | 文件 | 预期产物 |
|------|------|------|----------|
| 1 | 修改英文国际化 | `apps/web/lib/locales/en.json` | 更新 series, seriesPlaceholder, 新增 seriesHelp |
| 2 | 修改中文国际化 | `apps/web/lib/locales/zh.json` | 更新 series, seriesPlaceholder, 新增 seriesHelp |
| 3 | 优化表单组件 | `apps/web/app/(app)/assistant/assistant-content.tsx:800-810` | 添加 extra 帮助文本 |
| 4 | 优化结果展示 | `apps/web/app/(app)/assistant/assistant-content.tsx:395-405` | 调整展示文案和布局 |
| 5 | 验证 | 运行应用 | 界面文案友好，无技术术语 |

### Phase 2（后续迭代）

| 步骤 | 操作 | 文件 | 预期产物 |
|------|------|------|----------|
| 1 | 新增 GraphQL Query（可选） | `apps/api/src/graphql/resolvers/assistant.resolver.ts` | assistantEconomicSeriesSuggestions |
| 2 | 新增前端查询 | `apps/web/app/(app)/assistant/assistant-content.tsx` | SEARCH_ECONOMIC_SERIES query |
| 3 | 替换 Input 为 AutoComplete | `apps/web/app/(app)/assistant/assistant-content.tsx` | 可搜索下拉组件 |
| 4 | 添加防抖处理 | 同上 | 300ms debounce |
| 5 | 验证 | 运行应用 | 输入时有搜索建议 |

---

## 关键文件变更汇总

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/web/lib/locales/en.json` | 修改 | 更新文案，新增 help 文本 |
| `apps/web/lib/locales/zh.json` | 修改 | 更新文案，新增 help 文本 |
| `apps/web/app/(app)/assistant/assistant-content.tsx` | 修改 | 表单和结果展示优化 |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 用户习惯已有界面 | Phase 1 仅改文案，交互不变；监控用户反馈 |
| 搜索 API 性能问题 | Phase 2 添加 debounce、缓存、限流 |
| 国际化遗漏 | 检查所有 i18n key，确保 en/zh 同步更新 |

---

## 验收标准

1. **文案标准**：
   - [ ] 界面不再出现 "slug" 术语
   - [ ] placeholder 使用自然语言示例（如"美元指数"）
   - [ ] 有帮助文本解释高级用法

2. **功能标准**：
   - [ ] 预测功能正常工作
   - [ ] 数值计算逻辑未改变
   - [ ] 结果展示清晰（指标名称为主，slug 为辅）

3. **用户体验标准**（Phase 2）：
   - [ ] 输入时有搜索建议
   - [ ] 选中后正确提交
   - [ ] 响应时间 < 300ms

---

## SESSION_ID（供 /ccg:execute 使用）

- CODEX_SESSION: 019c566e-963d-7e21-809d-00dea9ef9f3a
- GEMINI_SESSION: 58976a4d-5b5c-4e7c-bb81-a0077b2c0151
