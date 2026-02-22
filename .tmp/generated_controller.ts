import { BadRequestException, Body, Controller, Get, Post, Query } from "@nestjs/common"

import { Public } from "../../common/decorators/public.decorator"

import { NewsAggregatorService } from "./news-aggregator.service"

interface BatchFetchDto {
  sources?: string[]
}

@Controller("news-aggregator")
export class NewsAggregatorController {
  constructor(private readonly newsAggregatorService: NewsAggregatorService) {}

  @Public()
  @Get("source")
  getSource(@Query("id") id: string, @Query("latest") latest?: string) {
    if (!id) {
      throw new BadRequestException("id query is required")
    }

    return this.newsAggregatorService.fetchSource(id, this.isTruthy(latest))
  }

  @Public()
  @Post("sources/batch")
  getSourcesBatch(@Body() body: BatchFetchDto) {
    if (!Array.isArray(body?.sources)) {
      throw new BadRequestException("sources must be an array of source ids")
    }

    return this.newsAggregatorService.fetchBatch(body.sources)
  }

  @Public()
  @Get("metadata")
  getMetadata() {
    return this.newsAggregatorService.getMetadata()
  }

  private isTruthy(value?: string): boolean {
    if (!value) {
      return false
    }

    return ["1", "true", "yes", "latest"].includes(value.toLowerCase())
  }
}
