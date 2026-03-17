import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import {
  matchHostPattern,
  normalizeCrawlSiteProfileConfig,
} from "./crawl-frontier.utils";
import type {
  CrawlSiteExecutionMode,
  CrawlSiteProfileConfig,
} from "./crawl.types";
import {
  CreateCrawlSiteProfileDto,
  ListCrawlSiteProfileDto,
  UpdateCrawlSiteProfileDto,
} from "./dto/crawl-frontier.dto";

@Injectable()
export class CrawlSiteProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async listProfiles(orgId: string, query?: ListCrawlSiteProfileDto) {
    const where: Prisma.CrawlSiteProfileWhereInput = { orgId };
    const search = query?.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { matchHost: { contains: search } },
      ];
    }
    const profiles = await this.prisma.crawlSiteProfile.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    return profiles.map((profile) => this.mapProfile(profile));
  }

  async getProfile(orgId: string, id: string) {
    const profile = await this.prisma.crawlSiteProfile.findUnique({
      where: { id },
    });
    if (!profile || profile.orgId !== orgId) {
      throw new NotFoundException("Crawl site profile not found");
    }
    return this.mapProfile(profile);
  }

  async createProfile(
    orgId: string,
    actorId: string,
    input: CreateCrawlSiteProfileDto,
  ) {
    const payload = this.normalizeInput(input);
    const created = await this.prisma.crawlSiteProfile.create({
      data: {
        orgId,
        name: payload.name,
        description: payload.description,
        matchHost: payload.matchHost,
        isActive: payload.isActive,
        executionMode: payload.executionMode,
        config: toPrismaJsonValue(payload.config),
        createdById: actorId,
        updatedById: actorId,
        publishedAt: new Date(),
      },
    });
    await this.createVersion(created.id, orgId, actorId, {
      version: created.version,
      name: created.name,
      description: created.description,
      matchHost: created.matchHost,
      isActive: created.isActive,
      executionMode: created.executionMode,
      config: payload.config,
    });
    return this.mapProfile(created);
  }

  async updateProfile(
    orgId: string,
    actorId: string,
    id: string,
    input: UpdateCrawlSiteProfileDto,
  ) {
    const existing = await this.prisma.crawlSiteProfile.findUnique({
      where: { id },
    });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("Crawl site profile not found");
    }

    const existingConfig = normalizeCrawlSiteProfileConfig(existing.config);
    const data: Prisma.CrawlSiteProfileUpdateInput = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException("name is required");
      }
      data.name = name;
    }
    if (input.description !== undefined) {
      data.description = this.normalizeOptionalString(input.description);
    }
    if (input.matchHost !== undefined) {
      data.matchHost = this.normalizeMatchHost(input.matchHost);
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.executionMode !== undefined) {
      data.executionMode = input.executionMode;
    }
    if (input.config !== undefined) {
      const config = normalizeCrawlSiteProfileConfig(input.config);
      data.config = toPrismaJsonValue(config);
    }

    data.version = { increment: 1 };
    data.updatedById = actorId;
    data.publishedAt = new Date();

    const updated = await this.prisma.crawlSiteProfile.update({
      where: { id },
      data,
    });

    await this.createVersion(updated.id, orgId, actorId, {
      version: updated.version,
      name: updated.name,
      description: updated.description,
      matchHost: updated.matchHost,
      isActive: updated.isActive,
      executionMode: updated.executionMode,
      config:
        input.config !== undefined
          ? normalizeCrawlSiteProfileConfig(input.config)
          : existingConfig,
    });

    return this.mapProfile(updated);
  }

  async listVersions(orgId: string, profileId: string) {
    const existing = await this.prisma.crawlSiteProfile.findUnique({
      where: { id: profileId },
      select: { id: true, orgId: true },
    });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("Crawl site profile not found");
    }
    return this.prisma.crawlSiteProfileVersion.findMany({
      where: { orgId, profileId },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    });
  }

  async rollbackProfile(
    orgId: string,
    actorId: string,
    profileId: string,
    version: number,
  ) {
    const snapshot = await this.prisma.crawlSiteProfileVersion.findFirst({
      where: { orgId, profileId, version },
    });
    if (!snapshot) {
      throw new NotFoundException("Crawl site profile version not found");
    }

    const updated = await this.prisma.crawlSiteProfile.update({
      where: { id: profileId },
      data: {
        name: snapshot.name,
        description: snapshot.description,
        matchHost: snapshot.matchHost,
        isActive: snapshot.isActive,
        executionMode: snapshot.executionMode,
        config: toPrismaJsonValue(normalizeCrawlSiteProfileConfig(snapshot.config)),
        version: { increment: 1 },
        updatedById: actorId,
        publishedAt: new Date(),
      },
    });

    await this.createVersion(updated.id, orgId, actorId, {
      version: updated.version,
      name: updated.name,
      description: updated.description,
      matchHost: updated.matchHost,
      isActive: updated.isActive,
      executionMode: updated.executionMode,
      config: normalizeCrawlSiteProfileConfig(snapshot.config),
    });

    return this.mapProfile(updated);
  }

  async matchProfileForUrl(orgId: string, url: string) {
    const parsed = this.parseUrl(url);
    const activeProfiles = await this.prisma.crawlSiteProfile.findMany({
      where: { orgId, isActive: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });

    const matches = activeProfiles
      .filter((profile) => matchHostPattern(profile.matchHost, parsed.hostname))
      .map((profile) => this.mapProfile(profile));

    return {
      url,
      host: parsed.hostname,
      match: matches[0] ?? null,
      candidates: matches,
    };
  }

  async findProfileForUrl(orgId: string, url: string) {
    const matched = await this.matchProfileForUrl(orgId, url);
    return matched.match;
  }

  private async createVersion(
    profileId: string,
    orgId: string,
    actorId: string,
    input: {
      version: number;
      name: string;
      description?: string | null;
      matchHost: string;
      isActive: boolean;
      executionMode: CrawlSiteExecutionMode;
      config: CrawlSiteProfileConfig;
    },
  ) {
    await this.prisma.crawlSiteProfileVersion.create({
      data: {
        profileId,
        orgId,
        version: input.version,
        name: input.name,
        description: input.description,
        matchHost: input.matchHost,
        isActive: input.isActive,
        executionMode: input.executionMode,
        config: toPrismaJsonValue(input.config),
        createdById: actorId,
      },
    });
  }

  private normalizeInput(
    input: CreateCrawlSiteProfileDto | UpdateCrawlSiteProfileDto,
  ) {
    const name = "name" in input && input.name !== undefined
      ? input.name.trim()
      : undefined;
    if (name !== undefined && !name) {
      throw new BadRequestException("name is required");
    }
    return {
      name: name ?? "",
      description: this.normalizeOptionalString(input.description),
      matchHost:
        "matchHost" in input && input.matchHost !== undefined
          ? this.normalizeMatchHost(input.matchHost)
          : "",
      isActive:
        typeof input.isActive === "boolean" ? input.isActive : true,
      executionMode:
        (input.executionMode as CrawlSiteExecutionMode | undefined) ??
        "layered",
      config: normalizeCrawlSiteProfileConfig(input.config ?? {}),
    };
  }

  private normalizeOptionalString(value?: string | null) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeMatchHost(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      throw new BadRequestException("matchHost is required");
    }
    return trimmed;
  }

  private parseUrl(value: string) {
    try {
      return new URL(value);
    } catch {
      throw new BadRequestException("url must be a valid absolute URL");
    }
  }

  private mapProfile(
    profile: {
      id: string;
      orgId: string;
      name: string;
      description: string | null;
      matchHost: string;
      isActive: boolean;
      executionMode: CrawlSiteExecutionMode;
      version: number;
      config: Prisma.JsonValue;
      createdById: string;
      updatedById: string | null;
      publishedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    return {
      ...profile,
      config: normalizeCrawlSiteProfileConfig(profile.config),
    };
  }
}
