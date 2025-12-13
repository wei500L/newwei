import { Schema } from "mongoose";
export declare const RawItemModel: import("mongoose").Model<any, {}, {}, {}, any, any> | import("mongoose").Model<{
    [x: string]: NativeDate;
    source: string;
    itemMetaId: string;
    payload: {
        url: string;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        metadata: any;
        forceRefresh: boolean;
        language?: string | null | undefined;
        sourceName?: string | null | undefined;
        crawlOptions?: any;
    };
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    source: string;
    itemMetaId: string;
    payload: {
        url: string;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        metadata: any;
        forceRefresh: boolean;
        language?: string | null | undefined;
        sourceName?: string | null | undefined;
        crawlOptions?: any;
    };
}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}> & {
    [x: string]: NativeDate;
    source: string;
    itemMetaId: string;
    payload: {
        url: string;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        metadata: any;
        forceRefresh: boolean;
        language?: string | null | undefined;
        sourceName?: string | null | undefined;
        crawlOptions?: any;
    };
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
    source: string;
    itemMetaId: string;
    payload: {
        url: string;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        metadata: any;
        forceRefresh: boolean;
        language?: string | null | undefined;
        sourceName?: string | null | undefined;
        crawlOptions?: any;
    };
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    source: string;
    itemMetaId: string;
    payload: {
        url: string;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        metadata: any;
        forceRefresh: boolean;
        language?: string | null | undefined;
        sourceName?: string | null | undefined;
        crawlOptions?: any;
    };
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    source: string;
    itemMetaId: string;
    payload: {
        url: string;
        keywords: string[];
        tags: string[];
        summaryHints: string[];
        metadata: any;
        forceRefresh: boolean;
        language?: string | null | undefined;
        sourceName?: string | null | undefined;
        crawlOptions?: any;
    };
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>>;
export type RawItemDocument = typeof RawItemModel extends infer T ? T extends {
    prototype: infer P;
} ? P : never : never;
//# sourceMappingURL=raw-item.d.ts.map