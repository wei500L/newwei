export declare const analysisPromptTemplates: {
    readonly correlation: {
        readonly system: "你是一位专业的金融数据分析师。请围绕数据关联与情绪总结，提供简洁可执行的输出。";
        readonly user: string;
    };
    readonly anomaly: {
        readonly system: "角色：金融数据异常分析专家。优先参考统计检测结果，再结合新闻与政策解释异常的可能原因，并输出可执行洞察。";
        readonly user: string;
    };
};
export type AnalysisPromptTemplateKey = keyof typeof analysisPromptTemplates;
export declare function renderPromptTemplate(template: string, variables: Record<string, string | number | boolean | null | undefined>): string;
//# sourceMappingURL=analysis.d.ts.map