const mockLoggerWarn = jest.fn();

jest.mock("@modular/utils", () => {
  const actual = jest.requireActual("@modular/utils");
  return {
    ...actual,
    createLogger: () => ({
      error: jest.fn(),
      info: jest.fn(),
      warn: mockLoggerWarn,
      debug: jest.fn(),
    }),
  };
});

import { CUSTOM_MANUAL_SYSTEM_METRIC_SLUG } from "@modular/utils";
import {
  AlertEventStatus,
  AlertMetricProvider,
  AlertOperator,
  AlertStatus,
} from "@prisma/client";
import { of } from "rxjs";

import * as ssrfValidator from "../../common/validators/ssrf-url.validator";

import { AlertsService } from "./alerts.service";

describe("AlertsService.updateEventStatus", () => {
  const buildService = () => {
    const prisma = {
      alertRule: {
        findUnique: jest.fn(),
      },
      alertEvent: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
    } as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 },
      } as any,
      {} as any,
      {} as any,
      [],
    );

    return { prisma, service };
  };

  it("updates alert events to confirmed", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({
      id: "event-1",
      rule: { orgId: "org-1" },
    });
    prisma.alertEvent.update.mockResolvedValue({
      id: "event-1",
      status: AlertEventStatus.confirmed,
      rule: { orgId: "org-1" },
      deliveries: [],
    });

    const result = await service.updateEventStatus(
      "org-1",
      "event-1",
      AlertEventStatus.confirmed,
    );

    expect(prisma.alertEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: { status: AlertEventStatus.confirmed },
      include: { rule: true, deliveries: { include: { channel: true } } },
    });
    expect(result.status).toBe(AlertEventStatus.confirmed);
  });

  it("stores feedback notes in event context", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({
      id: "event-1",
      context: { foo: "bar" },
      rule: { orgId: "org-1" },
    });
    prisma.alertEvent.update.mockResolvedValue({
      id: "event-1",
      status: AlertEventStatus.ignored,
      rule: { orgId: "org-1" },
      deliveries: [],
    });

    await service.updateEventStatus(
      "org-1",
      "event-1",
      AlertEventStatus.ignored,
      "looks safe",
      "user-1",
    );

    expect(prisma.alertEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: {
        status: AlertEventStatus.ignored,
        context: {
          foo: "bar",
          feedback: {
            note: "looks safe",
            updatedById: "user-1",
            status: AlertEventStatus.ignored,
            updatedAt: expect.any(String),
          },
        },
      },
      include: { rule: true, deliveries: { include: { channel: true } } },
    });
  });

  it("rejects unsupported statuses", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({
      id: "event-1",
      rule: { orgId: "org-1" },
    });

    await expect(
      service.updateEventStatus("org-1", "event-1", AlertEventStatus.pending),
    ).rejects.toThrow("Unsupported alert event status update");
  });

  it("normalizes rule metric slug in updated event response", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({
      id: "event-1",
      rule: { orgId: "org-1" },
    });
    prisma.alertEvent.update.mockResolvedValue({
      id: "event-1",
      status: AlertEventStatus.confirmed,
      rule: { orgId: "org-1", metricSlug: "  crawl_task  " },
      deliveries: [],
    });

    const result = await service.updateEventStatus(
      "org-1",
      "event-1",
      AlertEventStatus.confirmed,
    );

    expect(result.rule?.metricSlug).toBe("crawl_task");
  });
});

describe("AlertsService.getRuleTuningSuggestion", () => {
  const buildService = () => {
    const prisma = {
      alertRule: {
        findUnique: jest.fn(),
      },
      alertEvent: {
        findMany: jest.fn(),
      },
    } as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 },
      } as any,
      {} as any,
      {} as any,
      [],
    );

    return { prisma, service };
  };

  it("suggests raising threshold when ignored < confirmed split exists", async () => {
    const { prisma, service } = buildService();
    prisma.alertRule.findUnique.mockResolvedValue({
      id: "rule-1",
      orgId: "org-1",
      operator: AlertOperator.gt,
      thresholdValue: 100,
    });
    prisma.alertEvent.findMany.mockResolvedValue([
      {
        status: AlertEventStatus.ignored,
        metricValue: 110,
        changePercent: null,
      },
      {
        status: AlertEventStatus.ignored,
        metricValue: 115,
        changePercent: null,
      },
      {
        status: AlertEventStatus.ignored,
        metricValue: 120,
        changePercent: null,
      },
      {
        status: AlertEventStatus.ignored,
        metricValue: 125,
        changePercent: null,
      },
      {
        status: AlertEventStatus.confirmed,
        metricValue: 150,
        changePercent: null,
      },
      {
        status: AlertEventStatus.confirmed,
        metricValue: 160,
        changePercent: null,
      },
    ]);

    const result = await service.getRuleTuningSuggestion("org-1", "rule-1", 30);

    expect(result?.action).toBe("increase_threshold");
    expect(result?.suggestedThresholdValue).toBe(137.5);
  });
});

