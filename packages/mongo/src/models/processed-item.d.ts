import { Schema, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";
declare const ProcessedItemSchema: Schema<any, Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}, {
    [x: string]: NativeDate;
    traceId: string;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    sourceId: string;
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    pipelineJobId: string;
    summaryEmbeddingModel: string;
    duplicateOf: import("mongoose").Types.ObjectId;
    duplicateSimilarity: number;
    error?: {
        message: string;
        name?: string | null | undefined;
        stack?: string | null | undefined;
    } | null | undefined;
    result?: {
        source: string;
        language: string;
        title: string;
        subtitle: string;
        author: string;
        published_at: string;
        location: string;
        category: string;
        sentiment: string;
        sentiment_label: string;
        topics: string[];
        summary: string;
        key_points: string[];
        entities: import("mongoose").Types.DocumentArray<{
            name: string;
            type: string;
            confidence: number;
        }, import("mongoose").Types.Subdocument<import("bson").ObjectId, any, {
            name: string;
            type: string;
            confidence: number;
        }> & {
            name: string;
            type: string;
            confidence: number;
        }>;
        cleaned_markdown: string;
        removed_noise_types: string[];
        quality_score: number;
        llm_model: string;
        llm_prompt_version: string;
    } | null | undefined;
    sortAt?: NativeDate | null | undefined;
    ingestedAt?: NativeDate | null | undefined;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
    summaryEmbedding?: number[] | null | undefined;
}, import("mongoose").Document<unknown, {}, import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    traceId: string;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    sourceId: string;
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    pipelineJobId: string;
    summaryEmbeddingModel: string;
    duplicateOf: import("mongoose").Types.ObjectId;
    duplicateSimilarity: number;
    error?: {
        message: string;
        name?: string | null | undefined;
        stack?: string | null | undefined;
    } | null | undefined;
    result?: {
        source: string;
        language: string;
        title: string;
        subtitle: string;
        author: string;
        published_at: string;
        location: string;
        category: string;
        sentiment: string;
        sentiment_label: string;
        topics: string[];
        summary: string;
        key_points: string[];
        entities: import("mongoose").Types.DocumentArray<{
            name: string;
            type: string;
            confidence: number;
        }, import("mongoose").Types.Subdocument<import("bson").ObjectId, any, {
            name: string;
            type: string;
            confidence: number;
        }> & {
            name: string;
            type: string;
            confidence: number;
        }>;
        cleaned_markdown: string;
        removed_noise_types: string[];
        quality_score: number;
        llm_model: string;
        llm_prompt_version: string;
    } | null | undefined;
    sortAt?: NativeDate | null | undefined;
    ingestedAt?: NativeDate | null | undefined;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
    summaryEmbedding?: number[] | null | undefined;
}>, {}, import("mongoose").ResolveSchemaOptions<{
    timestamps: {
        createdAt: string;
        updatedAt: string;
    };
}>> & import("mongoose").FlatRecord<{
    [x: string]: NativeDate;
    traceId: string;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    sourceId: string;
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    pipelineJobId: string;
    summaryEmbeddingModel: string;
    duplicateOf: import("mongoose").Types.ObjectId;
    duplicateSimilarity: number;
    error?: {
        message: string;
        name?: string | null | undefined;
        stack?: string | null | undefined;
    } | null | undefined;
    result?: {
        source: string;
        language: string;
        title: string;
        subtitle: string;
        author: string;
        published_at: string;
        location: string;
        category: string;
        sentiment: string;
        sentiment_label: string;
        topics: string[];
        summary: string;
        key_points: string[];
        entities: import("mongoose").Types.DocumentArray<{
            name: string;
            type: string;
            confidence: number;
        }, import("mongoose").Types.Subdocument<import("bson").ObjectId, any, {
            name: string;
            type: string;
            confidence: number;
        }> & {
            name: string;
            type: string;
            confidence: number;
        }>;
        cleaned_markdown: string;
        removed_noise_types: string[];
        quality_score: number;
        llm_model: string;
        llm_prompt_version: string;
    } | null | undefined;
    sortAt?: NativeDate | null | undefined;
    ingestedAt?: NativeDate | null | undefined;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
    summaryEmbedding?: number[] | null | undefined;
}> & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}>;
export declare const ProcessedItemModel: Model<{
    [x: string]: NativeDate;
    traceId: string;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    sourceId: string;
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    pipelineJobId: string;
    summaryEmbeddingModel: string;
    duplicateOf: import("mongoose").Types.ObjectId;
    duplicateSimilarity: number;
    error?: {
        message: string;
        name?: string | null | undefined;
        stack?: string | null | undefined;
    } | null | undefined;
    result?: {
        source: string;
        language: string;
        title: string;
        subtitle: string;
        author: string;
        published_at: string;
        location: string;
        category: string;
        sentiment: string;
        sentiment_label: string;
        topics: string[];
        summary: string;
        key_points: string[];
        entities: import("mongoose").Types.DocumentArray<{
            name: string;
            type: string;
            confidence: number;
        }, import("mongoose").Types.Subdocument<import("bson").ObjectId, any, {
            name: string;
            type: string;
            confidence: number;
        }> & {
            name: string;
            type: string;
            confidence: number;
        }>;
        cleaned_markdown: string;
        removed_noise_types: string[];
        quality_score: number;
        llm_model: string;
        llm_prompt_version: string;
    } | null | undefined;
    sortAt?: NativeDate | null | undefined;
    ingestedAt?: NativeDate | null | undefined;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
    summaryEmbedding?: number[] | null | undefined;
}, {}, {}, {}, import("mongoose").Document<unknown, {}, {
    [x: string]: NativeDate;
    traceId: string;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    sourceId: string;
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    pipelineJobId: string;
    summaryEmbeddingModel: string;
    duplicateOf: import("mongoose").Types.ObjectId;
    duplicateSimilarity: number;
    error?: {
        message: string;
        name?: string | null | undefined;
        stack?: string | null | undefined;
    } | null | undefined;
    result?: {
        source: string;
        language: string;
        title: string;
        subtitle: string;
        author: string;
        published_at: string;
        location: string;
        category: string;
        sentiment: string;
        sentiment_label: string;
        topics: string[];
        summary: string;
        key_points: string[];
        entities: import("mongoose").Types.DocumentArray<{
            name: string;
            type: string;
            confidence: number;
        }, import("mongoose").Types.Subdocument<import("bson").ObjectId, any, {
            name: string;
            type: string;
            confidence: number;
        }> & {
            name: string;
            type: string;
            confidence: number;
        }>;
        cleaned_markdown: string;
        removed_noise_types: string[];
        quality_score: number;
        llm_model: string;
        llm_prompt_version: string;
    } | null | undefined;
    sortAt?: NativeDate | null | undefined;
    ingestedAt?: NativeDate | null | undefined;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
    summaryEmbedding?: number[] | null | undefined;
}, {}, {}> & {
    [x: string]: NativeDate;
    traceId: string;
    status: "pending" | "processing" | "failed" | "completed";
    orgId: string;
    sourceId: string;
    tags: string[];
    itemMetaId: string;
    rawItemId: import("mongoose").Types.ObjectId;
    pipelineJobId: string;
    summaryEmbeddingModel: string;
    duplicateOf: import("mongoose").Types.ObjectId;
    duplicateSimilarity: number;
    error?: {
        message: string;
        name?: string | null | undefined;
        stack?: string | null | undefined;
    } | null | undefined;
    result?: {
        source: string;
        language: string;
        title: string;
        subtitle: string;
        author: string;
        published_at: string;
        location: string;
        category: string;
        sentiment: string;
        sentiment_label: string;
        topics: string[];
        summary: string;
        key_points: string[];
        entities: import("mongoose").Types.DocumentArray<{
            name: string;
            type: string;
            confidence: number;
        }, import("mongoose").Types.Subdocument<import("bson").ObjectId, any, {
            name: string;
            type: string;
            confidence: number;
        }> & {
            name: string;
            type: string;
            confidence: number;
        }>;
        cleaned_markdown: string;
        removed_noise_types: string[];
        quality_score: number;
        llm_model: string;
        llm_prompt_version: string;
    } | null | undefined;
    sortAt?: NativeDate | null | undefined;
    ingestedAt?: NativeDate | null | undefined;
    llm?: {
        model?: string | null | undefined;
        promptVersion?: string | null | undefined;
        promptTokens?: number | null | undefined;
        completionTokens?: number | null | undefined;
        totalTokens?: number | null | undefined;
        costUsd?: number | null | undefined;
        latencyMs?: number | null | undefined;
    } | null | undefined;
    summaryEmbedding?: number[] | null | undefined;
} & {
    _id: import("mongoose").Types.ObjectId;
} & {
    __v: number;
}, any>;
export type ProcessedItem = InferSchemaType<typeof ProcessedItemSchema>;
export type ProcessedItemDocument = HydratedDocument<ProcessedItem>;
export {};
//# sourceMappingURL=processed-item.d.ts.map