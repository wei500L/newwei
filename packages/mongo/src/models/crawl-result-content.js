"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrawlResultContentModel = void 0;
const mongoose_1 = require("mongoose");
const CrawlResultContentSchema = new mongoose_1.Schema({
    taskId: { type: String, index: true, required: true },
    resultId: { type: String, unique: true, required: true },
    markdown: { type: String, required: true },
    rawMarkdown: { type: String },
    markdownWithCitations: { type: String },
    referencesMarkdown: { type: String },
    fitMarkdown: { type: String },
    media: mongoose_1.Schema.Types.Mixed,
    mediaAssets: mongoose_1.Schema.Types.Mixed,
    tables: mongoose_1.Schema.Types.Mixed,
    metadata: mongoose_1.Schema.Types.Mixed,
    sourceUrl: { type: String },
    crawlRunId: { type: String },
    linkAnalysis: mongoose_1.Schema.Types.Mixed
}, {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
});
CrawlResultContentSchema.index({ taskId: 1, createdAt: -1 });
exports.CrawlResultContentModel = mongoose_1.models.CrawlResultContent || (0, mongoose_1.model)("CrawlResultContent", CrawlResultContentSchema);
//# sourceMappingURL=crawl-result-content.js.map