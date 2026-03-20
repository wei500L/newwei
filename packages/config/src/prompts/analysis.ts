export const analysisPromptTemplates = {
  correlation: {
    system: "你是一位专业的金融数据分析师。请围绕数据关联与情绪总结，提供简洁可执行的输出。",
    user: [
      "任务：分析以下数据之间的关联性",
      "经济指标：{{indicatorName}}，当前值 {{value}}，环比变化 {{changePercent}}%",
      "相关新闻：{{news}}",
      "时间范围：{{startDate}} 至 {{endDate}}",
      "",
      "输出要求：",
      "1. 数据关联性分析（200字以内）",
      "2. 关键驱动因素（3-5条）",
      "3. 情绪判断：积极/中性/消极",
      "4. 潜在影响预测（100字以内）"
    ].join("\n")
  },
  anomaly: {
    system:
      "角色：金融数据异常分析专家。优先参考统计检测结果，再结合新闻与政策解释异常的可能原因，并输出可执行洞察。",
    user: [
      "任务：解释以下数据异常的可能原因",
      "指标：{{metric}}",
      "异常时间：{{timestamp}}",
      "异常值：{{value}}（偏离均值 {{deviationPercent}}%）",
      "同期新闻：{{news}}",
      "相关政策：{{policies}}",
      "统计检测结果：",
      "{{statsSummary}}",
      "",
      "输出要求：",
      "1. 异常原因分析（3-5条，按可能性排序）",
      "2. 每条原因需引用具体新闻或政策依据",
      "3. 总结（50字以内）"
    ].join("\n")
  },
  geoTransport: {
    system: [
      "你是地理运输态势分析师。",
      "只能基于提供的观测事实作答，不得虚构缺失数据。",
      "必须明确区分观察事实与推断判断。",
      "引用证据时优先写 objectKey、UTC 时间、坐标、速度、航向、高度或船型。",
      "如果数据不足，直接指出数据缺口与置信度限制。"
    ].join("\n"),
    user: [
      "任务：分析下列飞机与船舶观测轨迹。",
      "运输类型：{{transportKinds}}",
      "时间范围：{{startDate}} 至 {{endDate}}",
      "视图边界：{{bbox}}",
      "重点对象：{{objectKeys}}",
      "",
      "结构化上下文：",
      "{{contextJson}}",
      "",
      "输出要求：",
      "1. 总体态势",
      "2. 重点飞机",
      "3. 重点船舶",
      "4. 航线与咽喉点",
      "5. 异常行为",
      "6. 置信度与数据缺口",
      "7. 下一步观察点"
    ].join("\n")
  }
} as const;

export type AnalysisPromptTemplateKey = keyof typeof analysisPromptTemplates;

export function renderPromptTemplate(
  template: string,
  variables: Record<string, string | number | boolean | null | undefined>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = variables[key];
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  });
}
