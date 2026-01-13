import { Schema, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
declare const RawItemSchema: Schema<any, Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    source: string;
    payload: {
        url: string;
        metadata: any;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        forceRefresh: boolean;
        language?: string | null | undefined;
        crawlOptions?: any;
        sourceName?: string | null | undefined;
    };
    itemMetaId: string;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    source: string;
    payload: {
        url: string;
        metadata: any;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        forceRefresh: boolean;
        language?: string | null | undefined;
        crawlOptions?: any;
        sourceName?: string | null | undefined;
    };
    itemMetaId: string;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    source: string;
    payload: {
        url: string;
        metadata: any;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        forceRefresh: boolean;
        language?: string | null | undefined;
        crawlOptions?: any;
        sourceName?: string | null | undefined;
    };
    itemMetaId: string;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>;
export type RawItem = InferSchemaType<typeof RawItemSchema>;
export declare const RawItemModel: Model<{
    [x: string]: NativeDate;
    source: string;
    payload: {
        url: string;
        metadata: any;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        forceRefresh: boolean;
        language?: string | null | undefined;
        crawlOptions?: any;
        sourceName?: string | null | undefined;
    };
    itemMetaId: string;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    source: string;
    payload: {
        url: string;
        metadata: any;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        forceRefresh: boolean;
        language?: string | null | undefined;
        crawlOptions?: any;
        sourceName?: string | null | undefined;
    };
    itemMetaId: string;
}, {}, {}> & {
    [x: string]: NativeDate;
    source: string;
    payload: {
        url: string;
        metadata: any;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        forceRefresh: boolean;
        language?: string | null | undefined;
        crawlOptions?: any;
        sourceName?: string | null | undefined;
    };
    itemMetaId: string;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any>;
export type RawItemDocument = HydratedDocument<RawItem>;
export {};
//# sourceMappingURL=raw-item.d.ts.map