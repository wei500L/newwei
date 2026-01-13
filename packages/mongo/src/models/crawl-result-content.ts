import { Schema, model, models, type HydratedDocument, type InferSchemaType, type Model } from "mongoose";

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
    mediaAssets: Schema.Types.Mixed,
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

export type CrawlResultContent = InferSchemaType<typeof CrawlResultContentSchema>;

export const CrawlResultContentModel =
  (models.CrawlResultContent as Model<CrawlResultContent> | undefined) ||
  model<CrawlResultContent>("CrawlResultContent", CrawlResultContentSchema);

export type CrawlResultContentDocument = HydratedDocument<CrawlResultContent>;
