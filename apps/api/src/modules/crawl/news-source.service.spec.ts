import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { NewsSourceService } from "./news-source.service";

describe("NewsSourceService.createSource", () => {
  it("throws ConflictException when URL already exists", async () => {
    const prisma = {
      newsSource: {
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "0",
            meta: { target: ["NewsSource_orgId_url_key"] }
          })
        )
      }
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

    await expect(
      service.createSource("org-1", {
        name: "Politico",
        url: "https://www.politico.eu/latest/",
        siteType: "general" as any,
        crawlTemplateId: null,
        config: null,
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("NewsSourceService.updateSource", () => {
  it("throws ConflictException when name already exists", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({ id: "source-1", orgId: "org-1", isActive: true }),
        update: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "0",
            meta: { target: ["orgId", "name"] }
          })
        )
      }
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

    await expect(service.updateSource("org-1", "source-1", { name: "Duplicate" })).rejects.toBeInstanceOf(
      ConflictException
    );
  });
});

describe("NewsSourceService.schedule", () => {
  it("throws when source is missing", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn()
      }
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

    await expect(
      service.schedule("org-1", "source-1", { nextRunAt: new Date().toISOString() })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws when source belongs to another org", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({ id: "source-1", orgId: "org-2" }),
        update: jest.fn()
      }
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

    await expect(
      service.schedule("org-1", "source-1", { nextRunAt: new Date().toISOString() })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws when nextRunAt is invalid", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({ id: "source-1", orgId: "org-1" }),
        update: jest.fn()
      }
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

    await expect(
      service.schedule("org-1", "source-1", { nextRunAt: "not-a-date" })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.newsSource.update).not.toHaveBeenCalled();
  });

  it("updates nextRunAt and clears circuit open", async () => {
    const prisma = {
      newsSource: {
        findUnique: jest.fn().mockResolvedValue({ id: "source-1", orgId: "org-1" }),
        update: jest.fn().mockResolvedValue({ id: "source-1" })
      }
    } as any;
    const metadataService = {} as any;
    const env = {} as any;
    const cache = {} as any;
    const service = new NewsSourceService(prisma, metadataService, env, cache);

    const nextRunAt = "2026-01-31T12:34:56.000Z";
    await service.schedule("org-1", "source-1", { nextRunAt });

    expect(prisma.newsSource.update).toHaveBeenCalledTimes(1);
    const [call] = prisma.newsSource.update.mock.calls[0];
    expect(call.where).toEqual({ id: "source-1" });
    expect(call.data).toMatchObject({ isActive: true, circuitOpenUntil: null });
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
    expect(call.data.nextRunAt.toISOString()).toBe(nextRunAt);
  });
});