describe("AlertsService.listEvents", () => {
  const buildService = () => {
    const prisma = {
      alertEvent: {
        findMany: jest.fn(),
      },
    } as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 },
      } as any,
      {} as any,
      {} as any,
      [],
    );

    return { prisma, service };
  };

  it("normalizes legacy opensky metric slug to adsb in query result", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findMany.mockResolvedValue([
      {
        id: "event-1",
        rule: { metricSlug: "  realtime.opensky.military_flights  " },
      },
    ]);

    const result = await service.listEvents("org-1", 50);

    expect(result[0]?.rule?.metricSlug).toBe("realtime.adsb.military_flights");
  });

  it("maps legacy opensky metric slug query parameter to adsb", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.listEvents("org-1", 10, "realtime.opensky.military_flights");

    expect(prisma.alertEvent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          rule: {
            orgId: "org-1",
            metricSlug: "realtime.adsb.military_flights",
          },
        },
      }),
    );
  });

  it("clamps non-positive limit to 1", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findMany.mockResolvedValue([]);

    await service.listEvents("org-1", 0);

    expect(prisma.alertEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
      }),
    );
  });

  it("clamps overly large limit to 500", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findMany.mockResolvedValue([]);

    await service.listEvents("org-1", 50_000);

    expect(prisma.alertEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500,
      }),
    );
  });

  it("falls back to normalized in-memory filtering when exact metric slug lookup misses legacy spaced rows", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "event-legacy",
        rule: { metricSlug: "  crawl_task  " },
      },
    ]);

    const result = await service.listEvents("org-1", 10, "crawl_task");

    expect(prisma.alertEvent.findMany).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("event-legacy");
    expect(result[0]?.rule?.metricSlug).toBe("crawl_task");
  });

  it("merges exact and legacy spaced metric slug rows when exact results are under limit", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findMany
      .mockResolvedValueOnce([
        {
          id: "event-exact",
          triggeredAt: new Date("2026-01-03T00:00:00.000Z"),
          rule: { metricSlug: "crawl_task" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "event-exact",
          triggeredAt: new Date("2026-01-03T00:00:00.000Z"),
          rule: { metricSlug: "crawl_task" },
        },
        {
          id: "event-legacy",
          triggeredAt: new Date("2026-01-04T00:00:00.000Z"),
          rule: { metricSlug: "  crawl_task  " },
        },
      ]);

    const result = await service.listEvents("org-1", 10, "crawl_task");

    expect(prisma.alertEvent.findMany).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("event-legacy");
    expect(result[1]?.id).toBe("event-exact");
    expect(result[0]?.rule?.metricSlug).toBe("crawl_task");
  });

  it("keeps merged metric slug query results ordered by triggeredAt desc", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findMany
      .mockResolvedValueOnce([
        {
          id: "event-exact-old",
          triggeredAt: new Date("2026-01-01T00:00:00.000Z"),
          rule: { metricSlug: "crawl_task" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "event-legacy-new",
          triggeredAt: new Date("2026-01-05T00:00:00.000Z"),
          rule: { metricSlug: "  crawl_task  " },
        },
        {
          id: "event-exact-old",
          triggeredAt: new Date("2026-01-01T00:00:00.000Z"),
          rule: { metricSlug: "crawl_task" },
        },
      ]);

    const result = await service.listEvents("org-1", 10, "crawl_task");

    expect(result.map((entry) => entry.id)).toEqual([
      "event-legacy-new",
      "event-exact-old",
    ]);
  });
});

