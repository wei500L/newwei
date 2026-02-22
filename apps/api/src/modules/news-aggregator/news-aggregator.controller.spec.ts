import { BadRequestException } from "@nestjs/common"

import { NewsAggregatorController } from "./news-aggregator.controller"

describe("NewsAggregatorController", () => {
  const newsAggregatorService = {
    fetchSource: jest.fn(),
    fetchBatch: jest.fn(),
    getMetadata: jest.fn(),
  }

  let controller: NewsAggregatorController

  beforeEach(() => {
    jest.resetAllMocks()
    controller = new NewsAggregatorController(newsAggregatorService as any)
  })

  it.each(["true", "1", "yes", "y", "on"])(
    "passes forceRefresh=true when query is %s",
    async (queryValue) => {
      newsAggregatorService.fetchSource.mockResolvedValue({
        status: "success",
        id: "baidu",
        updatedTime: Date.now(),
        items: [],
      })

      await controller.getSource("baidu", queryValue)

      expect(newsAggregatorService.fetchSource).toHaveBeenCalledWith("baidu", true)
    },
  )

  it.each([undefined, "", "false", "0", "no", "n", "off"])(
    "passes forceRefresh=false when query is %s",
    async (queryValue) => {
      newsAggregatorService.fetchSource.mockResolvedValue({
        status: "success",
        id: "baidu",
        updatedTime: Date.now(),
        items: [],
      })

      await controller.getSource("baidu", queryValue)

      expect(newsAggregatorService.fetchSource).toHaveBeenCalledWith("baidu", false)
    },
  )

  it("throws when forceRefresh query is invalid", () => {
    expect(() => controller.getSource("baidu", "maybe")).toThrow(BadRequestException)
    expect(newsAggregatorService.fetchSource).not.toHaveBeenCalled()
  })

  it("throws when source id format is invalid", () => {
    expect(() => controller.getSource("bad id", "true")).toThrow(BadRequestException)
    expect(newsAggregatorService.fetchSource).not.toHaveBeenCalled()
  })
})
