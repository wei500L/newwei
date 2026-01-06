import { AlertEventStatus } from "@prisma/client";

import { AlertsService } from "./alerts.service";

describe("AlertsService.updateEventStatus", () => {
  const buildService = () => {
    const prisma = {
      alertEvent: {
        findUnique: jest.fn(),
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

  it("rejects unsupported statuses", async () => {
    const { prisma, service } = buildService();
    prisma.alertEvent.findUnique.mockResolvedValue({ id: "event-1", rule: { orgId: "org-1" } });

    await expect(service.updateEventStatus("org-1", "event-1", AlertEventStatus.pending)).rejects.toThrow(
      "Unsupported alert event status update"
    );
  });
});
