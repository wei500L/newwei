import { BadRequestException } from "@nestjs/common";

import { DashboardDemoMetricsService } from "./dashboard-demo-metrics.service";

describe("DashboardDemoMetricsService", () => {
  const prismaMock = {} as any;

  beforeEach(() => {
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  describe("refreshDemoMetrics", () => {
    it("rejects refresh in production", async () => {
      process.env.NODE_ENV = "production";
      const service = new DashboardDemoMetricsService(
        prismaMock,
        { akshareConfig: { enabled: false } } as any
      );

      await expect(service.refreshDemoMetrics()).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects refresh when Akshare is enabled", async () => {
      process.env.NODE_ENV = "development";
      const service = new DashboardDemoMetricsService(
        prismaMock,
        { akshareConfig: { enabled: true } } as any
      );

      await expect(service.refreshDemoMetrics()).rejects.toBeInstanceOf(BadRequestException);
    });

    it("runs refresh when Akshare disabled", async () => {
      process.env.NODE_ENV = "development";
      const service = new DashboardDemoMetricsService(
        prismaMock,
        { akshareConfig: { enabled: false } } as any
      );
      (service as any).refreshDemoMetricsInternal = jest.fn().mockResolvedValue(undefined);

      await expect(service.refreshDemoMetrics()).resolves.toBe(true);
      expect((service as any).refreshDemoMetricsInternal).toHaveBeenCalledTimes(1);
    });
  });
});

