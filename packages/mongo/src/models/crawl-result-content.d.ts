import { Schema, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
declare const CrawlResultContentSchema: Schema<any, Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
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
    crawlRunId?: string | null | undefined;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    crawlRunId?: string | null | undefined;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
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
    crawlRunId?: string | null | undefined;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>;
export type CrawlResultContent = InferSchemaType<typeof CrawlResultContentSchema>;
export declare const CrawlResultContentModel: Model<{
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    crawlRunId?: string | null | undefined;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    crawlRunId?: string | null | undefined;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
}, {}, {}> & {
    [x: string]: NativeDate;
    taskId: string;
    resultId: string;
    markdown: string;
    metadata?: any;
    crawlRunId?: string | null | undefined;
    media?: any;
    mediaAssets?: any;
    tables?: any;
    linkAnalysis?: any;
    rawMarkdown?: string | null | undefined;
    markdownWithCitations?: string | null | undefined;
    referencesMarkdown?: string | null | undefined;
    fitMarkdown?: string | null | undefined;
    sourceUrl?: string | null | undefined;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any>;
export type CrawlResultContentDocument = HydratedDocument<CrawlResultContent>;
export {};
//# sourceMappingURL=crawl-result-content.d.ts.map