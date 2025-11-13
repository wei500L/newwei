import { z } from "zod";

export const NewsSourceSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1).nullable().optional(),
  domain: z.string().nullable().optional()
});

export const NewsSectionSchema = z.object({
  heading: z.string().nullable().optional(),
  body: z.string().min(1)
});

export const CleanedNewsSchema = z.object({
  status: z.enum(["ok", "error"]).default("ok"),
  title: z.string().min(1),
  content: z.string().min(1),
  publish_time: z.string().nullable().optional(),
  publish_timezone: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  source: NewsSourceSchema,
  summary: z.string().nullable().optional(),
  highlights: z.array(z.string().min(1)).default([]),
  keywords: z.array(z.string().min(1)).default([]),
  sentiment: z.string().nullable().optional(),
  sections: z.array(NewsSectionSchema).default([]),
  metadata: z.record(z.any()).default({}),
  error: z.string().nullable().optional()
});

export type CleanedNews = z.infer<typeof CleanedNewsSchema>;
