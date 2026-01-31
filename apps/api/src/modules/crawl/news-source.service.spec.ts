import { BadRequestException, NotFoundException } from "@nestjs/common";

import { NewsSourceService } from "./news-source.service";

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
