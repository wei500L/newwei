# 📋 实施计划：Dashboard AI分析表单UX优化

## 任务概述
优化 Dashboard 右侧 AI 分析面板中的异常分析和相关性分析表单，解决用户需要手动输入JSON的问题，提升表单易用性。

**目标文件**: `apps/web/app/(app)/dashboard/analysis-panel.tsx`

---

## 技术方案

### 核心变更
1. **布局优化**: `layout="inline"` → `layout="vertical"` 适配400px侧边栏
2. **日期输入**: `Input` → `DatePicker.RangePicker` / `DatePicker showTime`
3. **列表输入**: 逗号分隔 `Input` → `Select mode="tags"`
4. **时序数据**: JSON文本 `TextArea` → `Form.List` 动态行

### 数据流设计
```
Form控件值 (Dayjs/字符串数组/数值)
  → normalize + validate (前端)
  → mapToGraphQLInput (字符串日期 + string[] + SeriesPointInput[])
  → requestCorrelation/requestAnomaly
  → message.success/error + refetch()
```

---

## 实施步骤

### Step 1: 引入依赖组件
在文件顶部添加 Ant Design 组件导入：
```typescript
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  List,
  Select,
  Space,
  Skeleton,
  Typography,
  Row,
  Col,
  Divider,
} from "antd";
import { PlusOutlined, MinusCircleOutlined } from "@ant-design/icons";
```

### Step 2: 添加工具函数
在文件内添加数据转换和验证函数：
```typescript
const TOKEN_SEPARATORS = [",", "\n", "\t"];
const MAX_SERIES_POINTS = 200;

const normalizeStringList = (input?: string[]): string[] =>
  Array.from(new Set((input ?? []).map((s) => s.trim()).filter(Boolean)));

const ensureFiniteNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};
```

### Step 3: 重构 CorrelationForm

**3.1 定义新的表单类型**：
```typescript
interface CorrelationFormValues {
  indicatorName: string;
  value: number;
  changePercent: number;
  dateRange?: [dayjs.Dayjs, dayjs.Dayjs];
  newsSummaries?: string[];
}
```

**3.2 数据映射函数**：
```typescript
const mapCorrelationToInput = (
  values: CorrelationFormValues
): CorrelationAnalysisInput => {
  const [start, end] = values.dateRange ?? [];
  if (!start || !end) throw new Error("date_range_required");
  if (end.isBefore(start, "day")) throw new Error("date_range_invalid");

  return {
    indicatorName: values.indicatorName.trim(),
    value: Number(values.value),
    changePercent: Number(values.changePercent),
    startDate: start.format("YYYY-MM-DD"),
    endDate: end.format("YYYY-MM-DD"),
    newsSummaries: normalizeStringList(values.newsSummaries),
  };
};
```

**3.3 UI改造**：
- 使用 `layout="vertical"`
- 使用 `DatePicker.RangePicker` 替代 `startDate` + `endDate`
- 使用 `Select mode="tags"` 替代 `newsSummaries` 逗号输入
- 添加 `Row/Col` 布局优化

### Step 4: 重构 AnomalyForm

**4.1 定义新的表单类型**：
```typescript
interface SeriesRowForm {
  timestamp?: dayjs.Dayjs;
  value?: number;
}

interface AnomalyFormValues {
  metric: string;
  timestamp?: dayjs.Dayjs;
  value: number;
  deviationPercent: number;
  newsList?: string[];
  policyList?: string[];
  seriesRows?: SeriesRowForm[];
}
```

**4.2 序列数据归一化函数**：
```typescript
const normalizeSeriesRows = (rows?: SeriesRowForm[]): SeriesPointInput[] => {
  const mapped = (rows ?? [])
    .map((r) => {
      const value = ensureFiniteNumber(r.value);
      if (!r.timestamp || value === null) return null;
      return { timestamp: r.timestamp.toISOString(), value };
    })
    .filter((v): v is SeriesPointInput => Boolean(v))
    .sort((a, b) => dayjs(a.timestamp).valueOf() - dayjs(b.timestamp).valueOf());

  const result = mapped.slice(0, MAX_SERIES_POINTS);
  if (mapped.length > MAX_SERIES_POINTS) {
    message.warning(t("analysis.anomaly.errors.seriesTruncated"));
  }
  return result;
};
```

**4.3 数据映射函数**：
```typescript
const mapAnomalyToInput = (values: AnomalyFormValues): AnomalyAnalysisInput => {
  const series = normalizeSeriesRows(values.seriesRows);
  if (!values.timestamp) throw new Error("timestamp_required");

  return {
    metric: values.metric.trim(),
    timestamp: values.timestamp.toISOString(),
    value: Number(values.value),
    deviationPercent: Number(values.deviationPercent),
    newsList: normalizeStringList(values.newsList),
    policyList: normalizeStringList(values.policyList),
    series: series.length ? series : undefined,
  };
};
```

**4.4 UI改造**：
- 使用 `layout="vertical"`
- `timestamp` 改为 `DatePicker showTime`
- `newsList`/`policyList` 改为 `Select mode="tags"`
- **核心改造**: `seriesJson TextArea` → `Form.List` 动态行

### Step 5: 国际化(i18n)补充
在 `apps/web/lib/locales/zh.json` 和 `en.json` 中添加：
```json
{
  "analysis": {
    "correlation": {
      "fields": {
        "dateRange": "时间范围",
        "indicator": "指标名称",
        "value": "当前值",
        "changePercent": "变化百分比"
      }
    },
    "anomaly": {
      "fields": {
        "seriesTitle": "参考时序数据",
        "timestamp": "异常时间",
        "metric": "指标名称"
      },
      "actions": {
        "addPoint": "添加数据点",
        "removePoint": "删除"
      },
      "errors": {
        "seriesTruncated": "数据点超过200个，已自动截断",
        "dateRangeInvalid": "结束日期不能早于开始日期"
      }
    }
  }
}
```

### Step 6: 清理旧代码
- 删除 `seriesJson` 相关代码
- 删除 `parseSeriesJson` 函数
- 删除逗号分隔输入的处理逻辑

---

## 关键文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/web/app/(app)/dashboard/analysis-panel.tsx` | 修改 | 主要实现文件 |
| `apps/web/lib/locales/zh.json` | 修改 | 中文翻译 |
| `apps/web/lib/locales/en.json` | 修改 | 英文翻译 |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| GraphQL API不兼容 | 保持映射层，提交数据格式不变 |
| 日期格式转换错误 | 使用 dayjs 统一处理，添加验证 |
| 序列数据点过多 | 设置 MAX_SERIES_POINTS=200 上限 |
| 侧边栏布局溢出 | 使用 vertical 布局 + width: 100% |
| 用户旧数据兼容 | 表单使用新的初始值，不兼容旧本地存储 |

---

## 验收标准

- [ ] 相关性分析表单使用日期范围选择器
- [ ] 相关性分析表单使用标签输入 newsSummaries
- [ ] 异常分析表单使用时间选择器
- [ ] 异常分析表单使用标签输入 newsList/policyList
- [ ] 异常分析表单使用时序数据动态行输入（替代JSON）
- [ ] 表单在400px宽度下无水平滚动
- [ ] 提交数据格式与现有API兼容
- [ ] 所有新增文本支持国际化
- [ ] 日期范围验证（结束>=开始）
- [ ] 序列数据点上限验证

---

## SESSION_ID（供 /ccg:execute 使用）
- CODEX_SESSION: 019c595a-0782-7040-beba-3de5587f33f7
- GEMINI_SESSION: 602d8691-d1ac-40be-ac24-6ee69fc9bbfb
