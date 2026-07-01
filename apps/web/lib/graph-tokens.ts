/**
 * 知识图谱 / 实体影响图 echarts 节点色的单一真源。
 *
 * 这些值以 JS 常量（而非 CSS 变量）形式存在，因为它们赋给 echarts
 * option 的 itemStyle.color，最终渲染进 <canvas>——canvas 上下文不会
 * 解析 CSS 自定义属性 var()。集中于此以消除 2D/3D 知识图谱组件间
 * 完全重复的节点配色，以及与实体影响图各自散落的硬编码碎片。
 *
 * 值与迁移前完全一致，收敛本身零视觉变化。
 */

/**
 * 知识图谱（2D / 3D）按节点类型的配色。
 * knowledge-graph.tsx 与 knowledge-graph-3d.tsx 共用同一份，避免重复。
 */
export const KNOWLEDGE_GRAPH_NODE_COLORS = {
  company: "#2563eb",
  industry: "#16a34a",
  person: "#f97316",
  policy: "#ef4444",
  commodity: "#a855f7",
  instrument: "#0ea5e9",
  organization: "#64748b",
} as const;

/** 知识图谱未知节点类型的兜底色。 */
export const DEFAULT_NODE_COLOR = "#94a3b8";

/**
 * 实体影响图按类别的配色（与知识图谱是【不同】的一组）。
 */
export const ENTITY_IMPACT_GRAPH_COLORS = {
  person: "#2f6ce5",
  organization: "#10b981",
  stock: "#f59e0b",
  commodity: "#8b5cf6",
} as const;

/** 实体影响图未知类别的兜底色。 */
export const ENTITY_IMPACT_GRAPH_DEFAULT_COLOR = "#64748b";