describe("AlertsService in-app recipients", () => {
  const buildService = () => {
    const prisma = {
      membership: {
        findMany: jest.fn(),
      },
      alertDelivery: {
        create: jest.fn(),
      },
    } as any;
    const notificationThrottle = {
      parseMuteUntilMs: jest.fn().mockReturnValue(null),
      isMutedNow: jest.fn().mockReturnValue(false),
    } as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      notificationThrottle,
      {} as any,
      {
        alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 },
      } as any,
      {} as any,
      {} as any,
      [],
    );

    return { prisma, service, notificationThrottle };
  };

  it("creates in-app deliveries only for recipients with alerts.read", async () => {
    mockLoggerWarn.mockReset();
    const { prisma, service } = buildService();
    prisma.membership.findMany.mockResolvedValue([
      {
        userId: "user-without-alerts",
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
        roles: [],
      },
      {
        userId: "user-with-alerts",
        role: {
          permissions: [],
        },
        roles: [
          {
            role: {
              permissions: [{ permission: { name: "alerts.read" } }],
            },
          },
        ],
      },
    ]);
    prisma.alertDelivery.create.mockImplementation(
      async ({ data }: { data: { targetSnapshot: { userId: string } } }) => ({
        id: `delivery-${data.targetSnapshot.userId}`,
      }),
    );

    const deliveries = await (service as any).createInAppDeliveries(
      {
        id: "rule-1",
        orgId: "org-1",
        metadata: {
          notifyUserIds: ["user-without-alerts", "user-with-alerts"],
        },
      },
      "event-1",
    );

    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          userId: { in: ["user-without-alerts", "user-with-alerts"] },
          isActive: true,
          user: { isActive: true },
          org: { isActive: true },
        }),
      }),
    );
    expect(prisma.alertDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.alertDelivery.create).toHaveBeenCalledWith({
      data: {
        eventId: "event-1",
        channelType: "in_app",
        targetSnapshot: { userId: "user-with-alerts" },
      },
    });
    expect(deliveries).toEqual([
      { id: "delivery-user-with-alerts", userId: "user-with-alerts" },
    ]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        ruleId: "rule-1",
        eventId: "event-1",
        requiredPermission: "alerts.read",
        candidateRecipientCount: 2,
        allowedRecipientCount: 1,
        filteredRecipientCount: 1,
        filteredUserIdSample: ["user-without-alerts"],
        hasMoreFilteredRecipients: false,
      }),
      "Filtered in-app alert recipients without required permission",
    );
  });

  it("does not fall back to the creator when the creator lacks alerts.read", async () => {
    mockLoggerWarn.mockReset();
    const { prisma, service } = buildService();
    prisma.membership.findMany.mockResolvedValue([
      {
        userId: "creator-1",
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
        roles: [],
      },
    ]);

    const deliveries = await (service as any).createInAppDeliveries(
      {
        orgId: "org-1",
        createdById: "creator-1",
        metadata: {},
      },
      "event-1",
    );

    expect(prisma.alertDelivery.create).not.toHaveBeenCalled();
    expect(deliveries).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        eventId: "event-1",
        requiredPermission: "alerts.read",
        candidateRecipientCount: 1,
        allowedRecipientCount: 0,
        filteredRecipientCount: 1,
        filteredUserIdSample: ["creator-1"],
        hasMoreFilteredRecipients: false,
      }),
      "Filtered in-app alert recipients without required permission",
    );
  });

  it("does not log when every resolved recipient can read alerts", async () => {
    mockLoggerWarn.mockReset();
    const { prisma, service } = buildService();
    prisma.membership.findMany.mockResolvedValue([
      {
        userId: "user-with-alerts",
        role: {
          permissions: [{ permission: { name: "alerts.read" } }],
        },
        roles: [],
      },
    ]);
    prisma.alertDelivery.create.mockResolvedValue({ id: "delivery-1" });

    const deliveries = await (service as any).createInAppDeliveries(
      {
        orgId: "org-1",
        metadata: {
          notifyUserIds: ["user-with-alerts"],
        },
      },
      "event-1",
    );

    expect(deliveries).toEqual([{ id: "delivery-1", userId: "user-with-alerts" }]);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("caps filtered recipient samples and ignores missing memberships", async () => {
    mockLoggerWarn.mockReset();
    const { prisma, service } = buildService();
    const deniedUserIds = Array.from({ length: 21 }, (_, index) => `user-${index + 1}`);
    prisma.membership.findMany.mockResolvedValue(
      deniedUserIds.map((userId) => ({
        userId,
        role: {
          permissions: [{ permission: { name: "items.read" } }],
        },
        roles: [],
      })),
    );

    const deliveries = await (service as any).createInAppDeliveries(
      {
        orgId: "org-1",
        metadata: {
          notifyUserIds: [...deniedUserIds, "user-missing"],
        },
      },
      "event-1",
    );

    expect(deliveries).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const payload = mockLoggerWarn.mock.calls[0]?.[0] as {
      candidateRecipientCount: number;
      filteredRecipientCount: number;
      filteredUserIdSample: string[];
      hasMoreFilteredRecipients: boolean;
    };
    expect(payload.candidateRecipientCount).toBe(22);
    expect(payload.filteredRecipientCount).toBe(21);
    expect(payload.filteredUserIdSample).toHaveLength(20);
    expect(payload.filteredUserIdSample).toEqual(deniedUserIds.slice(0, 20));
    expect(payload.hasMoreFilteredRecipients).toBe(true);
  });
});

