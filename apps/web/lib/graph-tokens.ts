/**
 * 知识图谱 / 实体影响图 echarts 节点色的单一真源。
 *
 * 这些值以 JS 常量（而非 CSS 变量）形式存在，因为它们赋给 echarts
 * option 的 itemStyle.color，最终渲染进 <canvas>——canvas 上下文不会
 * 解析 CSS 自定义属性 var()。集中于此以消除 2D/3D 知识图谱组件间
 * 完全重复的节点配色，以及与实体影响图各自散落的硬编码碎片。
 *
 * FE-UI 批10A：对齐情报编辑台纸墨色板（README §3.2）。
 */

/**
 * 知识图谱（2D / 3D）按节点类型的配色。
 * knowledge-graph.tsx 与 knowledge-graph-3d.tsx 共用同一份，避免重复。
 */
export const KNOWLEDGE_GRAPH_NODE_COLORS = {
  company: "#2f5597",      // 墨蓝
  industry: "#2f7d5b",     // 松绿
  person: "#c2410c",       // 赭橙
  policy: "#b91c1c",       // 朱红
  commodity: "#5b4b8a",    // 靛紫
  instrument: "#0f766e",   // 青绿
  organization: "#5a6270", // 石墨
} as const;

/** 知识图谱未知节点类型的兜底色。 */
export const DEFAULT_NODE_COLOR = "#9b978e";

/** 知识图谱节点标签文字色，随亮 / 暗主题切换。 */
export const KNOWLEDGE_GRAPH_LABEL_COLORS = { light: "#161b26", dark: "#e8e4da" } as const;

/**
 * 实体影响图按类别的配色（与知识图谱是【不同】的一组）。
 */
export const ENTITY_IMPACT_GRAPH_COLORS = {
  person: "#2f5597",
  organization: "#2f7d5b",
  stock: "#b45309",
  commodity: "#5b4b8a",
} as const;

/** 实体影响图未知类别的兜底色。 */
export const ENTITY_IMPACT_GRAPH_DEFAULT_COLOR = "#5a6270";

/** 工作流画布网格线颜色（Background 组件的 SVG 网格线）。 */
export const WORKFLOW_CANVAS_GRID_COLOR = "#d9d4c9";
