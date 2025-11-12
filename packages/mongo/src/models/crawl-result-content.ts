import { Schema, model, models } from "mongoose";

const CrawlResultContentSchema = new Schema(
  {
    taskId: { type: String, index: true, required: true },
    resultId: { type: String, unique: true, required: true },
    markdown: { type: String, required: true },
    rawMarkdown: { type: String },
    markdownWithCitations: { type: String },
    referencesMarkdown: { type: String },
    fitMarkdown: { type: String },
    media: Schema.Types.Mixed,
    tables: Schema.Types.Mixed,
    metadata: Schema.Types.Mixed,
    sourceUrl: { type: String },
    crawlRunId: { type: String },
    linkAnalysis: Schema.Types.Mixed
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" }
  }
);

CrawlResultContentSchema.index({ taskId: 1, createdAt: -1 });

export const CrawlResultContentModel =
  models.CrawlResultContent || model("CrawlResultContent", CrawlResultContentSchema);

export type CrawlResultContentDocument = typeof CrawlResultContentModel extends infer T
  ? T extends { prototype: infer P }
    ? P
    : never
  : never;
