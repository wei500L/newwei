"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalysisResultModel = void 0;
const mongoose_1 = require("mongoose");
const AnalysisResultSchema = new mongoose_1.Schema({
    orgId: { type: String, required: true, index: true },
    type: { type: String, enum: ["correlation", "anomaly"], required: true },
    status: { type: String, enum: ["pending", "running", "completed", "failed"], default: "pending" },
    input: mongoose_1.Schema.Types.Mixed,
    output: mongoose_1.Schema.Types.Mixed,
    summary: String,
    error: String,
    model: String,
    triggeredById: String
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});
AnalysisResultSchema.index({ orgId: 1, createdAt: -1 });
AnalysisResultSchema.index({ type: 1, orgId: 1 });
exports.AnalysisResultModel = mongoose_1.models.AnalysisResult || (0, mongoose_1.model)("AnalysisResult", AnalysisResultSchema);
//# sourceMappingURL=analysis-result.js.map