import { z } from "zod";

const citationListSchema = z.array(z.number().int().min(1)).max(12).default([]);

export const NewsEventBriefPointSchema = z.object({
  text: z.string().min(1),
  citations: citationListSchema
});

export const NewsEventBriefPayloadSchema = z.object({
  detailed_summary: z.string().min(1),
  tldr: z.string().min(1),
  key_points: z.array(NewsEventBriefPointSchema).min(1).max(10).default([]),
  why_it_matters: z.array(NewsEventBriefPointSchema).max(10).default([]),
  latest_update: NewsEventBriefPointSchema.nullable().optional(),
  what_to_watch: z.array(NewsEventBriefPointSchema).max(12).default([]),
  comparison: z
    .object({
      consensus: z.array(NewsEventBriefPointSchema).max(12).default([]),
      divergence: z.array(NewsEventBriefPointSchema).max(12).default([])
    })
    .optional(),
  limitations: z.string().nullable().optional()
});

export type NewsEventBriefPayload = z.infer<typeof NewsEventBriefPayloadSchema>;