describe("AlertsService.listRules default crawl quality rules", () => {
  const buildService = () => {
    const createdRules: Array<{ id: string; orgId: string }> = [];
    const prisma = {
      org: {
        findMany: jest.fn().mockResolvedValue([{ id: "org-1" }]),
      },
      alertRule: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        create: jest.fn(async ({ data }: any) => {
          const created = {
            id: data.id,
            orgId: data.orgId,
            checkIntervalSec: data.checkIntervalSec,
            status: data.status,
          };
          createdRules.push(created);
          return created;
        }),
      },
    } as any;
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 },
      } as any,
      queue,
      {} as any,
      [],
    );

    return { prisma, queue, service, createdRules };
  };

  it("creates missing default crawl quality rules and schedules them", async () => {
    const { service, prisma, queue, createdRules } = buildService();

    await service.listRules("org-1");

    expect(createdRules.length).toBeGreaterThanOrEqual(3);
    expect(prisma.alertRule.create).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });

  it("does not recreate crawl defaults when existing slug has surrounding whitespace", async () => {
    const { service, prisma, createdRules } = buildService();
    prisma.alertRule.findMany = jest
      .fn()
      .mockResolvedValueOnce([
        { metricSlug: "  crawl_quality.preflight_failure_rate  " },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.listRules("org-1");

    expect(
      createdRules.some((entry) => entry.id.includes("preflight_failure_rate")),
    ).toBe(false);
  });
});

describe("AlertsService.upsertRule system manual metric", () => {
  const buildService = () => {
    const prisma = {
      economicDataItem: {
        findUnique: jest.fn(),
      },
      alertRule: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: "rule-1",
          orgId: "org-1",
          checkIntervalSec: 300,
          status: AlertStatus.active,
        }),
      },
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) =>
        callback(prisma),
      ),
    } as any;
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    } as any;
    const providers = [
      {
        supports: jest.fn(
          (rule: { metricProvider: AlertMetricProvider }) =>
            rule.metricProvider === AlertMetricProvider.system_metric,
        ),
      },
    ] as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 },
      } as any,
      queue,
      {} as any,
      providers,
    );

    return { prisma, queue, service };
  };

  it("rejects custom.manual rule without metadata.currentValue", async () => {
    const { prisma, service } = buildService();

    await expect(
      service.upsertRule("org-1", {
        name: "Manual metric without value",
        metricProvider: AlertMetricProvider.system_metric,
        metricSlug: CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
        operator: AlertOperator.gte,
        thresholdValue: 1,
        metadata: {},
      }),
    ).rejects.toThrow("custom.manual metric requires metadata.currentValue");

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects custom.manual rule when metadata.currentValue is non-finite", async () => {
    const { prisma, service } = buildService();

    await expect(
      service.upsertRule("org-1", {
        name: "Manual metric with NaN",
        metricProvider: AlertMetricProvider.system_metric,
        metricSlug: CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
        operator: AlertOperator.gte,
        thresholdValue: 1,
        metadata: { currentValue: Number.NaN },
      }),
    ).rejects.toThrow("custom.manual metric requires metadata.currentValue");

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects rules with blank metricSlug after trimming", async () => {
    const { prisma, service } = buildService();

    await expect(
      service.upsertRule("org-1", {
        name: "Blank slug",
        metricProvider: AlertMetricProvider.system_metric,
        metricSlug: "   ",
        operator: AlertOperator.gte,
        thresholdValue: 1,
        metadata: { currentValue: 1 },
      }),
    ).rejects.toThrow("metricSlug is required");

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts custom.manual rule when metadata.currentValue is provided", async () => {
    const { prisma, queue, service } = buildService();

    const created = await service.upsertRule("org-1", {
      name: "Manual metric with value",
      metricProvider: AlertMetricProvider.system_metric,
      metricSlug: CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
      operator: AlertOperator.gte,
      thresholdValue: 1,
      metadata: { currentValue: 123 },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.alertRule.create).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalled();
    expect(created.id).toBe("rule-1");
  });

  it("normalizes metricSlug before persisting", async () => {
    const { prisma, service } = buildService();

    await service.upsertRule("org-1", {
      name: "Manual metric with spaced slug",
      metricProvider: AlertMetricProvider.system_metric,
      metricSlug: `  ${CUSTOM_MANUAL_SYSTEM_METRIC_SLUG}  `,
      operator: AlertOperator.gte,
      thresholdValue: 1,
      metadata: { currentValue: 123 },
    });

    expect(prisma.alertRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metricSlug: CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
        }),
      }),
    );
  });
});

