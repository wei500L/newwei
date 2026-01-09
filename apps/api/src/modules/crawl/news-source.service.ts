import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { NewsSourceType, Prisma } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import { CreateNewsSourceDto, ListNewsSourceDto, UpdateNewsSourceDto } from "./dto/news-source.dto";

@Injectable()
export class NewsSourceService {
  constructor(private readonly prisma: PrismaService) {}

  async listSources(orgId: string, query?: ListNewsSourceDto) {
    const where: Prisma.NewsSourceWhereInput = { orgId };
    const search = query?.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { url: { contains: search, mode: "insensitive" } }
      ];
    }

    return this.prisma.newsSource.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
    });
  }

  async createSource(orgId: string, input: CreateNewsSourceDto) {
    const name = input.name.trim();
    const url = input.url.trim();
    if (!name) {
      throw new BadRequestException("name is required");
    }
    if (!url) {
      throw new BadRequestException("url is required");
    }
    const language = this.normalizeOptionalString(input.language);
    const crawlTemplateId = this.normalizeOptionalNullableString(input.crawlTemplateId);
    if (crawlTemplateId) {
      await this.assertTemplateInOrg(orgId, crawlTemplateId);
    }
    const config = this.normalizeConfig(input.config);
    const isActive = input.isActive ?? true;
    const nextRunAt = isActive ? new Date() : null;

    return this.prisma.newsSource.create({
      data: {
        orgId,
        name,
        url,
        siteType: input.siteType ?? NewsSourceType.general,
        language,
        crawlTemplateId,
        frequencySeconds: input.frequencySeconds,
        priority: input.priority,
        isActive,
        config,
        nextRunAt
      }
    });
  }

  async updateSource(orgId: string, id: string, input: UpdateNewsSourceDto) {
    const existing = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }

    const data: Prisma.NewsSourceUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException("name is required");
      }
      data.name = name;
    }
    if (input.url !== undefined) {
      const url = input.url.trim();
      if (!url) {
        throw new BadRequestException("url is required");
      }
      data.url = url;
    }
    if (input.siteType !== undefined) {
      data.siteType = input.siteType;
    }
    if (input.language !== undefined) {
      data.language = this.normalizeOptionalString(input.language);
    }
    if (input.crawlTemplateId !== undefined) {
      const crawlTemplateId = this.normalizeOptionalNullableString(input.crawlTemplateId);
      if (crawlTemplateId) {
        await this.assertTemplateInOrg(orgId, crawlTemplateId);
      }
      data.crawlTemplateId = crawlTemplateId;
    }
    if (input.frequencySeconds !== undefined) {
      data.frequencySeconds = input.frequencySeconds;
    }
    if (input.priority !== undefined) {
      data.priority = input.priority;
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.config !== undefined) {
      data.config = input.config ? this.normalizeConfig(input.config) : null;
    }

    const isActivating = input.isActive === true && !existing.isActive;
    const frequencyChanged =
      input.frequencySeconds !== undefined && input.frequencySeconds !== existing.frequencySeconds;

    if (input.isActive === false) {
      data.nextRunAt = null;
    } else if (isActivating || frequencyChanged) {
      data.nextRunAt = new Date();
    }
    if (isActivating) {
      data.circuitOpenUntil = null;
      data.consecutiveFailures = 0;
    }

    return this.prisma.newsSource.update({ where: { id }, data });
  }

  async deleteSource(orgId: string, id: string) {
    const existing = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }
    await this.prisma.newsSource.delete({ where: { id } });
    return { ok: true };
  }

  async runNow(orgId: string, id: string) {
    const existing = await this.prisma.newsSource.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("News source not found");
    }
    return this.prisma.newsSource.update({
      where: { id },
      data: {
        isActive: true,
        nextRunAt: new Date(),
        circuitOpenUntil: null
      }
    });
  }

  private normalizeOptionalString(value?: string | null) {
    if (value === undefined || value === null) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
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

  private async assertTemplateInOrg(orgId: string, templateId: string) {
    const template = await this.prisma.crawlTemplate.findUnique({
      where: { id: templateId },
      select: { orgId: true }
    });
    if (!template || template.orgId !== orgId) {
      throw new BadRequestException("Invalid crawlTemplateId");
    }
  }

  private normalizeConfig(config?: Record<string, unknown> | null) {
    if (!config) {
      return null;
    }
    if (typeof config !== "object" || Array.isArray(config)) {
      throw new BadRequestException("config must be an object");
    }
    return config;
  }
}
