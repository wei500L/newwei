import { CUSTOM_MANUAL_SYSTEM_METRIC_SLUG } from "@modular/utils";
import { AlertMetricProvider } from "@prisma/client";

import { SystemMetricProvider } from "./system-metric.provider";

describe("SystemMetricProvider", () => {
  const buildProvider = () =>
    new SystemMetricProvider(
      {
        get: jest.fn(),
      } as any,
    );

  it("uses metadata.currentValue when it is a finite number", async () => {
    const provider = buildProvider();

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.system_metric,
      metricSlug: CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: { currentValue: 42 },
    });

    expect(result.latest).toBe(42);
    expect(result.context).toEqual({ source: "metadata" });
  });

  it("returns explicit custom manual error when currentValue is missing", async () => {
    const provider = buildProvider();

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.system_metric,
      metricSlug: CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(result.latest).toBeNull();
    expect(result.context).toEqual({ error: "custom_manual_requires_current_value" });
  });

  it("treats non-finite metadata.currentValue as invalid for custom manual metric", async () => {
    const provider = buildProvider();

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.system_metric,
      metricSlug: CUSTOM_MANUAL_SYSTEM_METRIC_SLUG,
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: { currentValue: Number.NaN },
    });

    expect(result.latest).toBeNull();
    expect(result.context).toEqual({ error: "custom_manual_requires_current_value" });
  });

  it("normalizes custom.manual slug before evaluation", async () => {
    const provider = buildProvider();

    const result = await provider.fetch({
      orgId: "org-1",
      metricProvider: AlertMetricProvider.system_metric,
      metricSlug: `  ${CUSTOM_MANUAL_SYSTEM_METRIC_SLUG}  `,
      operator: "gte" as any,
      changeWindowMin: 60,
      metadata: {},
    });

    expect(result.latest).toBeNull();
    expect(result.context).toEqual({ error: "custom_manual_requires_current_value" });
  });
});
