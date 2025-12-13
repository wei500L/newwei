import { Schema } from "mongoose";
export declare const ProcessedItemModel: import("mongoose").Model<any, {}, {}, {}, any, any> | import("mongoose").Model<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    orgId: string;
    error?: any;
    result?: any;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    orgId: string;
    error?: any;
    result?: any;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}> & {
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    orgId: string;
    error?: any;
    result?: any;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
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
    status: "pending" | "processing" | "completed" | "failed";
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    orgId: string;
    error?: any;
    result?: any;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    orgId: string;
    error?: any;
    result?: any;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    status: "pending" | "processing" | "completed" | "failed";
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    orgId: string;
    error?: any;
    result?: any;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>>;
export type ProcessedItemDocument = typeof ProcessedItemModel extends infer T ? T extends {
    prototype: infer P;
} ? P : never : never;
//# sourceMappingURL=processed-item.d.ts.map