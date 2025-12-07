import { z } from "zod";

const metadataRecord = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {},
  z.record(z.unknown()),
);

export const Crawl4aiMarkdownResultSchema = z
  .object({
    raw_markdown: z.string().optional(),
    rawMarkdown: z.string().optional(),
    markdown_with_citations: z.string().optional(),
    markdownWithCitations: z.string().optional(),
    references_markdown: z.string().optional(),
    referencesMarkdown: z.string().optional(),
    fit_markdown: z.string().optional(),
    fitMarkdown: z.string().optional(),
    markdown: z.string().optional(),
    text: z.string().optional(),
  })
  .catchall(z.unknown());

export const Crawl4aiArticleSchema = z
  .object({
    url: z.string().trim().optional(),
    markdown: z.union([z.string(), Crawl4aiMarkdownResultSchema]).nullish(),
    text: z.string().optional(),
    publishedAt: z.string().nullable().optional(),
    metadata: metadataRecord.optional(),
    success: z.boolean().optional(),
    statusCode: z.number().int().optional(),
    status_code: z.number().int().optional(),
  })
  .passthrough();

export const Crawl4aiResponseSchema = z
  .object({
    runId: z.string().nullable().optional(),
    nextCursor: z.string().nullable().optional(),
    warnings: z.array(z.string()).default([]),
    results: z
      .array(Crawl4aiArticleSchema)
      .nonempty("crawl4ai returned no results"),
    serverMemoryMb: z.number().optional(),
    peakMemoryMb: z.number().optional(),
    memoryEfficiency: z.number().optional(),
  })
  .passthrough();

export type ParsedCrawl4aiMarkdownResult = z.infer<typeof Crawl4aiMarkdownResultSchema>;
export type ParsedCrawl4aiArticle = z.infer<typeof Crawl4aiArticleSchema>;
export type ParsedCrawl4aiResponse = z.infer<typeof Crawl4aiResponseSchema>;
