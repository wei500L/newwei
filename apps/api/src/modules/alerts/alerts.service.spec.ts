import { AlertEventStatus, AlertOperator } from "@prisma/client";

import { AlertsService } from "./alerts.service";

describe("AlertsService.updateEventStatus", () => {
  const buildService = () => {
    const prisma = {
      alertRule: {
        findUnique: jest.fn()
      },
      alertEvent: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn()
      }
    } as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 } } as any,
      {} as any,
      {} as any,
      []
    );

    return { prisma, service };
  };

  it("updates alert events to confirmed", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({ id: "event-1", rule: { orgId: "org-1" } });
    prisma.alertEvent.update.mockResolvedValue({
      id: "event-1",
      status: AlertEventStatus.confirmed,
      rule: { orgId: "org-1" },
      deliveries: []
    });

    const result = await service.updateEventStatus("org-1", "event-1", AlertEventStatus.confirmed);

    expect(prisma.alertEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: { status: AlertEventStatus.confirmed },
      include: { rule: true, deliveries: { include: { channel: true } } }
    });
    expect(result.status).toBe(AlertEventStatus.confirmed);
  });

  it("stores feedback notes in event context", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({
      id: "event-1",
      context: { foo: "bar" },
      rule: { orgId: "org-1" }
    });
    prisma.alertEvent.update.mockResolvedValue({
      id: "event-1",
      status: AlertEventStatus.ignored,
      rule: { orgId: "org-1" },
      deliveries: []
    });

    await service.updateEventStatus("org-1", "event-1", AlertEventStatus.ignored, "looks safe", "user-1");

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
            updatedAt: expect.any(String)
          }
        }
      },
      include: { rule: true, deliveries: { include: { channel: true } } }
    });
  });

  it("rejects unsupported statuses", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({ id: "event-1", rule: { orgId: "org-1" } });

    await expect(service.updateEventStatus("org-1", "event-1", AlertEventStatus.pending)).rejects.toThrow(
      "Unsupported alert event status update"
    );
  });
});

describe("AlertsService.getRuleTuningSuggestion", () => {
  const buildService = () => {
    const prisma = {
      alertRule: {
        findUnique: jest.fn()
      },
      alertEvent: {
        findMany: jest.fn()
      }
    } as any;

    const service = new AlertsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { alertingConfig: { webhookTimeoutMs: 1000, scanIntervalMs: 1000 } } as any,
      {} as any,
      {} as any,
      []
    );

    return { prisma, service };
  };

  it("suggests raising threshold when ignored < confirmed split exists", async () => {
    const { prisma, service } = buildService();
    prisma.alertRule.findUnique.mockResolvedValue({
      id: "rule-1",
      orgId: "org-1",
      operator: AlertOperator.gt,
      thresholdValue: 100
    });
    prisma.alertEvent.findMany.mockResolvedValue([
      { status: AlertEventStatus.ignored, metricValue: 110, changePercent: null },
      { status: AlertEventStatus.ignored, metricValue: 115, changePercent: null },
      { status: AlertEventStatus.ignored, metricValue: 120, changePercent: null },
      { status: AlertEventStatus.ignored, metricValue: 125, changePercent: null },
      { status: AlertEventStatus.confirmed, metricValue: 150, changePercent: null },
      { status: AlertEventStatus.confirmed, metricValue: 160, changePercent: null }
    ]);

    const result = await service.getRuleTuningSuggestion("org-1", "rule-1", 30);

    expect(result?.action).toBe("increase_threshold");
    expect(result?.suggestedThresholdValue).toBe(137.5);
  });
});
