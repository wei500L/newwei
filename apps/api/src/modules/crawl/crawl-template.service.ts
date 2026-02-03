import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import { assertNoCrawl4aiLlmOptions } from "./crawl4ai-llm.guard";
import { CreateCrawlTemplateDto, ListCrawlTemplateDto, UpdateCrawlTemplateDto } from "./dto/crawl-template.dto";

@Injectable()
export class CrawlTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async listTemplates(orgId: string, query?: ListCrawlTemplateDto) {
    const where: Prisma.CrawlTemplateWhereInput = { orgId };
    const search = query?.search?.trim();
    if (search) {
      where.OR = [{ name: { contains: search } }];
    }

    return this.prisma.crawlTemplate.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
    });
  }

  async createTemplate(orgId: string, input: CreateCrawlTemplateDto) {
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestException("name is required");
    }
    const description = this.normalizeOptionalNullableString(input.description);
    const crawlOptions = this.normalizeOptionalObject(input.crawlOptions);
    const isActive = input.isActive ?? true;

    return this.prisma.crawlTemplate.create({
      data: {
        orgId,
        name,
        description,
        isActive,
        crawlOptions: crawlOptions ? toPrismaJsonValue(crawlOptions) : Prisma.DbNull
      }
    });
  }

  async updateTemplate(orgId: string, id: string, input: UpdateCrawlTemplateDto) {
    const existing = await this.prisma.crawlTemplate.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("Crawl template not found");
    }

    const data: Prisma.CrawlTemplateUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException("name is required");
      }
      data.name = name;
    }
    if (input.description !== undefined) {
      data.description = this.normalizeOptionalNullableString(input.description);
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.crawlOptions !== undefined) {
      if (input.crawlOptions === null) {
        data.crawlOptions = Prisma.DbNull;
      } else if (input.crawlOptions) {
        data.crawlOptions = toPrismaJsonValue(this.normalizeOptionalObject(input.crawlOptions));
      }
    }

    return this.prisma.crawlTemplate.update({ where: { id }, data });
  }

  async deleteTemplate(orgId: string, id: string) {
    const existing = await this.prisma.crawlTemplate.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("Crawl template not found");
    }
    await this.prisma.crawlTemplate.delete({ where: { id } });
    return { ok: true };
  }

  private normalizeOptionalNullableString(value?: string | null) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeOptionalObject(value?: Record<string, unknown> | null) {
    if (!value) {
      return null;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("crawlOptions must be an object");
    }
    assertNoCrawl4aiLlmOptions(value, "crawlOptions");
    return value;
  }
}