describe("AlertsService channel target validation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const buildService = () => {
    const prisma = {
      alertNotificationChannel: {
        create: jest.fn().mockResolvedValue({
          id: "channel-1",
          type: "webhook",
          target: "https://example.com/webhook",
        }),
      },
    } as any;

    const http = {
      post: jest.fn(),
    } as any;

    const service = new AlertsService(
      prisma,
      {
        normalizeEmailTarget: jest.fn((value: string) =>
          value.trim().toLowerCase(),
        ),
      } as any,
      http,
      {} as any,
      {} as any,
      {
        alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 },
      } as any,
      {} as any,
      {} as any,
      [],
    );

    return { prisma, http, service };
  };

  it("rejects unsafe webhook channel targets on create", async () => {
    const { prisma, service } = buildService();

    await expect(
      service.createChannel("org-1", {
        type: "webhook" as any,
        name: "Unsafe",
        target: "http://127.0.0.1/internal",
      }),
    ).rejects.toThrow("Unsafe webhook target");

    expect(prisma.alertNotificationChannel.create).not.toHaveBeenCalled();
  });

  it("blocks unsafe webhook targets during delivery", async () => {
    const { http, service } = buildService();

    await expect(
      (service as any).sendWebhook(
        "http://127.0.0.1/internal",
        {
          id: "event-1",
          triggeredAt: new Date("2024-01-01T00:00:00.000Z"),
          metricValue: { toString: () => "1" } as any,
          severity: "high",
          ruleId: "rule-1",
          message: null,
        },
        {
          name: "Unsafe rule",
          metricSlug: "crawl_task",
          operator: "gte",
          thresholdValue: null,
          thresholdLower: null,
          thresholdUpper: null,
        },
      ),
    ).rejects.toThrow("Unsafe webhook target");

    expect(http.post).not.toHaveBeenCalled();
  });

  it("pins webhook delivery to the vetted DNS answer and disables redirects", async () => {
    const { http, service } = buildService();
    jest
      .spyOn(ssrfValidator, "resolveValidatedSsrfUrlAsync")
      .mockResolvedValue({
        valid: true,
        hostname: "hooks.example.com",
        addresses: [{ address: "93.184.216.34", family: 4 }],
      });
    http.post.mockReturnValue(of({ data: { ok: true } }));

    await (service as any).sendWebhook(
      "https://hooks.example.com/webhook",
      {
        id: "event-1",
        triggeredAt: new Date("2024-01-01T00:00:00.000Z"),
        metricValue: { toString: () => "1" } as any,
        severity: "high",
        ruleId: "rule-1",
        message: null,
      },
      {
        name: "Pinned rule",
        metricSlug: "crawl_task",
        operator: "gte",
        thresholdValue: null,
        thresholdLower: null,
        thresholdUpper: null,
      },
    );

    expect(http.post).toHaveBeenCalledTimes(1);
    const [, , config] = http.post.mock.calls[0] as [
      string,
      Record<string, unknown>,
      {
        maxRedirects: number;
        httpAgent: { options?: { lookup?: (...args: unknown[]) => void } };
        httpsAgent: { options?: { lookup?: (...args: unknown[]) => void } };
      },
    ];

    expect(config.maxRedirects).toBe(0);
    expect(typeof config.httpAgent.options?.lookup).toBe("function");
    expect(typeof config.httpsAgent.options?.lookup).toBe("function");

    await new Promise<void>((resolve, reject) => {
      config.httpsAgent.options?.lookup?.(
        "hooks.example.com",
        { family: 4 },
        (error: Error | null, address?: string, family?: number) => {
          if (error) {
            reject(error);
            return;
          }
          expect(address).toBe("93.184.216.34");
          expect(family).toBe(4);
          resolve();
        },
      );
    });
  });
});
