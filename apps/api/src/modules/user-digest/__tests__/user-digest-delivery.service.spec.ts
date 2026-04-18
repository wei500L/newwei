import { BadRequestException } from "@nestjs/common";

import { UserDigestDeliveryService } from "../user-digest-delivery.service";

describe("UserDigestDeliveryService", () => {
  const prisma = {
    membership: {
      findUnique: jest.fn(),
    },
    userDigestDeliverySchedule: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  } as any;

  const env = {
    get: jest.fn().mockReturnValue("http://localhost:3000"),
  } as any;

  const digestService = {
    generateDigest: jest.fn(),
  } as any;

  const emailService = {
    send: jest.fn(),
    buildUserDigestTemplate: jest.fn().mockReturnValue("<p>digest</p>"),
    buildUserDigestTextTemplate: jest.fn().mockReturnValue("digest"),
  } as any;

  const notificationsService = {
    notify: jest.fn(),
  } as any;

  let service: UserDigestDeliveryService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.membership.findUnique.mockResolvedValue({
      isActive: true,
      user: {
        id: "user-1",
        email: "user@example.com",
        emailVerified: new Date("2026-04-18T00:00:00.000Z"),
        isActive: true,
        firstName: "Ada",
      },
    });
    prisma.userDigestDeliverySchedule.findUnique.mockResolvedValue(null);
    prisma.userDigestDeliverySchedule.upsert.mockImplementation(
      async ({ create }: any) => ({
        ...create,
        id: "schedule-1",
        lastSentAt: null,
        lastStatus: "idle",
        lastStatusAt: null,
        lastError: null,
      }),
    );
    prisma.userDigestDeliverySchedule.findMany.mockResolvedValue([]);
    prisma.userDigestDeliverySchedule.update.mockResolvedValue(undefined);
    digestService.generateDigest.mockResolvedValue({
      version: 1,
      generatedAt: "2026-04-18T01:00:00.000Z",
      windowStart: "2026-04-15T00:00:00.000Z",
      windowEnd: "2026-04-18T00:00:00.000Z",
      preference: {
        version: 1,
        focusEntities: [],
        focusTopics: [],
        windowDays: 3,
        maxEvents: 8,
        includeIndicators: true,
        maxIndicatorsPerEvent: 5,
      },
      events: [],
    });
    service = new UserDigestDeliveryService(
      prisma,
      env,
      digestService,
      emailService,
      notificationsService,
    );
  });

  it("returns default delivery settings when no schedule exists", async () => {
    const settings = await service.getDelivery("org-1", "user-1");

    expect(settings).toMatchObject({
      version: 1,
      enabled: false,
      time: "09:00",
      timezone: "UTC",
      targetEmail: "user@example.com",
      emailVerified: true,
      lastStatus: "idle",
    });
  });

  it("rejects enabling delivery when email is not verified", async () => {
    prisma.membership.findUnique.mockResolvedValue({
      isActive: true,
      user: {
        id: "user-1",
        email: "user@example.com",
        emailVerified: null,
        isActive: true,
        firstName: "Ada",
      },
    });

    await expect(
      service.updateDelivery("org-1", "user-1", {
        enabled: true,
        time: "08:30",
        timezone: "Asia/Shanghai",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("sends email and writes a ready notification when digest events exist", async () => {
    prisma.userDigestDeliverySchedule.findMany.mockResolvedValue([
      {
        id: "schedule-1",
        orgId: "org-1",
        userId: "user-1",
        timezone: "Asia/Shanghai",
        sendHour: 8,
        sendMinute: 30,
        nextRunAt: new Date("2026-04-18T00:30:00.000Z"),
        user: {
          id: "user-1",
          email: "user@example.com",
          emailVerified: new Date("2026-04-18T00:00:00.000Z"),
          isActive: true,
          firstName: "Ada",
        },
      },
    ]);
    digestService.generateDigest.mockResolvedValue({
      version: 1,
      generatedAt: "2026-04-18T00:31:00.000Z",
      windowStart: "2026-04-15T00:00:00.000Z",
      windowEnd: "2026-04-18T00:00:00.000Z",
      preference: {
        version: 1,
        focusEntities: [],
        focusTopics: [],
        windowDays: 3,
        maxEvents: 8,
        includeIndicators: true,
        maxIndicatorsPerEvent: 5,
      },
      events: [
        {
          eventId: "event-1",
          title: "Macro risk",
          summary: "Summary 1",
          primaryTopic: "macro",
          primaryEntity: "ACME",
          startAt: "2026-04-17T00:00:00.000Z",
          lastAt: "2026-04-18T00:20:00.000Z",
          itemCount: 4,
          representativeUrl: "https://example.com/story-1",
        },
      ],
    });

    const summary = await service.runDueDeliveriesForOrg(
      "org-1",
      new Date("2026-04-18T00:31:00.000Z"),
    );

    expect(summary).toEqual({
      dueCount: 1,
      sentCount: 1,
      emptyCount: 0,
      failedCount: 0,
    });
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(prisma.userDigestDeliverySchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStatus: "sent",
          lastError: null,
        }),
      }),
    );
    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "user-1",
        title: "每日摘要已送达",
      }),
    );
  });

  it("creates an empty notification without sending email when digest has no events", async () => {
    prisma.userDigestDeliverySchedule.findMany.mockResolvedValue([
      {
        id: "schedule-1",
        orgId: "org-1",
        userId: "user-1",
        timezone: "Asia/Shanghai",
        sendHour: 8,
        sendMinute: 30,
        nextRunAt: new Date("2026-04-18T00:30:00.000Z"),
        user: {
          id: "user-1",
          email: "user@example.com",
          emailVerified: new Date("2026-04-18T00:00:00.000Z"),
          isActive: true,
          firstName: "Ada",
        },
      },
    ]);

    const summary = await service.runDueDeliveriesForOrg(
      "org-1",
      new Date("2026-04-18T00:31:00.000Z"),
    );

    expect(summary).toEqual({
      dueCount: 1,
      sentCount: 0,
      emptyCount: 1,
      failedCount: 0,
    });
    expect(emailService.send).not.toHaveBeenCalled();
    expect(prisma.userDigestDeliverySchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStatus: "empty_notified",
        }),
      }),
    );
  });

  it("records a failure and emits a failure notification when email send throws", async () => {
    prisma.userDigestDeliverySchedule.findMany.mockResolvedValue([
      {
        id: "schedule-1",
        orgId: "org-1",
        userId: "user-1",
        timezone: "Asia/Shanghai",
        sendHour: 8,
        sendMinute: 30,
        nextRunAt: new Date("2026-04-18T00:30:00.000Z"),
        user: {
          id: "user-1",
          email: "user@example.com",
          emailVerified: new Date("2026-04-18T00:00:00.000Z"),
          isActive: true,
          firstName: "Ada",
        },
      },
    ]);
    digestService.generateDigest.mockResolvedValue({
      version: 1,
      generatedAt: "2026-04-18T00:31:00.000Z",
      windowStart: "2026-04-15T00:00:00.000Z",
      windowEnd: "2026-04-18T00:00:00.000Z",
      preference: {
        version: 1,
        focusEntities: [],
        focusTopics: [],
        windowDays: 3,
        maxEvents: 8,
        includeIndicators: true,
        maxIndicatorsPerEvent: 5,
      },
      events: [
        {
          eventId: "event-1",
          title: "Macro risk",
          summary: "Summary 1",
          primaryTopic: "macro",
          primaryEntity: "ACME",
          startAt: "2026-04-17T00:00:00.000Z",
          lastAt: "2026-04-18T00:20:00.000Z",
          itemCount: 4,
          representativeUrl: "https://example.com/story-1",
        },
      ],
    });
    emailService.send.mockRejectedValueOnce(new Error("SMTP down"));

    const summary = await service.runDueDeliveriesForOrg(
      "org-1",
      new Date("2026-04-18T00:31:00.000Z"),
    );

    expect(summary).toEqual({
      dueCount: 1,
      sentCount: 0,
      emptyCount: 0,
      failedCount: 1,
    });
    expect(prisma.userDigestDeliverySchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStatus: "failed",
          lastError: "SMTP down",
        }),
      }),
    );
    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "user-1",
        title: "每日摘要投递失败",
      }),
    );
  });

  it("continues processing later schedules when one user's digest generation fails", async () => {
    prisma.userDigestDeliverySchedule.findMany.mockResolvedValue([
      {
        id: "schedule-1",
        orgId: "org-1",
        userId: "user-1",
        timezone: "Asia/Shanghai",
        sendHour: 8,
        sendMinute: 30,
        nextRunAt: new Date("2026-04-18T00:30:00.000Z"),
        user: {
          id: "user-1",
          email: "user-1@example.com",
          emailVerified: new Date("2026-04-18T00:00:00.000Z"),
          isActive: true,
          firstName: "Ada",
        },
      },
      {
        id: "schedule-2",
        orgId: "org-1",
        userId: "user-2",
        timezone: "Asia/Shanghai",
        sendHour: 8,
        sendMinute: 35,
        nextRunAt: new Date("2026-04-18T00:35:00.000Z"),
        user: {
          id: "user-2",
          email: "user-2@example.com",
          emailVerified: new Date("2026-04-18T00:00:00.000Z"),
          isActive: true,
          firstName: "Grace",
        },
      },
    ]);
    digestService.generateDigest
      .mockRejectedValueOnce(new Error("Digest query failed"))
      .mockResolvedValueOnce({
        version: 1,
        generatedAt: "2026-04-18T00:36:00.000Z",
        windowStart: "2026-04-15T00:00:00.000Z",
        windowEnd: "2026-04-18T00:00:00.000Z",
        preference: {
          version: 1,
          focusEntities: [],
          focusTopics: [],
          windowDays: 3,
          maxEvents: 8,
          includeIndicators: true,
          maxIndicatorsPerEvent: 5,
        },
        events: [
          {
            eventId: "event-1",
            title: "Macro risk",
            summary: "Summary 1",
            primaryTopic: "macro",
            primaryEntity: "ACME",
            startAt: "2026-04-17T00:00:00.000Z",
            lastAt: "2026-04-18T00:20:00.000Z",
            itemCount: 4,
            representativeUrl: "https://example.com/story-1",
          },
        ],
      });

    const summary = await service.runDueDeliveriesForOrg(
      "org-1",
      new Date("2026-04-18T00:36:00.000Z"),
    );

    expect(summary).toEqual({
      dueCount: 2,
      sentCount: 1,
      emptyCount: 0,
      failedCount: 1,
    });
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(prisma.userDigestDeliverySchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "schedule-1" },
        data: expect.objectContaining({
          lastStatus: "failed",
          lastError: "Digest query failed",
        }),
      }),
    );
    expect(prisma.userDigestDeliverySchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "schedule-2" },
        data: expect.objectContaining({
          lastStatus: "sent",
          lastError: null,
        }),
      }),
    );
  });
});
