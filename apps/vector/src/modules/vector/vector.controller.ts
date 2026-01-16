import { BadRequestException, Controller, Post, Body } from '@nestjs/common';
import { z } from 'zod';

import { VectorService } from './vector.service';

const VectorPointUpsertSchema = z.object({
  processedItemId: z.string().min(1),
  itemMetaId: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
  vector: z.array(z.number().finite()).min(1),
});

const VectorUpsertRequestSchema = z.object({
  orgId: z.string().min(1),
  embeddingModel: z.string().min(1),
  points: z.array(VectorPointUpsertSchema).default([]),
});

const VectorSearchRequestSchema = z.object({
  orgId: z.string().min(1),
  embeddingModel: z.string().min(1),
  vector: z.array(z.number().finite()).min(1),
  limit: z.number().int().positive().max(500).optional(),
  minScore: z.number().finite().min(0).max(1).optional(),
  lookbackMs: z.number().int().positive().optional(),
});

@Controller('v1')
export class VectorController {
  constructor(private readonly vector: VectorService) {}

  @Post('upsert')
  async upsert(@Body() body: unknown) {
    const parsed = VectorUpsertRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Invalid upsert request');
    }
    return await this.vector.upsert(parsed.data);
  }

  @Post('search')
  async search(@Body() body: unknown) {
    const parsed = VectorSearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Invalid search request');
    }
    return await this.vector.search(parsed.data);
  }
}

