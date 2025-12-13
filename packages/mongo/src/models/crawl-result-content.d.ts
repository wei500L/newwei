import { Schema } from "mongoose";
export declare const CrawlResultContentModel: import("mongoose").Model<any, {}, {}, {}, any, any> | import("mongoose").Model<{
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
    crawlRunId?: string | null | undefined;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
    crawlRunId?: string | null | undefined;
}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}> & {
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
    crawlRunId?: string | null | undefined;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, Schema<any, import("mongoose").Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
    crawlRunId?: string | null | undefined;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
    crawlRunId?: string | null | undefined;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
    crawlRunId?: string | null | undefined;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>>;
export type CrawlResultContentDocument = typeof CrawlResultContentModel extends infer T ? T extends {
    prototype: infer P;
} ? P : never : never;
//# sourceMappingURL=crawl-result-content.d.ts.map