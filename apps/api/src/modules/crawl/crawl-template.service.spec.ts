import { BadRequestException } from "@nestjs/common";

import { CrawlTemplateService } from "./crawl-template.service";

describe("CrawlTemplateService.createTemplate", () => {
  it("rejects crawlOptions containing crawl4ai LLM extraction config", async () => {
    const prisma = {
      crawlTemplate: {
        create: jest.fn()
      }
    } as any;
    const service = new CrawlTemplateService(prisma);

    await expect(
      service.createTemplate("org-1", {
        name: "Bad template",
        description: null,
        isActive: true,
        crawlOptions: {
          extractionStrategy: { type: "llm" }
        }
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.crawlTemplate.create).not.toHaveBeenCalled();
  });
});

