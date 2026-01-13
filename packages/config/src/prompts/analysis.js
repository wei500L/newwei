"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analysisPromptTemplates = void 0;
exports.renderPromptTemplate = renderPromptTemplate;
exports.analysisPromptTemplates = {
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
        system: "角色：金融数据异常分析专家。优先参考统计检测结果，再结合新闻与政策解释异常的可能原因，并输出可执行洞察。",
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
    }
};
function renderPromptTemplate(template, variables) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const value = variables[key];
        if (value === null || value === undefined) {
            return "";
        }
        return String(value);
    });
}
//# sourceMappingURL=analysis.js.map