import { z } from "zod";

export const CleanedNewsSchema = z.object({
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  topics: z.array(z.string().min(1)).default([]),
  summary: z.string().nullable().optional(),
  key_points: z.array(z.string().min(1)).default([]),
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  cleaned_markdown: z.string().min(1),
  removed_noise_types: z.array(z.string().min(1)).default([]),
  quality_score: z.number().min(0).max(1).nullable().optional(),
  llm_model: z.string().nullable().optional(),
  llm_prompt_version: z.string().nullable().optional(),
});

export type CleanedNews = z.infer<typeof CleanedNewsSchema>;
