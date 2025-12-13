"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessedItemModel = void 0;
const mongoose_1 = require("mongoose");
const ProcessedItemSchema = new mongoose_1.Schema({
    rawItemId: { type: mongoose_1.Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemMetaId: { type: String, index: true, required: true },
    orgId: { type: String, index: true, required: true },
    status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed"],
        default: "pending",
    },
    tags: { type: [String], default: [] },
    result: mongoose_1.Schema.Types.Mixed,
    error: mongoose_1.Schema.Types.Mixed,
    llm: {
        model: { type: String },
        promptVersion: { type: String },
        promptTokens: { type: Number },
        completionTokens: { type: Number },
        totalTokens: { type: Number },
        costUsd: { type: Number },
        latencyMs: { type: Number },
    },
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
});
exports.ProcessedItemModel = mongoose_1.models.ProcessedItem || (0, mongoose_1.model)("ProcessedItem", ProcessedItemSchema);
//# sourceMappingURL=processed-item.js.map