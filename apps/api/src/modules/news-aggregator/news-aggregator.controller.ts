import { BadRequestException, Body, Controller, Get, Post, Query } from "@nestjs/common"

import { Public } from "../../common/decorators/public.decorator"

import { NewsAggregatorService } from "./news-aggregator.service"

interface BatchFetchDto {
  sources?: string[]
}

const SOURCE_ID_PATTERN = /^[a-z0-9_-]+$/i

@Controller("news-aggregator")
export class NewsAggregatorController {
  constructor(private readonly newsAggregatorService: NewsAggregatorService) {}

  @Public()
  @Get("source")
  getSource(@Query("id") id: string) {
    const sourceId = this.validateSourceId(id)
    return this.newsAggregatorService.fetchSource(sourceId)
  }

  @Public()
  @Post("sources/batch")
  getSourcesBatch(@Body() body: BatchFetchDto) {
    if (!Array.isArray(body?.sources)) {
      throw new BadRequestException("sources must be an array of source ids")
    }

    const validated = body.sources
      .filter((s): s is string => typeof s === "string" && SOURCE_ID_PATTERN.test(s.trim()))
      .map((s) => s.trim())

    return this.newsAggregatorService.fetchBatch(validated)
  }

  @Public()
  @Get("metadata")
  getMetadata() {
    return this.newsAggregatorService.getMetadata()
  }

  private validateSourceId(id: unknown): string {
    if (typeof id !== "string" || !id.trim()) {
      throw new BadRequestException("id query is required")
    }
    const trimmed = id.trim()
    if (!SOURCE_ID_PATTERN.test(trimmed)) {
      throw new BadRequestException("invalid source id format")
    }
    return trimmed
  }
}
