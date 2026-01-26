"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessedItemModel = void 0;
const mongoose_1 = require("mongoose");
const ProcessedItemErrorSchema = new mongoose_1.Schema({
    message: { type: String, required: true },
    name: { type: String },
    stack: { type: String }
}, { _id: false });
const ProcessedItemEntitySchema = new mongoose_1.Schema({
    name: { type: String, required: true },
    type: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 }
}, { _id: false });
const ProcessedItemResultSchema = new mongoose_1.Schema({
    title: { type: String, default: null },
    subtitle: { type: String, default: null },
    author: { type: String, default: null },
    source: { type: String, default: null },
    published_at: { type: String, default: null },
    language: { type: String, default: null },
    location: { type: String, default: null },
    category: { type: String, default: null },
    sentiment: { type: String, default: null },
    sentiment_label: { type: String, default: null },
    topics: { type: [String], default: [] },
    summary: { type: String, default: null },
    key_points: { type: [String], default: [] },
    entities: { type: [ProcessedItemEntitySchema], default: [] },
    cleaned_markdown: { type: String, required: true },
    cleaned_markdown_source: {
        type: String,
        enum: ["llm", "crawl_fallback"],
        default: undefined,
    },
    removed_noise_types: { type: [String], default: [] },
    quality_score: { type: Number, min: 0, max: 1, default: null },
    llm_model: { type: String, default: null },
    llm_prompt_version: { type: String, default: null }
}, { _id: false });
const ProcessedItemSchema = new mongoose_1.Schema({
    rawItemId: { type: mongoose_1.Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemMetaId: { type: String, index: true, required: true },
    orgId: { type: String, index: true, required: true },
    ingestedAt: { type: Date, default: undefined },
    sortAt: { type: Date, default: undefined },
    traceId: { type: String, index: true, default: null },
    pipelineJobId: { type: String, index: true, default: null },
    sourceId: { type: String, index: true, default: null },
    status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed"],
        default: "pending",
    },
    tags: { type: [String], default: [] },
    result: { type: ProcessedItemResultSchema, default: undefined },
    error: { type: ProcessedItemErrorSchema, default: undefined },
    llm: {
        model: { type: String },
        promptVersion: { type: String },
        promptTokens: { type: Number },
        completionTokens: { type: Number },
        totalTokens: { type: Number },
        costUsd: { type: Number },
        latencyMs: { type: Number },
    },
    summaryEmbedding: { type: [Number], default: undefined },
    summaryEmbeddingModel: { type: String, default: null },
    duplicateOf: { type: mongoose_1.Schema.Types.ObjectId, ref: "ProcessedItem", default: null },
    duplicateSimilarity: { type: Number, min: 0, max: 1, default: null },
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
});
ProcessedItemSchema.index({ orgId: 1, createdAt: -1 });
ProcessedItemSchema.index({ orgId: 1, status: 1, createdAt: -1 });
ProcessedItemSchema.index({ orgId: 1, status: 1, sortAt: -1 });
ProcessedItemSchema.index({ orgId: 1, duplicateOf: 1, createdAt: -1 });
ProcessedItemSchema.index({ orgId: 1, status: 1, summaryEmbeddingModel: 1, duplicateOf: 1, createdAt: -1 });
ProcessedItemSchema.pre("validate", function (next) {
    const doc = this;
    if (doc.status === "completed" && !doc.result) {
        next(new Error("ProcessedItem.result is required when status is completed"));
        return;
    }
    if (doc.status === "failed" && !doc.error) {
        next(new Error("ProcessedItem.error is required when status is failed"));
        return;
    }
    next();
});
exports.ProcessedItemModel = mongoose_1.models.ProcessedItem ||
    (0, mongoose_1.model)("ProcessedItem", ProcessedItemSchema);
//# sourceMappingURL=processed-item.js.map
